"""Simulations routes — run Monte Carlo and replay."""
from __future__ import annotations

import logging
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import require_api_key
from ..schemas import SimulateRequest

logger = logging.getLogger(__name__)
router = APIRouter(tags=["simulations"], dependencies=[Depends(require_api_key)])


@router.post("/audits/{audit_id}/simulate")
async def run_simulation(audit_id: str, body: SimulateRequest, request: Request):
    repo = request.app.state.repo
    registry = request.app.state.pricing_registry

    audit = await repo.get_audit(audit_id)
    if not audit:
        raise HTTPException(404, f"Audit '{audit_id}' not found")

    # Use audit baseline if not overridden
    baseline_cost = body.baseline_monthly_cost or audit.baseline_monthly_cost
    if baseline_cost <= 0:
        raise HTTPException(
            422,
            "Baseline cost is zero. Ingest data before running simulation.",
        )

    # Build pricing info from registry for default scenario
    pricing_info = body.pricing_info or {}
    if not pricing_info:
        # Auto-detect pricing from the audit's most common model
        records = await repo.get_all_records(audit_id)
        if records:
            from collections import Counter
            models = Counter((r.provider, r.model) for r in records)
            top_provider, top_model = models.most_common(1)[0][0]
            price_entry = registry.get_price(top_provider, top_model)
            if price_entry:
                pricing_info = {
                    "baseline_input_price": float(price_entry.input_token_price),
                    "baseline_output_price": float(price_entry.output_token_price),
                    "opt_input_price": float(price_entry.input_token_price),
                    "opt_output_price": float(price_entry.output_token_price),
                    "opt_cached_price": float(price_entry.cached_input_price),
                    "cheap_model_input_price": float(price_entry.input_token_price) * 0.1,
                    "cheap_model_output_price": float(price_entry.output_token_price) * 0.1,
                }

    from core.montecarlo.engine import MonteCarloEngine
    from core.montecarlo.manifest import hash_dict

    engine = MonteCarloEngine(registry)

    # Create input and scenario hashes
    input_hash = hash_dict({"audit_id": audit_id, "baseline": str(baseline_cost)})
    scenario_hash = hash_dict(
        {
            "specs": [s.model_dump() for s in body.distribution_specs],
            "pricing_info": pricing_info,
        }
    )

    result = engine.run(
        audit_id=audit_id,
        seed=body.seed,
        distribution_specs=body.distribution_specs,
        baseline_monthly_cost=baseline_cost,
        pricing_dataset_version=registry.current_version(),
        input_hash=input_hash,
        scenario_hash=scenario_hash,
        pricing_info=pricing_info,
        n_iterations=body.n_iterations,
        savings_target=body.savings_target,
        implementation_cost=body.implementation_cost,
    )

    # Serialize result and save
    result_json = result.model_dump_json()
    await repo.save_simulation(result.manifest, result_json)

    logger.info(
        f"Simulation {result.manifest.simulation_id} for audit {audit_id}: "
        f"P50 monthly savings = ${result.monthly_savings_stats.p50:.2f}"
    )

    return {"status": "ok", "data": result.model_dump(mode="json")}


@router.get("/audits/{audit_id}/simulations")
async def list_simulations(audit_id: str, request: Request):
    repo = request.app.state.repo
    audit = await repo.get_audit(audit_id)
    if not audit:
        raise HTTPException(404, f"Audit '{audit_id}' not found")

    manifests = await repo.list_simulations(audit_id)
    return {
        "status": "ok",
        "data": [m.model_dump(mode="json") for m in manifests],
        "meta": {"count": len(manifests)},
    }


@router.get("/audits/{audit_id}/simulations/{simulation_id}")
async def get_simulation(audit_id: str, simulation_id: str, request: Request):
    repo = request.app.state.repo
    result = await repo.get_simulation(simulation_id)
    if not result:
        raise HTTPException(404, f"Simulation '{simulation_id}' not found")

    manifest, result_json = result
    if manifest.audit_id != audit_id:
        raise HTTPException(404, f"Simulation '{simulation_id}' not found in audit '{audit_id}'")

    import json
    result_data = json.loads(result_json)
    return {"status": "ok", "data": result_data}


@router.post("/audits/{audit_id}/simulations/{simulation_id}/replay")
async def replay_simulation(audit_id: str, simulation_id: str, request: Request):
    """Re-run simulation from manifest and verify hash matches original."""
    repo = request.app.state.repo
    registry = request.app.state.pricing_registry

    result = await repo.get_simulation(simulation_id)
    if not result:
        raise HTTPException(404, f"Simulation '{simulation_id}' not found")

    manifest, original_result_json = result
    if manifest.audit_id != audit_id:
        raise HTTPException(404, f"Simulation not found in audit '{audit_id}'")

    # Get baseline from audit
    audit = await repo.get_audit(audit_id)
    if not audit:
        raise HTTPException(404, f"Audit '{audit_id}' not found")

    from core.montecarlo.engine import MonteCarloEngine
    engine = MonteCarloEngine(registry)

    try:
        replayed = engine.replay(
            manifest=manifest,
            baseline_monthly_cost=audit.baseline_monthly_cost,
        )
    except ValueError as e:
        raise HTTPException(409, f"Replay verification failed: {e}")

    return {
        "status": "ok",
        "data": {
            "simulation_id": simulation_id,
            "verified": True,
            "results_hash": manifest.results_hash,
            "p50_monthly_savings": replayed.monthly_savings_stats.p50,
        },
    }
