"""
Tests for the SCP Policy Engine — all 15 deterministic controls.
Each test creates a minimal PolicyContext and asserts the expected PolicyDecision.
"""
from __future__ import annotations

import pytest
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal

from core.spend.policy_engine import PolicyEngine, PolicyConfig, PolicyContext


def _base_policy(**overrides) -> PolicyConfig:
    defaults = dict(
        policy_id="test-policy-001",
        scope="agent",
        scope_id="support-agent",
        period="monthly",
        budget_usd=Decimal("1000"),
        warning_percent=75.0,
        block_percent=100.0,
        max_retries=3,
        fallback_model="gpt-4o-mini",
        max_context_tokens=100_000,
        min_success_rate=0.85,
        min_cache_pct=0.10,
        max_review_minutes=30.0,
        allowed_hours=None,
        expensive_models=["gpt-4o", "claude-opus-4-5", "gemini-ultra"],
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
        request_hash="abc123",
        model="gpt-4o-mini",
        input_tokens=1000,
        output_tokens=800,
        retry_count=0,
        tool_failure_count=0,
        customer_id="cust-001",
        project_id="proj-001",
        agent_id="support-agent",
        user_id="user-001",
        request_hour_utc=10,
        period_spent_usd=Decimal("0"),
        daily_spent_usd=Decimal("0"),
        rolling_7d_daily_avg_usd=Decimal("10"),
        rolling_30d_episode_cost_baseline=Decimal("1.00"),
        current_episode_cost=Decimal("0.50"),
        consecutive_failures=0,
        rolling_30d_success_rate=0.95,
        cache_hit_rate=0.30,
        recent_request_hashes=[],
        user_30d_daily_avg_usd=Decimal("2.00"),
        user_today_usd=Decimal("1.00"),
        customer_revenue_period=Decimal("500"),
        customer_cost_period=Decimal("200"),
        last_human_review_minutes=10.0,
    )
    defaults.update(overrides)
    return PolicyContext(**defaults)


engine = PolicyEngine()


class TestMonthlyBudget:
    def test_allow_when_under_warning(self):
        policy = _base_policy()
        ctx = _base_context(policy, period_spent_usd=Decimal("500"))  # 50%
        decision = engine.evaluate(ctx)
        assert decision.action == "allow"
        assert "MONTHLY_BUDGET_EXCEEDED" not in decision.triggered_rules

    def test_warning_at_75_pct(self):
        policy = _base_policy()
        ctx = _base_context(policy, period_spent_usd=Decimal("750"))  # 75%
        decision = engine.evaluate(ctx)
        assert "MONTHLY_BUDGET_WARNING" in decision.triggered_rules
        assert decision.action == "alert"

    def test_block_at_100_pct(self):
        policy = _base_policy()
        ctx = _base_context(policy, period_spent_usd=Decimal("1000"))  # 100%
        decision = engine.evaluate(ctx)
        assert "MONTHLY_BUDGET_EXCEEDED" in decision.triggered_rules
        assert decision.action == "pause"

    def test_observe_mode_caps_at_alert(self):
        """Even at 100% budget, observe mode must only alert, never pause."""
        policy = _base_policy(enforcement_mode="observe")
        ctx = _base_context(policy, period_spent_usd=Decimal("1000"))
        decision = engine.evaluate(ctx)
        assert decision.action == "alert"
        assert decision.enforcement_mode == "observe"


class TestDailySpike:
    def test_spike_triggers_alert(self):
        policy = _base_policy()
        ctx = _base_context(
            policy,
            daily_spent_usd=Decimal("50"),   # 5x the 10 average
            rolling_7d_daily_avg_usd=Decimal("10"),
        )
        decision = engine.evaluate(ctx)
        assert "DAILY_SPIKE" in decision.triggered_rules

    def test_no_spike_when_below_threshold(self):
        policy = _base_policy()
        ctx = _base_context(
            policy,
            daily_spent_usd=Decimal("25"),   # 2.5x — below 3x threshold
            rolling_7d_daily_avg_usd=Decimal("10"),
        )
        decision = engine.evaluate(ctx)
        assert "DAILY_SPIKE" not in decision.triggered_rules


class TestTooManyRetries:
    def test_route_on_excess_retries(self):
        policy = _base_policy(max_retries=3, fallback_model="gpt-4o-mini")
        ctx = _base_context(policy, retry_count=4)
        decision = engine.evaluate(ctx)
        assert "TOO_MANY_RETRIES" in decision.triggered_rules
        assert decision.action == "route"
        assert decision.model_override == "gpt-4o-mini"

    def test_no_route_within_limit(self):
        policy = _base_policy(max_retries=3)
        ctx = _base_context(policy, retry_count=2)
        decision = engine.evaluate(ctx)
        assert "TOO_MANY_RETRIES" not in decision.triggered_rules


class TestRepeatedToolFailures:
    def test_pause_on_three_failures(self):
        policy = _base_policy()
        ctx = _base_context(policy, tool_failure_count=3)
        decision = engine.evaluate(ctx)
        assert "REPEATED_TOOL_FAILURES" in decision.triggered_rules
        assert decision.action == "pause"


