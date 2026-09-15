"""
SCP Telemetry Settlement endpoint.
AgentGateway mirrors actual usage (real token counts, cost, latency) here after every call.
SCP closes the budget reservation and writes the final UsageRecord to D1.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from core.models import TelemetrySettleRequest, UsageRecord

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/telemetry", tags=["telemetry"])


@router.post("/settle")
async def settle_usage(body: TelemetrySettleRequest, request: Request):
    """
    AgentGateway calls this after every LLM/MCP request (fire-and-forget).
    Writes a UsageRecord and updates the rolling budget ledger in D1.
    Always returns 200 -- telemetry is best-effort.
    """
    repo = request.app.state.repo
    now = datetime.now(timezone.utc)

    def to_decimal(val) -> Decimal:
        try:
            return Decimal(str(val)) if val is not None else Decimal("0")
        except InvalidOperation:
            return Decimal("0")

    actual_cost = to_decimal(body.actual_cost_usd or body.mcp_tool_cost_usd)

    try:
        record = UsageRecord(
            audit_id="agw-live",
            import_source="agentgateway",
            **{
                "ServiceProviderName": "agentgateway",
                "ServiceName": "MCP" if body.mcp_tool_name else "LLM",
                "ResourceName": body.model or f"{body.mcp_server_name}/{body.mcp_tool_name}",
                "ChargePeriodStart": now,
                "ChargePeriodEnd": now,
                "ai.model": body.model or "",
                "ai.input_tokens": body.actual_input_tokens,
                "ai.output_tokens": body.actual_output_tokens,
                "ai.latency_ms": body.latency_ms,
                "ai.request_id": body.request_id,
                "ai.status": body.status,
                "EffectiveCost": actual_cost,
                "BilledCost": actual_cost,
                "ListCost": actual_cost,
            },
            scp_agent_id=body.agent_id,
            scp_customer_id=body.customer_id,
            scp_project_id=body.project_id,
            scp_task_episode_id=body.episode_id,
            scp_task_status="success" if body.status == "success" else "failure",
            scp_policy_action="allow",
            agw_request_id=body.request_id,
            agw_reservation_id=body.reservation_id,
            mcp_server_name=body.mcp_server_name,
            mcp_tool_name=body.mcp_tool_name,
            mcp_execution_ms=body.mcp_execution_ms,
            mcp_tool_cost_usd=to_decimal(body.mcp_tool_cost_usd) if body.mcp_tool_cost_usd else None,
        )
        await repo.save_records([record])
    except Exception as exc:
        logger.error("Failed to save telemetry record: %s", exc, exc_info=True)

    try:
        scope_id = body.agent_id or body.customer_id or body.project_id or "global"
        period = now.strftime("%Y-%m")
        cost_str = str(actual_cost)
        await repo.execute_raw("""
            INSERT INTO scp_budget_ledger
                (scope_id, period, period_spent_usd, daily_spent_usd, last_updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(scope_id, period) DO UPDATE SET
                period_spent_usd = period_spent_usd + excluded.period_spent_usd,
                daily_spent_usd  = daily_spent_usd  + excluded.daily_spent_usd,
                last_updated_at  = excluded.last_updated_at
        """, [scope_id, period, cost_str, cost_str, now.isoformat()])
    except Exception as exc:
        logger.error("Failed to update budget ledger: %s", exc, exc_info=True)

    return JSONResponse({"status": "ok", "reservation_id": body.reservation_id})
