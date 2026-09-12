import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Literal, Optional

from pydantic import BaseModel
from core.models import PolicyDecision

class PolicyConfig(BaseModel):
    policy_id: str
    scope: Literal["agent","project","customer","global"]
    scope_id: str
    period: Literal["daily","monthly"]
    budget_usd: Decimal
    warning_percent: float = 75.0
    block_percent: float = 100.0
    max_retries: int = 3
    fallback_model: Optional[str] = None
    max_context_tokens: int = 100_000
    min_success_rate: float = 0.85
    min_cache_pct: float = 0.10
    max_review_minutes: float = 30.0
    allowed_hours: Optional[tuple[int,int]] = None  # (start_hour, end_hour) UTC 24h
    expensive_models: list[str] = ["gpt-4o","claude-opus-4-5","gemini-ultra"]
    enforcement_mode: Literal["observe","enforce"] = "observe"
    enabled_rules: list[str] = []  # empty = all rules enabled
    created_at: datetime
    updated_at: datetime

@dataclass
class PolicyContext:
    policy: PolicyConfig
    # Current request
    request_hash: Optional[str]
    model: str
    input_tokens: int
    output_tokens: int
    retry_count: int
    tool_failure_count: int
    customer_id: Optional[str]
    project_id: Optional[str]
    agent_id: Optional[str]
    user_id: Optional[str]
    request_hour_utc: int  # 0-23
    # Ledger data (fetched from D1 before calling engine)
    period_spent_usd: Decimal
    daily_spent_usd: Decimal
    rolling_7d_daily_avg_usd: Decimal
    rolling_30d_episode_cost_baseline: Decimal
    current_episode_cost: Decimal
    consecutive_failures: int
    rolling_30d_success_rate: float
    cache_hit_rate: float
    recent_request_hashes: list[str]  # last 60s
    user_30d_daily_avg_usd: Decimal
    user_today_usd: Decimal
    customer_revenue_period: Decimal
    customer_cost_period: Decimal
    last_human_review_minutes: float