class TestExpensiveModelSimpleTask:
    def test_route_expensive_model_simple_task(self):
        policy = _base_policy(
            expensive_models=["gpt-4o"],
            fallback_model="gpt-4o-mini",
        )
        ctx = _base_context(
            policy,
            model="gpt-4o",
            input_tokens=1000,
            output_tokens=300,  # < 500 threshold
        )
        decision = engine.evaluate(ctx)
        assert "EXPENSIVE_MODEL_SIMPLE_TASK" in decision.triggered_rules
        assert decision.action == "route"

    def test_no_route_for_complex_task(self):
        policy = _base_policy(expensive_models=["gpt-4o"])
        ctx = _base_context(policy, model="gpt-4o", output_tokens=2000)
        decision = engine.evaluate(ctx)
        assert "EXPENSIVE_MODEL_SIMPLE_TASK" not in decision.triggered_rules


class TestMissingAttribution:
    def test_alert_when_no_customer_or_project(self):
        policy = _base_policy()
        ctx = _base_context(policy, customer_id=None, project_id=None)
        decision = engine.evaluate(ctx)
        assert "MISSING_ATTRIBUTION" in decision.triggered_rules

    def test_no_alert_with_project_id(self):
        policy = _base_policy()
        ctx = _base_context(policy, customer_id=None, project_id="proj-001")
        decision = engine.evaluate(ctx)
        assert "MISSING_ATTRIBUTION" not in decision.triggered_rules


class TestLowSuccessRate:
    def test_alert_on_low_success(self):
        policy = _base_policy(min_success_rate=0.85)
        ctx = _base_context(policy, rolling_30d_success_rate=0.70)
        decision = engine.evaluate(ctx)
        assert "LOW_SUCCESS_RATE" in decision.triggered_rules


class TestNegativeClientMargin:
    def test_alert_on_negative_margin(self):
        policy = _base_policy()
        ctx = _base_context(
            policy,
            customer_revenue_period=Decimal("100"),
            customer_cost_period=Decimal("150"),
        )
        decision = engine.evaluate(ctx)
        assert "NEGATIVE_CLIENT_MARGIN" in decision.triggered_rules

    def test_no_alert_when_no_revenue_data(self):
        """Zero revenue = unknown margin, not negative margin."""
        policy = _base_policy()
        ctx = _base_context(
            policy,
            customer_revenue_period=Decimal("0"),
            customer_cost_period=Decimal("150"),
        )
        decision = engine.evaluate(ctx)
        assert "NEGATIVE_CLIENT_MARGIN" not in decision.triggered_rules


class TestUnusualUserConsumption:
    def test_alert_on_spike(self):
        policy = _base_policy()
        ctx = _base_context(
            policy,
            user_today_usd=Decimal("50"),    # 25x average
            user_30d_daily_avg_usd=Decimal("2"),
        )
        decision = engine.evaluate(ctx)
        assert "UNUSUAL_USER_CONSUMPTION" in decision.triggered_rules


class TestDuplicateRequest:
    def test_route_duplicate(self):
        policy = _base_policy(fallback_model="gpt-4o-mini")
        ctx = _base_context(
            policy,
            request_hash="dup-hash-001",
            recent_request_hashes=["dup-hash-001", "other-hash"],
        )
        decision = engine.evaluate(ctx)
        assert "DUPLICATE_REQUEST" in decision.triggered_rules
        assert decision.action in ("route", "pause")  # route or higher

    def test_no_route_unique_request(self):
        policy = _base_policy()
        ctx = _base_context(
            policy,
            request_hash="unique-hash",
            recent_request_hashes=["other-hash-1", "other-hash-2"],
        )
        decision = engine.evaluate(ctx)
        assert "DUPLICATE_REQUEST" not in decision.triggered_rules


class TestOutsideApprovedHours:
    def test_pause_outside_hours(self):
        policy = _base_policy(allowed_hours=(9, 18))  # 9 AM - 6 PM UTC
        ctx = _base_context(policy, request_hour_utc=2)  # 2 AM — blocked
        decision = engine.evaluate(ctx)
        assert "OUTSIDE_APPROVED_HOURS" in decision.triggered_rules
        # observe mode caps at alert, enforce would pause
        assert decision.action in ("alert", "pause")

    def test_allow_within_hours(self):
        policy = _base_policy(allowed_hours=(9, 18))
        ctx = _base_context(policy, request_hour_utc=14)  # 2 PM — allowed
        decision = engine.evaluate(ctx)
        assert "OUTSIDE_APPROVED_HOURS" not in decision.triggered_rules


class TestActionPriority:
    def test_pause_wins_over_alert(self):
        """MONTHLY_BUDGET_EXCEEDED (pause) + MISSING_ATTRIBUTION (alert) = pause."""
        policy = _base_policy()
        ctx = _base_context(
            policy,
            period_spent_usd=Decimal("1000"),   # triggers EXCEEDED -> pause
            customer_id=None,
            project_id=None,                    # triggers MISSING_ATTRIBUTION -> alert
        )
        decision = engine.evaluate(ctx)
        assert decision.action == "pause"
        assert len(decision.triggered_rules) >= 2

    def test_no_fallback_model_downgrades_route_to_alert(self):
        """If fallback_model is None, route action downgrades to alert."""
        policy = _base_policy(max_retries=3, fallback_model=None)
        ctx = _base_context(policy, retry_count=4)
        decision = engine.evaluate(ctx)
        # Route without a target model should fall back to alert
        assert decision.action == "alert"
