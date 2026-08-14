"""Scenarios routes — apply scenario parameters and compute projected costs."""
from __future__ import annotations

import logging
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import require_api_key
from ..schemas import CreateScenarioRequest

logger = logging.getLogger(__name__)
router = APIRouter(tags=["scenarios"], dependencies=[Depends(require_api_key)])


@router.post("/audits/{audit_id}/scenarios")
async def run_scenario(audit_id: str, body: CreateScenarioRequest, request: Request):
    repo = request.app.state.repo
    registry = request.app.state.pricing_registry

    audit = await repo.get_audit(audit_id)
    if not audit:
        raise HTTPException(404, f"Audit '{audit_id}' not found")

    records = await repo.get_all_records(audit_id)
    if not records:
        raise HTTPException(422, "No records found. Ingest data first.")

    # Build ScenarioParameters from request
    from core.models import ScenarioParameters
    params = ScenarioParameters(
        name=body.name,
        description=body.description,
        model_overrides=body.model_overrides,
        model_allocation=body.model_allocation,
        request_volume_multiplier=body.request_volume_multiplier,
        input_token_multiplier=body.input_token_multiplier,
        output_token_multiplier=body.output_token_multiplier,
        cache_hit_rate=body.cache_hit_rate,
        context_reduction_factor=body.context_reduction_factor,
        retry_rate_target=body.retry_rate_target,
        failure_rate_target=body.failure_rate_target,
        price_overrides=body.price_overrides,
        depends_on=body.depends_on,
    )

    # Run scenario engine
    from core.scenario.engine import ScenarioEngine
    engine = ScenarioEngine(registry)
    scenario_result = engine.apply(records=records, params=params, audit_id=audit_id)

    logger.info(
        f"Scenario '{body.name}' for audit {audit_id}: "
        f"baseline=${scenario_result.baseline_cost:.2f}, "
        f"projected=${scenario_result.projected_cost:.2f}, "
        f"savings=${scenario_result.net_savings:.2f}"
    )

    return {
        "status": "ok",
        "data": scenario_result.model_dump(mode="json"),
    }