class PolicyEngine:
    """
    Deterministic Policy Engine. Evaluates rules based on context and produces a PolicyDecision.
    """
    def evaluate(self, ctx: PolicyContext) -> PolicyDecision:
        triggered_rules = []
        highest_action = "allow"
        primary_rule_id = None
        
        # Mapping rules to actions based on priority: pause > route > alert > allow
        action_priority = {"pause": 4, "route": 3, "alert": 2, "allow": 1}
        
        def process_rule(rule_id: str, action: str):
            nonlocal highest_action, primary_rule_id
            if ctx.policy.enabled_rules and rule_id not in ctx.policy.enabled_rules:
                return
            triggered_rules.append(rule_id)
            if action_priority[action] > action_priority[highest_action]:
                highest_action = action
                primary_rule_id = rule_id

        # Rules evaluation
        
        # 1. MONTHLY_BUDGET_EXCEEDED
        if self._check_MONTHLY_BUDGET_EXCEEDED(ctx):
            process_rule("MONTHLY_BUDGET_EXCEEDED", "pause")
        # 1.5. MONTHLY_BUDGET_WARNING
        elif self._check_MONTHLY_BUDGET_WARNING(ctx):
            process_rule("MONTHLY_BUDGET_WARNING", "alert")
            
        # 2. DAILY_SPIKE
        if self._check_DAILY_SPIKE(ctx):
            process_rule("DAILY_SPIKE", "alert")

        # 3. COST_PER_TASK_INCREASED
        if self._check_COST_PER_TASK_INCREASED(ctx):
            process_rule("COST_PER_TASK_INCREASED", "alert")
            
        # 4. EXCESSIVE_CONTEXT
        if self._check_EXCESSIVE_CONTEXT(ctx):
            process_rule("EXCESSIVE_CONTEXT", "alert")
            
        # 5. TOO_MANY_RETRIES
        if self._check_TOO_MANY_RETRIES(ctx):
            process_rule("TOO_MANY_RETRIES", "route")
            
        # 6. REPEATED_TOOL_FAILURES
        if self._check_REPEATED_TOOL_FAILURES(ctx):
            process_rule("REPEATED_TOOL_FAILURES", "pause")
            
        # 7. EXPENSIVE_MODEL_SIMPLE_TASK
        if self._check_EXPENSIVE_MODEL_SIMPLE_TASK(ctx):
            process_rule("EXPENSIVE_MODEL_SIMPLE_TASK", "route")
            
        # 8. MISSING_ATTRIBUTION
        if self._check_MISSING_ATTRIBUTION(ctx):
            process_rule("MISSING_ATTRIBUTION", "alert")
            
        # 9. LOW_SUCCESS_RATE
        if self._check_LOW_SUCCESS_RATE(ctx):
            process_rule("LOW_SUCCESS_RATE", "alert")
            
        # 10. NEGATIVE_CLIENT_MARGIN
        if self._check_NEGATIVE_CLIENT_MARGIN(ctx):
            process_rule("NEGATIVE_CLIENT_MARGIN", "alert")
            
        # 11. UNUSUAL_USER_CONSUMPTION
        if self._check_UNUSUAL_USER_CONSUMPTION(ctx):
            process_rule("UNUSUAL_USER_CONSUMPTION", "alert")
            
        # 12. LOW_CACHE_HIT_RATE
        if self._check_LOW_CACHE_HIT_RATE(ctx):
            process_rule("LOW_CACHE_HIT_RATE", "alert")
            
        # 13. DUPLICATE_REQUEST
        if self._check_DUPLICATE_REQUEST(ctx):
            process_rule("DUPLICATE_REQUEST", "route")
            
        # 14. EXCESSIVE_HUMAN_REVIEW
        if self._check_EXCESSIVE_HUMAN_REVIEW(ctx):
            process_rule("EXCESSIVE_HUMAN_REVIEW", "alert")
            
        # 15. OUTSIDE_APPROVED_HOURS
        if self._check_OUTSIDE_APPROVED_HOURS(ctx):
            process_rule("OUTSIDE_APPROVED_HOURS", "pause")

        final_action = highest_action
        model_override = None

        if final_action == "route":
            if ctx.policy.fallback_model:
                model_override = ctx.policy.fallback_model
            else:
                final_action = "alert"

        if ctx.policy.enforcement_mode == "observe":
            if action_priority[final_action] > action_priority["alert"]:
                final_action = "alert"
                model_override = None

        reason = "Request allowed"
        if final_action != "allow" and primary_rule_id:
            reason = f"Triggered by rule {primary_rule_id}"

        return PolicyDecision(
            request_id=str(uuid.uuid4()),
            evaluated_at=datetime.utcnow(),
            action=final_action, # type: ignore
            rule_id=primary_rule_id,
            triggered_rules=triggered_rules,
            reason=reason,
            evidence={
                "period_spent_usd": float(ctx.period_spent_usd),
                "budget_usd": float(ctx.policy.budget_usd),
            },
            model_override=model_override,
            policy_id=ctx.policy.policy_id,
            enforcement_mode=ctx.policy.enforcement_mode
        )

    # --- Rule Checks ---
    def _check_MONTHLY_BUDGET_EXCEEDED(self, ctx: PolicyContext) -> Optional[str]:
        threshold = ctx.policy.budget_usd * Decimal(str(ctx.policy.block_percent / 100))
        if ctx.period_spent_usd >= threshold:
            return "MONTHLY_BUDGET_EXCEEDED"
        return None

    def _check_MONTHLY_BUDGET_WARNING(self, ctx: PolicyContext) -> Optional[str]:
        warn_threshold = ctx.policy.budget_usd * Decimal(str(ctx.policy.warning_percent / 100))
        block_threshold = ctx.policy.budget_usd * Decimal(str(ctx.policy.block_percent / 100))
        if warn_threshold <= ctx.period_spent_usd < block_threshold:
            return "MONTHLY_BUDGET_WARNING"
        return None

    def _check_DAILY_SPIKE(self, ctx: PolicyContext) -> Optional[str]:
        if ctx.daily_spent_usd > Decimal("10.0"):
            if ctx.rolling_7d_daily_avg_usd > Decimal("0.0"):
                ratio = ctx.daily_spent_usd / ctx.rolling_7d_daily_avg_usd
                if ratio > Decimal("3.0"):
                    return "DAILY_SPIKE"
        return None

    def _check_COST_PER_TASK_INCREASED(self, ctx: PolicyContext) -> Optional[str]:
        if ctx.rolling_30d_episode_cost_baseline > Decimal("0.0"):
            if ctx.current_episode_cost > ctx.rolling_30d_episode_cost_baseline * Decimal("1.5"):
                return "COST_PER_TASK_INCREASED"
        return None

    def _check_EXCESSIVE_CONTEXT(self, ctx: PolicyContext) -> Optional[str]:
        if ctx.input_tokens > ctx.policy.max_context_tokens:
            return "EXCESSIVE_CONTEXT"
        return None

    def _check_TOO_MANY_RETRIES(self, ctx: PolicyContext) -> Optional[str]:
        if ctx.retry_count > ctx.policy.max_retries:
            return "TOO_MANY_RETRIES"
        return None

    def _check_REPEATED_TOOL_FAILURES(self, ctx: PolicyContext) -> Optional[str]:
        if ctx.tool_failure_count >= 3:
            return "REPEATED_TOOL_FAILURES"
        return None

    def _check_EXPENSIVE_MODEL_SIMPLE_TASK(self, ctx: PolicyContext) -> Optional[str]:
        if ctx.model in ctx.policy.expensive_models:
            if ctx.output_tokens < 500 and ctx.input_tokens < 2000:
                return "EXPENSIVE_MODEL_SIMPLE_TASK"
        return None

    def _check_MISSING_ATTRIBUTION(self, ctx: PolicyContext) -> Optional[str]:
        if ctx.customer_id is None and ctx.project_id is None:
            return "MISSING_ATTRIBUTION"
        return None

    def _check_LOW_SUCCESS_RATE(self, ctx: PolicyContext) -> Optional[str]:
        if ctx.rolling_30d_success_rate < ctx.policy.min_success_rate:
            return "LOW_SUCCESS_RATE"
        return None

    def _check_NEGATIVE_CLIENT_MARGIN(self, ctx: PolicyContext) -> Optional[str]:
        if ctx.customer_revenue_period > Decimal("0.0") and ctx.customer_revenue_period < ctx.customer_cost_period:
            return "NEGATIVE_CLIENT_MARGIN"
        return None

    def _check_UNUSUAL_USER_CONSUMPTION(self, ctx: PolicyContext) -> Optional[str]:
        if ctx.user_today_usd > Decimal("5.0"):
            if ctx.user_30d_daily_avg_usd > Decimal("0.0"):
                if ctx.user_today_usd > ctx.user_30d_daily_avg_usd * Decimal("5.0"):
                    return "UNUSUAL_USER_CONSUMPTION"
        return None

    def _check_LOW_CACHE_HIT_RATE(self, ctx: PolicyContext) -> Optional[str]:
        if ctx.cache_hit_rate < ctx.policy.min_cache_pct and ctx.input_tokens > 5000:
            return "LOW_CACHE_HIT_RATE"
        return None

    def _check_DUPLICATE_REQUEST(self, ctx: PolicyContext) -> Optional[str]:
        if ctx.request_hash and ctx.request_hash in ctx.recent_request_hashes:
            return "DUPLICATE_REQUEST"
        return None

    def _check_EXCESSIVE_HUMAN_REVIEW(self, ctx: PolicyContext) -> Optional[str]:
        if ctx.last_human_review_minutes > ctx.policy.max_review_minutes:
            return "EXCESSIVE_HUMAN_REVIEW"
        return None

    def _check_OUTSIDE_APPROVED_HOURS(self, ctx: PolicyContext) -> Optional[str]:
        if ctx.policy.allowed_hours is not None:
            start_hour, end_hour = ctx.policy.allowed_hours
            if start_hour <= end_hour:
                if not (start_hour <= ctx.request_hour_utc <= end_hour):
                    return "OUTSIDE_APPROVED_HOURS"
            else:
                # Wrap-around case e.g., 22 to 4
                if not (ctx.request_hour_utc >= start_hour or ctx.request_hour_utc <= end_hour):
                    return "OUTSIDE_APPROVED_HOURS"
        return None
