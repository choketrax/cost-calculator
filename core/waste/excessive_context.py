import uuid
from decimal import Decimal
from datetime import datetime, timezone
from typing import Any
from collections import defaultdict
from .base import BaseDetector
from ..models import UsageRecord, Finding

class ExcessiveContextDetector(BaseDetector):
    category = "excessive_context"

    def detect(self, records: list[UsageRecord], audit_id: str, pricing_registry: Any) -> list[Finding]:
        workloads = defaultdict(list)
        for r in records:
            workloads[r.workload].append(r)

        findings = []
        for workload, w_records in workloads.items():
            total_input = sum(r.input_tokens for r in w_records)
            total_output = sum(r.output_tokens for r in w_records)
            count = len(w_records)

            if count == 0:
                continue

            avg_input = total_input / count
            input_output_ratio = total_input / max(1, total_output)

            if avg_input > 16000 or input_output_ratio > 15:
                savings = Decimal(0)
                for r in w_records:
                    try:
                        pricing = pricing_registry.get_price(r.provider, r.model)
                        input_price = pricing.input_token_price
                    except Exception:
                        input_price = Decimal("0")
                        
                    reduction_tokens = Decimal(r.input_tokens) * Decimal("0.25")
                    savings += (reduction_tokens / Decimal(1_000_000)) * input_price
                
                if savings <= 0:
                    continue
                    
                current_cost = sum(r.cost for r in w_records)
                projected_cost = current_cost - savings
                monthly_savings = savings
                annual_savings = monthly_savings * 12

                findings.append(Finding(
                    finding_id=str(uuid.uuid4()),
                    audit_id=audit_id,
                    category=self.category,
                    title=f"Excessive Context in {workload}",
                    description=f"Workload '{workload}' uses an excessive amount of input tokens per request.",
                    evidence={
                        "workload": workload,
                        "avg_input_tokens": float(avg_input),
                        "input_output_ratio": float(input_output_ratio),
                        "reduction_estimate_pct": 25.0
                    },
                    current_cost=current_cost,
                    proposed_change="Implement context reduction strategies (e.g. summarization, better retrieval) to reduce input tokens by 25%.",
                    projected_cost=projected_cost,
                    monthly_savings=monthly_savings,
                    annual_savings=annual_savings,
                    confidence=0.65,
                    quality_risk="medium",
                    validation_status="ESTIMATED",
                    review_status="PENDING",
                    dependencies=[],
                    created_at=datetime.now(timezone.utc),
                    reviewed_at=None,
                    reviewer_notes=None
                ))

        return findings
