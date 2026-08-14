from .expensive_model import ExpensiveModelDetector
from .excessive_context import ExcessiveContextDetector
from .caching import CachingDetector
from .retries import RetriesDetector
from .routing import RoutingDetector
from ..models import UsageRecord, Finding
from typing import Any

class WasteDetectionRunner:
    def __init__(self, pricing_registry: Any):
        self.pricing_registry = pricing_registry
        self.detectors = [
            ExpensiveModelDetector(),
            ExcessiveContextDetector(),
            CachingDetector(),
            RetriesDetector(),
            RoutingDetector(),
        ]
    
    def detect_all(
        self,
        records: list[UsageRecord],
        audit_id: str,
    ) -> list[Finding]:
        """Run all detectors and return findings. Deduplicates by category+workload."""
        all_findings = []
        for detector in self.detectors:
            findings = detector.detect(records, audit_id, self.pricing_registry)
            all_findings.extend(findings)
            
        seen = set()
        unique_findings = []
        for f in all_findings:
            key = (f.category, f.evidence.get("workload"))
            if key not in seen:
                seen.add(key)
                unique_findings.append(f)
                
        return unique_findings
