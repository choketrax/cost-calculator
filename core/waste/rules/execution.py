from typing import List
from ...models import UsageRecord, Finding
from .base import BaseAuditRule, RuleResult
from decimal import Decimal

class ZeroOutputTokenRule(BaseAuditRule):
    rule_id = "EXECUTION_ZERO_OUTPUT"
    rule_version = "1.1.0"
    
    def evaluate(self, records: List[UsageRecord], audit_id: str) -> RuleResult:
        """Flags zero output only if cost incurred + repeated pattern + error/aborted condition."""
        findings = []
        zero_output_records = [r for r in records if r.ai_output_tokens == 0 and r.billed_cost > 0]
        
        # Further filter by aborted/error condition based on status or business outcome
        bad_zero_outputs = [r for r in zero_output_records if r.ai_status == "failure" or r.ai_status == "retry"]
        
        if bad_zero_outputs and len(bad_zero_outputs) > 5:
            waste = sum((r.billed_cost for r in bad_zero_outputs), Decimal("0"))
            
            f = self._create_finding(
                audit_id=audit_id,
                title="Wasted Spend on Failed Zero-Output Requests",
                description=f"Found {len(bad_zero_outputs)} requests that incurred cost but returned 0 output tokens due to failures.",
                category="Execution",
                severity="MEDIUM",
                current_cost=float(waste),
                savings_p50=float(waste),
                confidence=0.9,
                quality_risk="low",
                evidence={"failed_requests": len(bad_zero_outputs)}
            )
            findings.append(f)
            
        if findings:
            return RuleResult(status="FINDING", findings=findings)
        return RuleResult(status="PASS", reason="No significant zero-output waste found.")

class HighRetryStormRule(BaseAuditRule):
    rule_id = "EXECUTION_RETRY_STORM"
    rule_version = "1.0.0"
    
    def evaluate(self, records: List[UsageRecord], audit_id: str) -> List[Finding]:
        return []

class AgentLoopRule(BaseAuditRule):
    rule_id = "EXECUTION_AGENT_LOOP"
    rule_version = "1.0.0"
    
    def evaluate(self, records: List[UsageRecord], audit_id: str) -> List[Finding]:
        return []
