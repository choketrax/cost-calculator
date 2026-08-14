import uuid
from decimal import Decimal
from datetime import datetime, timezone
from typing import Any
from collections import defaultdict
from .base import BaseDetector
from ..models import UsageRecord, Finding

class CachingDetector(BaseDetector):
    category = "caching_opportunity"

    def detect(self, records: list[UsageRecord], audit_id: str, pricing_registry: Any) -> list[Finding]:
        workloads = defaultdict(list)
        for r in records:
            workloads[r.workload].append(r)

        findings = []
        for workload, w_records in workloads.items():
            total_input = sum(r.input_tokens for r in w_records)
            total_cached = sum(r.cached_tokens for r in w_records)
            count = len(w_records)

            if count == 0:
                continue

            current_cache_ratio = total_cached / max(1, total_input)
            
            opportunity = False
            if total_cached == 0 and count > 100:
                opportunity = True
            elif total_cached > 0 and current_cache_ratio < 0.3:
                opportunity = True

            if opportunity:
                conservative_rate = 0.30
                moderate_rate = 0.55
                aggressive_rate = 0.70

                current_cost = sum(r.cost for r in w_records)
                
                def calc_savings(hit_rate: float) -> Decimal:
                    total_savings = Decimal(0)
                    for r in w_records:
                        if getattr(r, 'cached_tokens', 0) > 0 and current_cache_ratio >= hit_rate:
                            continue
                        try:
                            pricing = pricing_registry.get_price(r.provider, r.model)
                            input_price = pricing.input_token_price
                            cached_price = getattr(pricing, 'cached_input_price', input_price * Decimal("0.5"))
                        except Exception:
                            total_savings += r.cost * Decimal("0.1") * Decimal(hit_rate)
                            continue
                            
                        cacheable_tokens = Decimal(r.input_tokens) * Decimal(str(hit_rate))
                        savings_per_m = input_price - cached_price
                        total_savings += (cacheable_tokens * savings_per_m) / Decimal(1_000_000)
                    return total_savings

                moderate_savings = calc_savings(moderate_rate)
                if moderate_savings <= 0:
                    continue

                conservative_savings = calc_savings(conservative_rate)
                aggressive_savings = calc_savings(aggressive_rate)

                projected_cost = current_cost - moderate_savings
                annual_savings = moderate_savings * 12

                validation_status = "ESTIMATED" if current_cache_ratio > 0 else "IDENTIFIED"

                findings.append(Finding(
                    finding_id=str(uuid.uuid4()),
                    audit_id=audit_id,
                    category=self.category,
                    title=f"Prompt Caching Opportunity for {workload}",
                    description=f"Workload '{workload}' could benefit from prompt caching.",
                    evidence={
                        "workload": workload,
                        "current_cache_ratio": float(current_cache_ratio),
                        "conservative_savings": float(conservative_savings),
                        "moderate_savings": float(moderate_savings),
                        "aggressive_savings": float(aggressive_savings)
                    },
                    current_cost=current_cost,
                    proposed_change="Implement prompt caching with an expected moderate hit rate of 55%.",
                    projected_cost=projected_cost,
                    monthly_savings=moderate_savings,
                    annual_savings=annual_savings,
                    confidence=0.75,
                    quality_risk="low",
                    validation_status=validation_status,
                    review_status="PENDING",
                    dependencies=[],
                    created_at=datetime.now(timezone.utc),
                    reviewed_at=None,
                    reviewer_notes=None
                ))

        return findings
