import uuid
from decimal import Decimal
from datetime import datetime, timezone
from typing import Any
from collections import defaultdict
from .base import BaseDetector
from ..models import UsageRecord, Finding

class RetriesDetector(BaseDetector):
    category = "failures_retries"

    def detect(self, records: list[UsageRecord], audit_id: str, pricing_registry: Any) -> list[Finding]:
        workloads = defaultdict(list)
        for r in records:
            workloads[r.workload].append(r)

        findings = []
        for workload, w_records in workloads.items():
            total_requests = len(w_records)
            if total_requests == 0:
                continue

            failed_requests = sum(1 for r in w_records if r.status == "failure")
            retry_requests = sum(1 for r in w_records if r.retries > 0)
            
            failure_rate = failed_requests / total_requests
            retry_rate = sum(r.retries for r in w_records) / total_requests

            failure_cost = sum(r.cost for r in w_records if r.status == "failure")
            retry_cost = sum(r.cost for r in w_records if r.retries > 0)

            tokens_consumed_by_failures = sum(r.input_tokens + r.output_tokens for r in w_records if r.status == "failure")
            tokens_consumed_by_retries = sum((r.input_tokens + r.output_tokens) * r.retries for r in w_records)

            if failure_rate > 0.02 or retry_rate > 0.05:
                estimated_savings = (failure_cost + retry_cost) * Decimal("0.7")
                
                if estimated_savings <= 0:
                    continue

                current_cost = sum(r.cost for r in w_records)
                projected_cost = current_cost - estimated_savings
                monthly_savings = estimated_savings
                annual_savings = monthly_savings * 12

                findings.append(Finding(
                    finding_id=str(uuid.uuid4()),
                    audit_id=audit_id,
                    category=self.category,
                    title=f"High Failure/Retry Rate in {workload}",
                    description=f"Workload '{workload}' is experiencing frequent failures or retries.",
                    evidence={
                        "workload": workload,
                        "failure_rate": float(failure_rate),
                        "retry_rate": float(retry_rate),
                        "failure_cost": float(failure_cost),
                        "retry_cost": float(retry_cost),
                        "tokens_consumed_by_failures": tokens_consumed_by_failures,
                        "tokens_consumed_by_retries": tokens_consumed_by_retries
                    },
                    current_cost=current_cost,
                    proposed_change="Investigate error causes and optimize API usage to reduce retry/failure loops.",
                    projected_cost=projected_cost,
                    monthly_savings=monthly_savings,
                    annual_savings=annual_savings,
                    confidence=0.8,
                    quality_risk="low",
                    validation_status="ESTIMATED",
                    review_status="PENDING",
                    dependencies=[],
                    created_at=datetime.now(timezone.utc),
                    reviewed_at=None,
                    reviewer_notes=None
                ))

        return findings
