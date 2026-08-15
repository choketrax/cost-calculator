"""
Model Context Protocol (MCP) Server Entrypoint for AI Cost Auditor.
Exposes the core AI Cost Auditor business logic as local tools.
"""
from __future__ import annotations

import asyncio
import os
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

from core.models import DistributionSpec
from core.montecarlo.engine import MonteCarloEngine
from core.pricing.registry import PricingRegistry
from core.waste.runner import WasteDetectionRunner
from storage.sqlite import SQLiteRepository

# Initialize FastMCP Server
mcp = FastMCP("ai-cost-auditor")

# Storage initialization
# Use a predictable path or read from env
DATA_DIR = Path(os.environ.get("AUDITOR_DATA_DIR", "./data"))
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = DATA_DIR / "auditor.sqlite"

PRICING_PATH = Path(__file__).parent / "pricing" / "data" / "pricing_v1.json"


def get_registry() -> PricingRegistry:
    registry = PricingRegistry(PRICING_PATH)
    registry.load()
    return registry


async def get_repo() -> SQLiteRepository:
    repo = SQLiteRepository(str(DB_PATH))
    await repo.initialize()
    return repo


@mcp.tool()
def get_model_pricing(provider: str, model: str) -> str:
    """
    Retrieve current pricing data for an AI model.

    Args:
        provider: The provider name (e.g., 'openai', 'anthropic').
        model: The model name (e.g., 'gpt-4o', 'claude-3-5-sonnet-20241022').
    """
    registry = get_registry()
    entry = registry.get_price(provider, model)
    if not entry:
        return f"No pricing found for {provider}/{model}"
    
    return (
        f"Pricing for {provider}/{model}:\n"
        f"- Input Tokens: ${entry.input_token_price}/1M\n"
        f"- Output Tokens: ${entry.output_token_price}/1M\n"
        f"- Cached Input Tokens: ${entry.cached_input_price}/1M\n"
        f"- Effective From: {entry.effective_from}"
    )


@mcp.tool()
async def get_audit_summary(audit_id: str) -> str:
    """
    Get a high-level cost summary for a specific audit.

    Args:
        audit_id: The ID of the audit to lookup.
    """
    repo = await get_repo()
    audit = await repo.get_audit(audit_id)
    if not audit:
        return f"Error: Audit '{audit_id}' not found."

    records = await repo.get_all_records(audit_id)
    findings = await repo.get_findings(audit_id)

    return (
        f"Audit Summary: {audit.customer_name} ({audit_id})\n"
        f"Status: {audit.status}\n"
        f"Baseline Monthly Cost: ${audit.baseline_monthly_cost:,.2f}\n"
        f"Total Records Ingested: {audit.total_records}\n"
        f"Findings Detected: {len(findings)}"
    )


@mcp.tool()
async def detect_waste(audit_id: str) -> str:
    """
    Run waste detection heuristics on the audit data and return identified savings.

    Args:
        audit_id: The ID of the audit.
    """
    repo = await get_repo()
    audit = await repo.get_audit(audit_id)
    if not audit:
        return f"Error: Audit '{audit_id}' not found."

    records = await repo.get_all_records(audit_id)
    if not records:
        return "No usage records found. Ingest data first."

    registry = get_registry()
    runner = WasteDetectionRunner(registry)
    
    findings = runner.detect_all(records, audit_id)
    
    # Save findings to database
    for f in findings:
        await repo.save_finding(f)
        
    audit.status = "analyzing"
    await repo.update_audit(audit)

    result = f"Detected {len(findings)} waste findings:\n\n"
    for f in findings:
        result += (
            f"- [{f.severity}] {f.title} ({f.category})\n"
            f"  Potential Savings: ${f.potential_savings_low:,.0f} - ${f.potential_savings_high:,.0f} / mo\n"
            f"  Recommendation: {f.recommendation or f.proposed_change}\n\n"
        )
    return result


@mcp.tool()
async def run_simulation(audit_id: str, savings_target: float) -> str:
    """
    Run a fast Monte Carlo simulation to estimate probabilstic savings distributions.
    
    Args:
        audit_id: The ID of the audit.
        savings_target: The target monthly savings goal to calculate probability against.
    """
    repo = await get_repo()
    audit = await repo.get_audit(audit_id)
    if not audit:
        return f"Error: Audit '{audit_id}' not found."
    if audit.baseline_monthly_cost <= 0:
        return "Error: Baseline cost is zero or unset. Run detection or ingest data first."

    registry = get_registry()
    engine = MonteCarloEngine(registry)

    # Use standard business distributions for prompt caching and retry optimizations
    specs = [
        DistributionSpec(
            variable_name="cache_hit_rate",
            distribution="pert",
            params={"low": 0.0, "mode": 0.20, "high": 0.40},
            description="Estimated cache hit rate after caching implementation",
        ),
        DistributionSpec(
            variable_name="retry_rate",
            distribution="pert",
            params={"low": 0.0, "mode": 0.05, "high": 0.10},
            description="Residual retry rate after implementation",
        ),
    ]

    from core.montecarlo.manifest import hash_dict
    input_hash = hash_dict({"audit_id": audit_id, "baseline": str(audit.baseline_monthly_cost)})
    scenario_hash = hash_dict({"specs": [s.model_dump() for s in specs]})

    # Run the engine
    result = engine.run(
        audit_id=audit_id,
        seed=42,  # Deterministic seed for standard MCP runs
        distribution_specs=specs,
        baseline_monthly_cost=audit.baseline_monthly_cost,
        pricing_dataset_version=registry.current_version(),
        input_hash=input_hash,
        scenario_hash=scenario_hash,
        pricing_info={},
        n_iterations=5000,
        savings_target=Decimal(str(savings_target)),
    )

    # Save simulation results
    await repo.save_simulation(result.manifest, result.model_dump_json())

    stats = result.monthly_savings_stats
    return (
        f"Monte Carlo Simulation Complete (ID: {result.manifest.simulation_id})\n"
        f"Iterations: 5,000\n\n"
        f"--- Monthly Savings Projections ---\n"
        f"Conservative (P10): ${stats.p10:,.2f}\n"
        f"Most Likely (P50):  ${stats.p50:,.2f}\n"
        f"Optimistic (P90):   ${stats.p90:,.2f}\n\n"
        f"Probability of hitting target (${savings_target:,.2f}): {stats.prob_savings_gt_target:.1%}"
    )


def main():
    """Main entrypoint for MCP server execution."""
    mcp.run(transport="stdio")

if __name__ == "__main__":
    main()
