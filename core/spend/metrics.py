from datetime import datetime, timezone
from decimal import Decimal
from collections import defaultdict
from typing import Optional

from core.models import SpendMetrics, UsageRecord


def calculate_spend_metrics(
    records: list[UsageRecord],
    period_start: datetime,
    period_end: datetime,
    human_review_rate_per_min: Decimal = Decimal("1.50"),
    baseline_cost_usd: Optional[Decimal] = None,
    projected_annual_savings: Optional[Decimal] = None,
) -> SpendMetrics:
    """Compute SpendMetrics from a list of UsageRecords.

    Args:
        records: All usage records for the period.
        period_start / period_end: Inclusive period bounds.
        human_review_rate_per_min: Hourly rate to estimate human review cost.
        baseline_cost_usd: Optional validated cost baseline. When provided,
            realized_savings = baseline_cost_usd - total_cost (floor 0).
        projected_annual_savings: Optional value from approved scp_routing_table
            records. Caller responsibility to compute and pass this in.
    """
    cost_per_customer: dict[str, Decimal] = defaultdict(Decimal)
    cost_per_project: dict[str, Decimal] = defaultdict(Decimal)
    cost_per_agent: dict[str, Decimal] = defaultdict(Decimal)
    cost_per_user: dict[str, Decimal] = defaultdict(Decimal)

    task_episodes: set[str] = set()
    successful_task_episodes_set: set[str] = set()
    failed_task_episodes_set: set[str] = set()

    total_cost = Decimal("0")
    total_revenue = Decimal("0")
    total_allocated_budget = Decimal("0")

    # Split savings: pause actions vs. route actions (separate certainty levels)
    avoided_spending = Decimal("0")    # pause / circuit-breaker prevention
    routing_savings = Decimal("0")     # route / model-downgrade savings
    routing_savings_count = 0

    total_human_review_minutes = 0.0

    for r in records:
        cost = r.effective_cost
        total_cost += cost

        if r.scp_customer_id:
            cost_per_customer[r.scp_customer_id] += cost
        if r.scp_project_id:
            cost_per_project[r.scp_project_id] += cost
        if r.scp_agent_id:
            cost_per_agent[r.scp_agent_id] += cost
        if r.scp_user_id:
            cost_per_user[r.scp_user_id] += cost

        if r.scp_task_episode_id:
            task_episodes.add(r.scp_task_episode_id)
            if r.scp_task_status == "success":
                successful_task_episodes_set.add(r.scp_task_episode_id)
            elif r.scp_task_status == "failure":
                failed_task_episodes_set.add(r.scp_task_episode_id)

        if r.scp_customer_revenue is not None:
            total_revenue += r.scp_customer_revenue

        if r.scp_allocated_budget is not None:
            total_allocated_budget += r.scp_allocated_budget

        # Route action: model-substitution savings
        if (r.scp_policy_action == "route"
                and r.scp_avoided_cost is not None
                and r.scp_avoided_cost > Decimal("0")):
            routing_savings += r.scp_avoided_cost
            routing_savings_count += 1

        # Pause action: circuit-breaker / budget-exceeded prevention
        if (r.scp_policy_action == "pause"
                and r.scp_avoided_cost is not None
                and r.scp_avoided_cost > Decimal("0")):
            avoided_spending += r.scp_avoided_cost

        if r.scp_human_review_minutes:
            total_human_review_minutes += r.scp_human_review_minutes

    total_task_episodes = len(task_episodes)
    successful_task_episodes = len(successful_task_episodes_set)
    failed_task_episodes = len(failed_task_episodes_set)

    cost_per_successful_task = Decimal("0")
    if successful_task_episodes > 0:
        cost_per_successful_task = total_cost / Decimal(successful_task_episodes)

    cost_per_failed_task = Decimal("0")
    if failed_task_episodes > 0:
        cost_per_failed_task = total_cost / Decimal(failed_task_episodes)

    gross_margin_usd = total_revenue - total_cost
    gross_margin_pct: Optional[float] = None
    if total_revenue > Decimal("0"):
        gross_margin_pct = float(gross_margin_usd / total_revenue * Decimal("100"))

    sorted_customers = sorted(cost_per_customer.items(), key=lambda x: x[1], reverse=True)
    top_customers = sorted_customers[:3]
    top_customers_by_cost = [c[0] for c in top_customers]

    top_customers_cost = sum(c[1] for c in top_customers)
    cost_concentration_pct = 0.0
    if total_cost > Decimal("0"):
        cost_concentration_pct = float(top_customers_cost / total_cost * Decimal("100"))

    human_review_cost_estimate = (
        Decimal(str(total_human_review_minutes)) * human_review_rate_per_min
    )

    # Realized savings = measured reduction vs. a validated baseline (floor 0)
    realized_savings = Decimal("0")
    if baseline_cost_usd is not None and baseline_cost_usd > total_cost:
        realized_savings = baseline_cost_usd - total_cost

    return SpendMetrics(
        period_start=period_start,
        period_end=period_end,
        computed_at=datetime.now(timezone.utc),
        cost_per_customer=dict(cost_per_customer),
        cost_per_project=dict(cost_per_project),
        cost_per_agent=dict(cost_per_agent),
        cost_per_user=dict(cost_per_user),
        total_task_episodes=total_task_episodes,
        successful_task_episodes=successful_task_episodes,
        cost_per_successful_task=cost_per_successful_task,
        cost_per_failed_task=cost_per_failed_task,
        total_cost=total_cost,
        total_revenue=total_revenue,
        gross_margin_usd=gross_margin_usd,
        gross_margin_pct=gross_margin_pct,
        cost_concentration_pct=cost_concentration_pct,
        top_customers_by_cost=top_customers_by_cost,
        budget_consumption_pct=0.0,
        total_allocated_budget=total_allocated_budget,
        realized_savings=realized_savings,
        avoided_spending=avoided_spending,
        routing_savings=routing_savings,
        routing_savings_count=routing_savings_count,
        projected_annual_savings=projected_annual_savings or Decimal("0"),
        total_human_review_minutes=total_human_review_minutes,
        human_review_cost_estimate=human_review_cost_estimate,
    )


# Alias for backward compatibility with tests and other callers
compute_spend_metrics = calculate_spend_metrics

# Alias for backward compatibility with tests and other callers
compute_spend_metrics = calculate_spend_metrics
