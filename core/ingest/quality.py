from typing import Any, Optional
from pydantic import BaseModel, Field
from ..models import UsageRecord

class QualityMetrics(BaseModel):
    completeness: float = 0.0
    pricing_coverage: float = 0.0
    token_coverage: float = 0.0
    timestamp_coverage: float = 0.0
    model_identification: float = 0.0
    duplicate_records: float = 0.0
    currency_consistency: float = 0.0
    attribution_coverage: float = 0.0

class DataQualityScore(BaseModel):
    audit_id: str
    overall_confidence: float
    metrics: QualityMetrics
    missing_capabilities: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)

class DataQualityGate:
    """Evaluates the trustworthiness of usage records before rules are run."""
    
    def __init__(self, pricing_registry: Any = None):
        self.pricing_registry = pricing_registry
        
    def evaluate(self, records: list[UsageRecord], audit_id: str) -> DataQualityScore:
        if not records:
            return DataQualityScore(
                audit_id=audit_id,
                overall_confidence=0.0,
                metrics=QualityMetrics(),
                warnings=["No records provided for quality evaluation."]
            )
            
        total = len(records)
        
        # Calculate coverages
        metrics = QualityMetrics()
        
        has_tokens = 0
        has_timestamp = 0
        has_model = 0
        has_attribution = 0
        has_cached_tokens = 0
        currencies = set()
        
        for r in records:
            if r.ai_input_tokens > 0 or r.ai_output_tokens > 0:
                has_tokens += 1
            if r.charge_period_start:
                has_timestamp += 1
            if r.ai_model:
                has_model += 1
            if r.ai_workflow or r.ai_use_case or r.ai_agent:
                has_attribution += 1
            if r.ai_cached_tokens > 0:
                has_cached_tokens += 1
            if r.billing_currency:
                currencies.add(r.billing_currency)
                
        metrics.token_coverage = has_tokens / total
        metrics.timestamp_coverage = has_timestamp / total
        metrics.model_identification = has_model / total
        metrics.attribution_coverage = has_attribution / total
        metrics.currency_consistency = 1.0 if len(currencies) <= 1 else 0.5
        
        # Pricing coverage (mocked for now until registry is versioned)
        metrics.pricing_coverage = 1.0
        
        # Deduplication check (based on import_hash)
        unique_hashes = len(set(r.import_hash for r in records if r.import_hash))
        metrics.duplicate_records = 1.0 if total == 0 else (unique_hashes / total)
        
        # Overall confidence is a weighted average
        weights = {
            "token_coverage": 0.3,
            "model_identification": 0.3,
            "timestamp_coverage": 0.1,
            "attribution_coverage": 0.2,
            "duplicate_records": 0.1,
        }
        
        confidence = (
            metrics.token_coverage * weights["token_coverage"] +
            metrics.model_identification * weights["model_identification"] +
            metrics.timestamp_coverage * weights["timestamp_coverage"] +
            metrics.attribution_coverage * weights["attribution_coverage"] +
            metrics.duplicate_records * weights["duplicate_records"]
        )
        
        missing_caps = []
        if has_cached_tokens == 0:
            missing_caps.append("cache_telemetry")
            
        warnings = []
        if metrics.attribution_coverage < 0.5:
            warnings.append("Low attribution coverage. Many records lack workflow/use_case details.")
            
        return DataQualityScore(
            audit_id=audit_id,
            overall_confidence=confidence,
            metrics=metrics,
            missing_capabilities=missing_caps,
            warnings=warnings
        )
