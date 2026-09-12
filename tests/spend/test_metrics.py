"""
Tests for core.spend.metrics — SpendMetrics calculator.
"""
from __future__ import annotations

import pytest
from datetime import datetime, timezone
from decimal import Decimal

from core.spend.metrics import compute_spend_metrics
from core.models import UsageRecord


def _make_record(**kwargs) -> UsageRecord:
    """Create a minimal valid UsageRecord with SCP fields."""
    defaults = dict(
        audit_id="audit-001",
        service_provider_name="openai",
        resource_name="gpt-4o-mini",
        ai_model="gpt-4o-mini",
        charge_period_start=datetime(2026, 9, 1, tzinfo=timezone.utc),
        charge_period_end=datetime(2026, 9, 1, 0, 0, 5, tzinfo=timezone.utc),
        effective_cost=Decimal("0.01"),
        billing_currency="USD",
    )
    defaults.update(kwargs)
    return UsageRecord(**defaults)


PERIOD_START = datetime(2026, 9, 1, tzinfo=timezone.utc)
PERIOD_END   = datetime(2026, 9, 30, 23, 59, 59, tzinfo=timezone.utc)


class TestBasicAggregation:
    def test_total_cost(self):
        records = [
            _make_record(effective_cost=Decimal("1.00")),
            _make_record(effective_cost=Decimal("2.50")),
        ]
        m = compute_spend_metrics(records, PERIOD_START, PERIOD_END)
        assert m.total_cost == Decimal("3.50")

    def test_empty_records(self):
        m = compute_spend_metrics([], PERIOD_START, PERIOD_END)
        assert m.total_cost == Decimal("0")
        assert m.successful_task_episodes == 0

    def test_cost_per_customer(self):
        records = [
            _make_record(effective_cost=Decimal("1.00"), scp_customer_id="cust-A"),
            _make_record(effective_cost=Decimal("3.00"), scp_customer_id="cust-A"),
            _make_record(effective_cost=Decimal("2.00"), scp_customer_id="cust-B"),
        ]
        m = compute_spend_metrics(records, PERIOD_START, PERIOD_END)
        assert m.cost_per_customer["cust-A"] == Decimal("4.00")
        assert m.cost_per_customer["cust-B"] == Decimal("2.00")

    def test_records_without_customer_are_grouped_as_unknown(self):
        records = [
            _make_record(effective_cost=Decimal("1.00"), scp_customer_id=None),
        ]
        m = compute_spend_metrics(records, PERIOD_START, PERIOD_END)
        # Unknown customers are not in the per-customer dict
        assert "None" not in m.cost_per_customer


class TestTaskEpisodeEconomics:
    def test_cost_per_successful_task(self):
        records = [
            _make_record(effective_cost=Decimal("1.00"), scp_task_episode_id="ep-001", scp_task_status="success"),
            _make_record(effective_cost=Decimal("0.50"), scp_task_episode_id="ep-001", scp_task_status="success"),
            _make_record(effective_cost=Decimal("2.00"), scp_task_episode_id="ep-002", scp_task_status="success"),
        ]
        m = compute_spend_metrics(records, PERIOD_START, PERIOD_END)
        assert m.successful_task_episodes == 2
        # total = 3.50, 2 successful episodes -> 1.75 per success
        assert m.cost_per_successful_task == Decimal("1.75")

    def test_cost_per_failed_task(self):
        records = [
            _make_record(effective_cost=Decimal("1.00"), scp_task_episode_id="ep-001", scp_task_status="failure"),
        ]
        m = compute_spend_metrics(records, PERIOD_START, PERIOD_END)
        assert m.cost_per_failed_task == Decimal("1.00")

    def test_no_episodes_gives_zero_cost(self):
        records = [_make_record(effective_cost=Decimal("1.00"))]
        m = compute_spend_metrics(records, PERIOD_START, PERIOD_END)
        assert m.cost_per_successful_task == Decimal("0")


class TestGrossMargin:
    def test_positive_margin(self):
        records = [
            _make_record(effective_cost=Decimal("100"), scp_customer_revenue=Decimal("300")),
        ]
        m = compute_spend_metrics(records, PERIOD_START, PERIOD_END)
        assert m.gross_margin_usd == Decimal("200")
        assert m.gross_margin_pct == pytest.approx(66.67, rel=0.01)

    def test_negative_margin(self):
        records = [
            _make_record(effective_cost=Decimal("300"), scp_customer_revenue=Decimal("100")),
        ]
        m = compute_spend_metrics(records, PERIOD_START, PERIOD_END)
        assert m.gross_margin_usd < Decimal("0")

    def test_unknown_revenue_gives_none_margin_pct(self):
        records = [_make_record(effective_cost=Decimal("100"), scp_customer_revenue=None)]
        m = compute_spend_metrics(records, PERIOD_START, PERIOD_END)
        assert m.gross_margin_pct is None


