import uuid
from decimal import Decimal
from datetime import datetime, timezone
from typing import Any
from collections import defaultdict
from .base import BaseDetector
from ..models import UsageRecord, Finding

CHEAPER_ALTERNATIVES = {
    "gpt-4o": "gpt-4o-mini",
    "claude-3-5-sonnet-20241022": "claude-3-5-haiku-20241022",
    "gpt-4-turbo": "gpt-4o",
    "claude-3-opus-20240229": "claude-3-5-sonnet-20241022",
}

class ExpensiveModelDetector(BaseDetector):
    category = "expensive_model"

    def detect(self, records: list[UsageRecord], audit_id: str, pricing_registry: Any) -> list[Finding]:
        workloads = defaultdict(list)
        for r in records:
            workloads[r.workload].append(r)

        findings = []
        for workload, w_records in workloads.items():
            models = defaultdict(list)
            for r in w_records:
                models[r.model].append(r)

            for model, m_records in models.items():
                if model not in CHEAPER_ALTERNATIVES:
                    continue

                total_input = sum(r.input_tokens for r in m_records)
                total_output = sum(r.output_tokens for r in m_records)
                count = len(m_records)
                
                avg_input = total_input / count if count > 0 else 0
                avg_output = total_output / count if count > 0 else 0

                if avg_input < 8000 and avg_output < 1000:
                    candidate_model = CHEAPER_ALTERNATIVES[model]
                    provider = m_records[0].provider
                    
                    current_cost = sum(r.cost for r in m_records)
                    
                    try:
                        candidate_pricing = pricing_registry.get_price(provider, candidate_model)
                        projected_cost = sum(
                            Decimal(r.input_tokens) * candidate_pricing.input_token_price / Decimal(1_000_000) +
                            Decimal(r.output_tokens) * candidate_pricing.output_token_price / Decimal(1_000_000)
                            for r in m_records
                        )
                    except Exception:
                        projected_cost = current_cost * Decimal("0.5")

                    monthly_savings = current_cost - projected_cost
                    annual_savings = monthly_savings * 12

                    findings.append(Finding(
                        finding_id=str(uuid.uuid4()),
                        audit_id=audit_id,
                        category=self.category,
                        title=f"Potential Model Downgrade for {workload}",
                        description=f"Workload '{workload}' using {model} has low context usage and could be downgraded.",
                        evidence={
                            "workload": workload,
                            "current_model": model,
                            "candidate_model": candidate_model,
                            "avg_input_tokens": avg_input,
                            "avg_output_tokens": avg_output,
                            "request_count": count
                        },
                        current_cost=current_cost,
                        proposed_change=f"Evaluate {candidate_model} as replacement for {model} in {workload}",
                        projected_cost=projected_cost,
                        monthly_savings=monthly_savings,
                        annual_savings=annual_savings,
                        confidence=0.6,
                        quality_risk="high",
                        validation_status="IDENTIFIED",
                        review_status="PENDING",
                        dependencies=[],
                        created_at=datetime.now(timezone.utc),
                        reviewed_at=None,
                        reviewer_notes=None
                    ))
        return findings
