import uuid
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Optional

from core.models import UsageRecord, PolicyDecision
from .promptfoo_runner import RoutingComparisonResult

@dataclass
class ProofReport:
    report_id: str
    audit_id: str
    generated_at: datetime
    # Before state
    previous_model: str
    previous_config_description: str
    previous_cost_per_task: Decimal
    previous_quality_score: Optional[float]
    # Problem identified
    problem_rule_id: str
    problem_description: str
    problem_detected_at: datetime
    # Tested alternative
    tested_model: str
    tested_config_name: str
    test_date: datetime
    # Quality comparison
    quality_score_before: Optional[float]
    quality_score_after: Optional[float]
    quality_threshold: float
    quality_passed: bool
    # Financial impact
    cost_per_task_before: Decimal
    cost_per_task_after: Decimal
    monthly_task_volume: int
    annual_savings_projected: Decimal
    # Controls impact
    controls_prevented_count: int
    controls_prevented_value: Decimal
    # Margin impact
    margin_pct_before: Optional[float]
    margin_pct_after: Optional[float]
    margin_improvement_pct: Optional[float]
    # Narrative
    executive_summary: str

def generate_proof_report(
    audit_id: str,
    records: list[UsageRecord],
    comparison: RoutingComparisonResult,
    policy_decisions: list[PolicyDecision],
    problem_rule_id: str
) -> ProofReport:
    # Compute base metrics
    total_cost_before = sum((r.effective_cost for r in records), Decimal("0"))
    task_count_before = len(records)
    cost_per_task_before = total_cost_before / Decimal(task_count_before) if task_count_before > 0 else Decimal("0")
    
    total_revenue_before = sum((r.scp_customer_revenue or Decimal("0") for r in records), Decimal("0"))
    margin_before = None
    if total_revenue_before > 0:
        margin_before = float((total_revenue_before - total_cost_before) / total_revenue_before * Decimal("100"))

    # Identify winner stats
    winner_cand = next((c for c in comparison.candidates if c["name"] == comparison.winner), None)
    cost_per_task_after = Decimal(str(winner_cand["cost_per_task"])) if winner_cand else cost_per_task_before
    quality_score_after = winner_cand["quality_score"] if winner_cand else None
    
    monthly_volume = task_count_before  # assuming records represent 1 month
    annual_savings = (cost_per_task_before - cost_per_task_after) * Decimal(monthly_volume) * Decimal("12")
    
    total_cost_after = cost_per_task_after * Decimal(task_count_before)
    margin_after = None
    if total_revenue_before > 0:
        margin_after = float((total_revenue_before - total_cost_after) / total_revenue_before * Decimal("100"))
        
    margin_improvement = (margin_after - margin_before) if margin_after is not None and margin_before is not None else None

    # Prevented actions
    prevented_decisions = [d for d in policy_decisions if d.action in ("route", "pause")]
    controls_prevented_count = len(prevented_decisions)
    controls_prevented_value = sum((Decimal(str(d.evidence.get("budget_usd", 0))) for d in prevented_decisions), Decimal("0"))

    exec_summary = (
        f"Model routing reduced accepted-task cost from ${cost_per_task_before:.2f} "
        f"to ${cost_per_task_after:.2f} while maintaining quality above {comparison.quality_threshold_ratio*100:.1f}%, "
        f"projecting ${annual_savings:.2f} in annual savings."
    )

    return ProofReport(
        report_id=str(uuid.uuid4()),
        audit_id=audit_id,
        generated_at=datetime.utcnow(),
        previous_model=comparison.baseline_model,
        previous_config_description="Default routing",
        previous_cost_per_task=cost_per_task_before,
        previous_quality_score=comparison.baseline_quality_score,
        problem_rule_id=problem_rule_id,
        problem_description="Inefficient model usage",
        problem_detected_at=datetime.utcnow(),
        tested_model=winner_cand["model"] if winner_cand else "None",
        tested_config_name=comparison.winner or "None",
        test_date=comparison.tested_at,
        quality_score_before=comparison.baseline_quality_score,
        quality_score_after=quality_score_after,
        quality_threshold=comparison.quality_threshold_ratio,
        quality_passed=bool(winner_cand),
        cost_per_task_before=cost_per_task_before,
        cost_per_task_after=cost_per_task_after,
        monthly_task_volume=monthly_volume,
        annual_savings_projected=annual_savings,
        controls_prevented_count=controls_prevented_count,
        controls_prevented_value=controls_prevented_value,
        margin_pct_before=margin_before,
        margin_pct_after=margin_after,
        margin_improvement_pct=margin_improvement,
        executive_summary=exec_summary
    )
