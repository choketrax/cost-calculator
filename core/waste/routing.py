import uuid
from decimal import Decimal
from datetime import datetime, timezone
from typing import Any
from collections import defaultdict
from .base import BaseDetector
from ..models import UsageRecord, Finding

PREMIUM_MODELS = ["gpt-4o", "claude-3-5-sonnet-20241022", "gpt-4-turbo", "claude-3-opus-20240229"]

ROUTING_ALTERNATIVES = {
    "gpt-4o": ("gpt-4o-mini", "gpt-3.5-turbo"),
    "gpt-4-turbo": ("gpt-4o", "gpt-4o-mini"),
    "claude-3-5-sonnet-20241022": ("claude-3-5-haiku-20241022", "claude-3-haiku-20240307"),
    "claude-3-opus-20240229": ("claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"),
}

class RoutingDetector(BaseDetector):
    category = "routing"

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
                if model not in PREMIUM_MODELS or model not in ROUTING_ALTERNATIVES:
                    continue

                if len(m_records) <= 1000:
                    continue

                mid_tier_model, cheap_model = ROUTING_ALTERNATIVES[model]
                provider = m_records[0].provider
                
                current_cost = sum(r.cost for r in m_records)
                
                estimated_cost = Decimal(0)
                for r in m_records:
                    try:
                        p_pricing = pricing_registry.get_price(provider, model)
                        m_pricing = pricing_registry.get_price(provider, mid_tier_model)
                        c_pricing = pricing_registry.get_price(provider, cheap_model)
                        
                        tokens = Decimal(r.input_tokens) / Decimal(1_000_000)
                        out_tokens = Decimal(r.output_tokens) / Decimal(1_000_000)
                        
                        p_cost = tokens * p_pricing.input_token_price + out_tokens * p_pricing.output_token_price
                        m_cost = tokens * m_pricing.input_token_price + out_tokens * m_pricing.output_token_price
                        c_cost = tokens * c_pricing.input_token_price + out_tokens * c_pricing.output_token_price
                        
                        route_cost = p_cost * Decimal("0.25") + m_cost * Decimal("0.50") + c_cost * Decimal("0.25")
                        estimated_cost += route_cost
                    except Exception:
                        estimated_cost += r.cost * Decimal("0.6")
                
                monthly_savings = current_cost - estimated_cost
                if monthly_savings <= 0:
                    continue
                    
                annual_savings = monthly_savings * 12

                findings.append(Finding(
                    finding_id=str(uuid.uuid4()),
                    audit_id=audit_id,
                    category=self.category,
                    title=f"Dynamic Routing Opportunity for {workload}",
                    description=f"Workload '{workload}' concentrates traffic on premium model {model}.",
                    evidence={
                        "workload": workload,
                        "current_model": model,
                        "routing_proposal": {
                            model: "25%",
                            mid_tier_model: "50%",
                            cheap_model: "25%"
                        },
                        "current_cost": float(current_cost),
                        "estimated_cost": float(estimated_cost)
                    },
                    current_cost=current_cost,
                    proposed_change=f"Implement dynamic routing: 25% {model}, 50% {mid_tier_model}, 25% {cheap_model}.",
                    projected_cost=estimated_cost,
                    monthly_savings=monthly_savings,
                    annual_savings=annual_savings,
                    confidence=0.7,
                    quality_risk="high",
                    validation_status="ESTIMATED",
                    review_status="PENDING",
                    dependencies=[],
                    created_at=datetime.now(timezone.utc),
                    reviewed_at=None,
                    reviewer_notes=None
                ))

        return findings
