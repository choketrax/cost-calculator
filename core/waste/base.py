from abc import ABC, abstractmethod
from typing import Any
from ..models import UsageRecord, Finding

class BaseDetector(ABC):
    category: str
    
    @abstractmethod
    def detect(
        self,
        records: list[UsageRecord],
        audit_id: str,
        pricing_registry: Any,
    ) -> list[Finding]:
        """Analyze records and return findings.
        
        Rules:
        - Never return VALIDATED status from a detector (only IDENTIFIED or ESTIMATED)
        - Evidence dict must not contain raw prompt text
        - Monthly savings = current_cost - projected_cost
        - Annual savings = monthly_savings * 12
        """
        ...
