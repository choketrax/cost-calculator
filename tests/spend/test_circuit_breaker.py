"""
Tests for circuit breaker evaluation logic in the policy engine.
Tests multi-condition composite tripping: cost anomaly + failures + quality.
"""
from __future__ import annotations

import pytest
from datetime import datetime, timezone
from decimal import Decimal

from core.spend.policy_engine import PolicyEngine, PolicyConfig, PolicyContext


engine = PolicyEngine()


def _base_policy(**overrides) -> PolicyConfig:
    defaults = dict(
        policy_id="cb-policy-001",
        scope="agent",
        scope_id="billing-agent",
        period="monthly",
        budget_usd=Decimal("2000"),
        warning_percent=75.0,
        block_percent=100.0,
        max_retries=3,
        fallback_model="gpt-4o-mini",
        max_context_tokens=100_000,
        min_success_rate=0.85,
        min_cache_pct=0.10,
        max_review_minutes=30.0,
        allowed_hours=None,
        expensive_models=["gpt-4o"],
        enforcement_mode="enforce",
        enabled_rules=[],
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    defaults.update(overrides)
    return PolicyConfig(**defaults)


def _base_context(policy: PolicyConfig, **overrides) -> PolicyContext:
    defaults = dict(
        policy=policy,
        request_hash="req-001",
        model="gpt-4o-mini",
        input_tokens=2000,
        output_tokens=600,
        retry_count=0,
        tool_failure_count=0,
        customer_id="cust-001",
        project_id="proj-001",
        agent_id="billing-agent",
        user_id="user-001",
        request_hour_utc=10,
        period_spent_usd=Decimal("500"),
        daily_spent_usd=Decimal("20"),
        rolling_7d_daily_avg_usd=Decimal("20"),
        rolling_30d_episode_cost_baseline=Decimal("1.00"),
        current_episode_cost=Decimal("0.80"),
        consecutive_failures=0,
        rolling_30d_success_rate=0.95,
        cache_hit_rate=0.30,
        recent_request_hashes=[],
        user_30d_daily_avg_usd=Decimal("5"),
        user_today_usd=Decimal("4"),
        customer_revenue_period=Decimal("1000"),
        customer_cost_period=Decimal("500"),
        last_human_review_minutes=5.0,
    )
    defaults.update(overrides)
    return PolicyContext(**defaults)


class TestCircuitBreakerCompositeConditions:
    def test_daily_spike_triggers_cost_anomaly(self):
        """A 5x daily spike should trigger DAILY_SPIKE."""
        policy = _base_policy()
        ctx = _base_context(
            policy,
            daily_spent_usd=Decimal("100"),
            rolling_7d_daily_avg_usd=Decimal("20"),
        )
        decision = engine.evaluate(ctx)
        assert "DAILY_SPIKE" in decision.triggered_rules

    def test_repeated_tool_failures_triggers_pause(self):
        """3+ consecutive tool failures -> REPEATED_TOOL_FAILURES -> pause."""
        policy = _base_policy()
        ctx = _base_context(policy, tool_failure_count=3)
        decision = engine.evaluate(ctx)
        assert "REPEATED_TOOL_FAILURES" in decision.triggered_rules
        assert decision.action == "pause"

    def test_budget_exceeded_plus_failures_both_trigger(self):
        """Budget exceeded AND tool failures both fire — pause wins."""
        policy = _base_policy()
        ctx = _base_context(
            policy,
            period_spent_usd=Decimal("2000"),  # 100% -> MONTHLY_BUDGET_EXCEEDED
            tool_failure_count=3,              # -> REPEATED_TOOL_FAILURES
        )
        decision = engine.evaluate(ctx)
        assert "MONTHLY_BUDGET_EXCEEDED" in decision.triggered_rules
        assert "REPEATED_TOOL_FAILURES" in decision.triggered_rules
        assert decision.action == "pause"

    def test_low_quality_route_is_alert_without_fallback(self):
        """Low success rate without a fallback model -> alert, not route."""
        policy = _base_policy(fallback_model=None)
        ctx = _base_context(policy, rolling_30d_success_rate=0.70)
        decision = engine.evaluate(ctx)
        assert "LOW_SUCCESS_RATE" in decision.triggered_rules
        # No fallback means route downgrades to alert
        assert decision.action == "alert"

    def test_observe_mode_all_conditions_only_alerts(self):
        """In observe mode, even the most severe composite should only alert."""
        policy = _base_policy(enforcement_mode="observe")
        ctx = _base_context(
            policy,
            period_spent_usd=Decimal("2000"),  # EXCEEDED -> pause
            tool_failure_count=3,              # FAILURES -> pause
            daily_spent_usd=Decimal("100"),    # SPIKE -> alert
        )
        decision = engine.evaluate(ctx)
        assert decision.enforcement_mode == "observe"
        assert decision.action == "alert"   # observe caps at alert

    def test_five_triggers_collected_in_evidence(self):
        """Multiple rules fire and all are in triggered_rules list."""
        policy = _base_policy()
        ctx = _base_context(
            policy,
            period_spent_usd=Decimal("1500"),   # WARNING (75% of $2000 budget)
            customer_id=None,
            project_id=None,                    # MISSING_ATTRIBUTION
            rolling_30d_success_rate=0.70,      # LOW_SUCCESS_RATE
            retry_count=5,                      # TOO_MANY_RETRIES
        )
        decision = engine.evaluate(ctx)
        assert len(decision.triggered_rules) >= 3
        assert "MONTHLY_BUDGET_WARNING" in decision.triggered_rules
        assert "MISSING_ATTRIBUTION" in decision.triggered_rules

    def test_decision_evidence_non_empty(self):
        """PolicyDecision.evidence must contain diagnostic data."""
        policy = _base_policy()
        ctx = _base_context(policy, period_spent_usd=Decimal("1000"))
        decision = engine.evaluate(ctx)
        assert isinstance(decision.evidence, dict)
        assert len(decision.evidence) > 0


class TestRuleDisabling:
    def test_disabled_rule_not_triggered(self):
        """If a rule is disabled in policy, it should never fire."""
        policy = _base_policy(
            enabled_rules=["MONTHLY_BUDGET_WARNING", "DAILY_SPIKE"]  # only these two
        )
        ctx = _base_context(
            policy,
            # EXCESSIVE_CONTEXT would trigger but rule is not in enabled_rules
            input_tokens=200_000,
        )
        decision = engine.evaluate(ctx)
        # If enabled_rules is set, only those rules run
        for rule in decision.triggered_rules:
            assert rule in ["MONTHLY_BUDGET_WARNING", "DAILY_SPIKE"]
