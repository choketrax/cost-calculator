from abc import ABC, abstractmethod
from typing import List, Optional, Any, Literal
from pydantic import BaseModel
from ...models import UsageRecord, Finding

class RuleResult(BaseModel):
    status: Literal["PASS", "FINDING", "NOT_EVALUATED"]
    findings: List[Finding] = []
    reason: str = ""

class BaseAuditRule(ABC):
    rule_id: str = "RULE_UNKNOWN"
    rule_version: str = "1.0.0"
    
    def __init__(self, catalog: Any):
        self.catalog = catalog

    @abstractmethod
    def evaluate(self, records: List[UsageRecord], audit_id: str) -> RuleResult:
        """Evaluate records and return a RuleResult."""
        pass
        
    def _create_finding(
        self,
        audit_id: str,
        title: str,
        description: str,
        category: str,
        severity: str,
        current_cost: float,
        savings_p50: float,
        confidence: float,
        quality_risk: str,
        evidence: dict,
        implementation_effort: str = "medium",
        reversibility: str = "high",
        validation_plan: str = "Review application logs to ensure no degradation.",
        savings_low: Optional[float] = None,
        savings_high: Optional[float] = None,
    ) -> Finding:
        if savings_low is None:
            savings_low = savings_p50 * 0.8
        if savings_high is None:
            savings_high = savings_p50 * 1.2
            
        return Finding(
            audit_id=audit_id,
            rule_id=self.rule_id,
            rule_version=self.rule_version,
            category=category,
            severity=severity,
            title=title,
            description=description,
            evidence=evidence,
            current_cost=current_cost,
            savings_low=savings_low,
            savings_p50=savings_p50,
            savings_high=savings_high,
            confidence=confidence,
            quality_risk=quality_risk,
            implementation_effort=implementation_effort,
            reversibility=reversibility,
            validation_plan=validation_plan,
            # For backward compatibility with schema, these fields need defaults
            proposed_change="",
            projected_cost=current_cost - savings_p50,
            monthly_savings=savings_p50,
            annual_savings=savings_p50 * 12
        )
