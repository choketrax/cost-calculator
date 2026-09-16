"""
SCP External Authorization (ExtAuthz) endpoints.

AgentGateway calls these endpoints synchronously before routing each LLM or
MCP request. Responses must be fast (< 50ms target).

Response semantics AgentGateway expects:
  HTTP 200 -> allow or route (forward the request)
  HTTP 403 -> block (return 403 to the agent, do not forward)
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, HTTPException, Request

from core.models import (
    AuthzRequest,
    AuthzResponse,
    MCPAuthzRequest,
    MCPAuthzResponse,
)
from core.spend.policy_engine import PolicyEngine, PolicyConfig, PolicyContext

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/authz", tags=["authz"])

# ---------------------------------------------------------------------------
# MCP tool cost table -- per-call estimates (USD)
# ---------------------------------------------------------------------------
MCP_TOOL_COSTS: dict[str, dict[str, Decimal]] = {
    "postgres": {
        "query_database":       Decimal("0.002"),
        "execute_sql":          Decimal("0.005"),
        "list_tables":          Decimal("0.001"),
        "*":                    Decimal("0.002"),
    },
    "filesystem": {
        "read_file":            Decimal("0.0005"),
        "write_file":           Decimal("0.001"),
        "list_directory":       Decimal("0.0005"),
        "*":                    Decimal("0.001"),
    },
    "web-search": {
        "search":               Decimal("0.005"),
        "fetch_url":            Decimal("0.003"),
        "*":                    Decimal("0.005"),
    },
    "*": {"*": Decimal("0.002")},
}


def _mcp_cost(server: str, tool: str) -> Decimal:
    server_table = MCP_TOOL_COSTS.get(server, MCP_TOOL_COSTS["*"])
    return server_table.get(tool, server_table.get("*", Decimal("0.002")))


async def _load_active_policy(db, agent_id, customer_id, project_id):
    try:
        result = await db.execute_raw("""
            SELECT * FROM scp_policies
            WHERE (scope_id IN (?, ?, ?) OR scope = 'global')
              AND (expires_at IS NULL OR expires_at > ?)
            ORDER BY CASE scope
                WHEN 'agent'    THEN 1
                WHEN 'project'  THEN 2
                WHEN 'customer' THEN 3
                ELSE            4
            END
            LIMIT 1
        """, [
            agent_id or "",
            project_id or "",
            customer_id or "",
            datetime.now(timezone.utc).isoformat(),
        ])
        rows = result.get("results", [])
        return rows[0] if rows else None
    except Exception as exc:
        logger.warning("Policy lookup failed (defaulting to allow): %s", exc)
        return None


async def _load_ledger(db, scope_id: str, period: str) -> dict:
    try:
        result = await db.execute_raw("""
            SELECT period_spent_usd, daily_spent_usd,
                   rolling_7d_daily_avg_usd, consecutive_failures,
                   rolling_30d_success_rate, cache_hit_rate
            FROM scp_budget_ledger
            WHERE scope_id = ? AND period = ?
        """, [scope_id, period])
        rows = result.get("results", [])
        if rows:
            return dict(rows[0])
    except Exception as exc:
        logger.warning("Ledger lookup failed (defaulting zeros): %s", exc)
    return {
        "period_spent_usd": 0, "daily_spent_usd": 0,
        "rolling_7d_daily_avg_usd": 0, "consecutive_failures": 0,
        "rolling_30d_success_rate": 1.0, "cache_hit_rate": 0.1,
    }


def _default_policy() -> PolicyConfig:
    now = datetime.now(timezone.utc)
    return PolicyConfig(
        policy_id="default", scope="global", scope_id="*",
        period="monthly", budget_usd=Decimal("9999"),
        enforcement_mode="observe", created_at=now, updated_at=now,
    )


@router.post("/evaluate", response_model=AuthzResponse)
async def evaluate_llm_authz(body: AuthzRequest, request: Request):
    logger.info("ExtAuthz LLM Evaluation for request %s", request.headers.get("x-agw-request-id"))
    db = request.app.state.repo
    scope_id = body.agent_id or body.customer_id or body.project_id or "global"
    period = datetime.now(timezone.utc).strftime("%Y-%m")

    # 1. Fetch BYOK key from vault if customer_id exists
    client_key = None
    if body.customer_id:
        try:
            vault_result = await db.execute_raw(
                "SELECT api_key FROM scp_client_vault WHERE client_id = ? AND provider_name = ?",
                [body.customer_id, "openai"]
            )
            rows = vault_result.get("results", [])
            if rows:
                client_key = rows[0].get("api_key")
                logger.info("Found BYOK key in vault for customer %s", body.customer_id)
        except Exception as e:
            logger.warning("Failed to query client vault: %s", e)

    upstream_headers = {}
    if client_key:
        upstream_headers["Authorization"] = f"Bearer {client_key}"

    policy_row = await _load_active_policy(db, body.agent_id, body.customer_id, body.project_id)
    ledger = await _load_ledger(db, scope_id, period)

    if policy_row:
        try:
            policy = PolicyConfig(
                policy_id=policy_row.get("policy_id", "default"),
                scope=policy_row.get("scope", "global"),
                scope_id=policy_row.get("scope_id", "*"),
                period=policy_row.get("period", "monthly"),
                budget_usd=Decimal(str(policy_row.get("budget_usd", "9999"))),
                warning_percent=float(policy_row.get("warning_percent", 75.0)),
                block_percent=float(policy_row.get("block_percent", 100.0)),
                max_retries=int(policy_row.get("max_retries", 3)),
                fallback_model=policy_row.get("fallback_model"),
                max_context_tokens=int(policy_row.get("max_context_tokens", 100_000)),
                min_success_rate=float(policy_row.get("min_success_rate", 0.85)),
                min_cache_pct=float(policy_row.get("min_cache_pct", 0.10)),
                max_review_minutes=float(policy_row.get("max_review_minutes", 30.0)),
                enforcement_mode=policy_row.get("enforcement_mode", "observe"),
                enabled_rules=[],
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
            )
        except Exception:
            policy = _default_policy()
    else:
        policy = _default_policy()

    ctx = PolicyContext(
        policy=policy,
        request_hash=body.request_hash,
        model=body.model,
        input_tokens=body.estimated_input_tokens,
        output_tokens=0,
        retry_count=0,
        tool_failure_count=0,
        customer_id=body.customer_id,
        project_id=body.project_id,
        agent_id=body.agent_id,
        user_id=body.user_id,
        request_hour_utc=datetime.now(timezone.utc).hour,
        period_spent_usd=Decimal(str(ledger.get("period_spent_usd", 0))),
        daily_spent_usd=Decimal(str(ledger.get("daily_spent_usd", 0))),
        rolling_7d_daily_avg_usd=Decimal(str(ledger.get("rolling_7d_daily_avg_usd", 0))),
        rolling_30d_episode_cost_baseline=Decimal("5.00"),
        current_episode_cost=Decimal("0.00"),
        consecutive_failures=int(ledger.get("consecutive_failures", 0)),
        rolling_30d_success_rate=float(ledger.get("rolling_30d_success_rate", 1.0)),
        cache_hit_rate=float(ledger.get("cache_hit_rate", 0.1)),
        recent_request_hashes=[],
        user_30d_daily_avg_usd=Decimal("1.00"),
        user_today_usd=Decimal("0.00"),
        customer_revenue_period=Decimal("0.00"),
        customer_cost_period=Decimal(str(ledger.get("period_spent_usd", 0))),
        last_human_review_minutes=0.0,
    )

    engine = PolicyEngine()
    decision = engine.evaluate(ctx)
    reservation_id = str(uuid.uuid4())

    if decision.action == "pause":
        raise HTTPException(status_code=403, detail={
            "status": "block",
            "error": {
                "code": "BUDGET_EXCEEDED",
                "message": decision.reason,
                "policy_id": policy.policy_id,
                "triggered_rules": decision.triggered_rules,
            },
        })

    if decision.action == "route" and policy.fallback_model:
        return AuthzResponse(
            status="route",
            model_override=policy.fallback_model,
            reservation_id=reservation_id,
            policy_id=policy.policy_id,
            triggered_rules=decision.triggered_rules,
            upstream_headers=upstream_headers if upstream_headers else None,
        )

    return AuthzResponse(
        status="allow",
        model_override=None,
        reservation_id=reservation_id,
        policy_id=policy.policy_id,
        triggered_rules=decision.triggered_rules,
        upstream_headers=upstream_headers if upstream_headers else None,
    )


@router.post("/mcp-evaluate", response_model=MCPAuthzResponse)
async def evaluate_mcp_authz(body: MCPAuthzRequest, request: Request):
    repo = request.app.state.repo
    scope_id = body.agent_id or body.customer_id or body.project_id or "global"
    period = datetime.now(timezone.utc).strftime("%Y-%m")

    policy_row = await _load_active_policy(repo, body.agent_id, body.customer_id, body.project_id)
    ledger = await _load_ledger(repo, scope_id, period)

    period_spent = Decimal(str(ledger.get("period_spent_usd", 0)))
    budget = Decimal(str(policy_row.get("budget_usd", "9999"))) if policy_row else Decimal("9999")
    block_pct = float(policy_row.get("block_percent", 100.0)) if policy_row else 100.0
    enforcement = policy_row.get("enforcement_mode", "observe") if policy_row else "observe"
    tool_cost = _mcp_cost(body.mcp_server_name, body.mcp_tool_name)

    if enforcement == "enforce" and period_spent >= (budget * Decimal(str(block_pct)) / 100):
        raise HTTPException(status_code=403, detail={
            "status": "block",
            "error": {
                "code": "BUDGET_EXCEEDED",
                "message": f"Period budget of \ exhausted",
                "policy_id": policy_row.get("policy_id") if policy_row else None,
            },
        })

    reservation_id = str(uuid.uuid4())
    return MCPAuthzResponse(
        status="allow",
        tool_cost_estimate_usd=str(tool_cost),
        reservation_id=reservation_id,
        policy_id=policy_row.get("policy_id") if policy_row else None,
    )
