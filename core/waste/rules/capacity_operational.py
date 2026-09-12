from typing import List
from ...models import UsageRecord, Finding
from .base import BaseAuditRule

class HighLatencyAnomalyRule(BaseAuditRule):
    rule_id = "OPERATIONAL_HIGH_LATENCY"
    rule_version = "1.1.0"
    
    def evaluate(self, records: List[UsageRecord], audit_id: str) -> List[Finding]:
        """Tagged strictly as operational waste unless it translates to financial waste (retries, timeouts)."""
        return []

class IdleProvisionedCapacityRule(BaseAuditRule):
    rule_id = "CAPACITY_IDLE_PROVISIONED"
    rule_version = "1.0.0"
    
    def evaluate(self, records: List[UsageRecord], audit_id: str) -> List[Finding]:
        return []