class TestConcentration:
    def test_concentration_with_three_customers(self):
        records = [
            _make_record(effective_cost=Decimal("60"), scp_customer_id="A"),
            _make_record(effective_cost=Decimal("25"), scp_customer_id="B"),
            _make_record(effective_cost=Decimal("10"), scp_customer_id="C"),
            _make_record(effective_cost=Decimal("5"),  scp_customer_id="D"),
        ]
        m = compute_spend_metrics(records, PERIOD_START, PERIOD_END)
        # Top-3 = A+B+C = 95, total = 100 -> 95%
        assert m.cost_concentration_pct == pytest.approx(95.0, rel=0.01)
        assert m.top_customers_by_cost[0] == "A"


class TestAvoidedSpending:
    def test_routing_savings_from_route_actions(self):
        """Route-action savings go into routing_savings, not avoided_spending."""
        records = [
            _make_record(effective_cost=Decimal("0.10"), scp_avoided_cost=Decimal("3.50"), scp_policy_action="route"),
            _make_record(effective_cost=Decimal("0.20"), scp_avoided_cost=Decimal("1.00"), scp_policy_action="route"),
            _make_record(effective_cost=Decimal("0.50"), scp_avoided_cost=None),
        ]
        m = compute_spend_metrics(records, PERIOD_START, PERIOD_END)
        assert m.routing_savings == Decimal("4.50")
        assert m.routing_savings_count == 2
        assert m.avoided_spending == Decimal("0")    # no pause actions in this set

    def test_avoided_spending_from_pause_actions(self):
        """Pause-action savings (circuit breaker) go into avoided_spending."""
        records = [
            _make_record(effective_cost=Decimal("0.00"), scp_avoided_cost=Decimal("8.40"), scp_policy_action="pause"),
            _make_record(effective_cost=Decimal("0.10"), scp_avoided_cost=None),
        ]
        m = compute_spend_metrics(records, PERIOD_START, PERIOD_END)
        assert m.avoided_spending == Decimal("8.40")
        assert m.routing_savings == Decimal("0")     # no route actions in this set

    def test_realized_savings_from_baseline(self):
        """realized_savings = baseline - actual_cost (must be positive)."""
        records = [_make_record(effective_cost=Decimal("8200"))]
        m = compute_spend_metrics(
            records, PERIOD_START, PERIOD_END,
            baseline_cost_usd=Decimal("12000"),
        )
        assert m.realized_savings == Decimal("3800")
        assert m.total_cost == Decimal("8200")

    def test_realized_savings_zero_when_over_baseline(self):
        """If actual cost exceeds baseline, realized_savings = 0 (not negative)."""
        records = [_make_record(effective_cost=Decimal("15000"))]
        m = compute_spend_metrics(
            records, PERIOD_START, PERIOD_END,
            baseline_cost_usd=Decimal("12000"),
        )
        assert m.realized_savings == Decimal("0")

    def test_three_savings_are_independent(self):
        """All three savings types accumulate independently in same period."""
        records = [
            _make_record(effective_cost=Decimal("100"), scp_avoided_cost=Decimal("40"), scp_policy_action="route"),
            _make_record(effective_cost=Decimal("0"),   scp_avoided_cost=Decimal("25"), scp_policy_action="pause"),
        ]
        m = compute_spend_metrics(
            records, PERIOD_START, PERIOD_END,
            baseline_cost_usd=Decimal("200"),
            projected_annual_savings=Decimal("39840"),
        )
        # Realized: baseline 200 - actual 100 = 100
        assert m.realized_savings == Decimal("100")
        # Avoided: pause action prevented 25
        assert m.avoided_spending == Decimal("25")
        # Routing: route action saved 40
        assert m.routing_savings == Decimal("40")
        # Projected: passed in directly
        assert m.projected_annual_savings == Decimal("39840")


class TestHumanReview:
    def test_review_cost_calculation(self):
        records = [
            _make_record(scp_human_review_minutes=15.0),
            _make_record(scp_human_review_minutes=10.0),
        ]
        # Default rate = $1.50/min
        m = compute_spend_metrics(records, PERIOD_START, PERIOD_END)
        assert m.total_human_review_minutes == 25.0
        assert m.human_review_cost_estimate == Decimal("37.50")
