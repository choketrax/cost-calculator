"""
AI Cost Auditor — Core Data Models
All financial values use Decimal for precision.
"""
from __future__ import annotations

import uuid
from datetime import datetime, date
from decimal import Decimal
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


def new_id() -> str:
    return str(uuid.uuid4())


# ---------------------------------------------------------------------------
# Canonical Usage Record
# ---------------------------------------------------------------------------

class UsageRecord(BaseModel):
    """Normalized representation of a single AI usage event."""

    record_id: str = Field(default_factory=new_id)
    audit_id: str
    timestamp: datetime
    provider: str  # "openai", "anthropic", "azure", "generic"
    model: str  # "gpt-4o", "claude-3-5-sonnet-20241022", etc.
    application: str  # Customer's app/service name
    workload: str  # "customer-support", "code-review", etc.
    requests: int = 1
    input_tokens: int = 0
    output_tokens: int = 0
    cached_tokens: int = 0
    latency_ms: Optional[float] = None
    status: Literal["success", "failure", "retry"] = "success"
    retries: int = 0
    cost: Decimal = Decimal("0")  # Calculated cost in USD
    currency: str = "USD"
    raw_cost: Optional[Decimal] = None  # Provider-reported cost if available
    import_source: str = "unknown"  # Which importer produced this record
    import_hash: str = ""  # SHA-256 of the source row

    model_config = {"arbitrary_types_allowed": True}


# ---------------------------------------------------------------------------
# Pricing
# ---------------------------------------------------------------------------

class PricingEntry(BaseModel):
    """Versioned pricing entry for a model. Never deleted, only superseded."""

    pricing_id: str = Field(default_factory=new_id)
    provider: str
    model: str
    input_token_price: Decimal  # per 1M tokens (USD)
    output_token_price: Decimal  # per 1M tokens (USD)
    cached_input_price: Decimal = Decimal("0")  # per 1M tokens (USD)
    cached_output_price: Decimal = Decimal("0")  # per 1M tokens (USD)
    request_price: Decimal = Decimal("0")  # per request (usually 0)
    effective_from: date
    effective_to: Optional[date] = None
    source: Literal["official", "manual", "estimated"] = "official"
    version: int = 1
    created_at: datetime = Field(default_factory=datetime.utcnow)
    is_superseded: bool = False
    notes: Optional[str] = None

    model_config = {"arbitrary_types_allowed": True}


# ---------------------------------------------------------------------------
# Findings
# ---------------------------------------------------------------------------

FindingCategory = Literal[
    "expensive_model",
    "excessive_context",
    "caching_opportunity",
    "failures_retries",
    "routing",
]

ValidationStatus = Literal["IDENTIFIED", "ESTIMATED", "SIMULATED", "VALIDATED"]
ReviewStatus = Literal["PENDING", "REVIEWED", "APPROVED", "REJECTED"]
QualityRisk = Literal["low", "medium", "high"]


Severity = Literal["HIGH", "MEDIUM", "LOW", "INFO"]


class Finding(BaseModel):
    """A single identified waste / optimization opportunity."""

    finding_id: str = Field(default_factory=new_id)
    audit_id: str
    category: FindingCategory
    severity: Severity = "MEDIUM"
    title: str
    description: str
    recommendation: str = ""
    evidence: dict[str, Any]  # Structured evidence (no raw prompts)
    affected_workloads: list[str] = Field(default_factory=list)
    affected_models: list[str] = Field(default_factory=list)
    current_cost: Decimal
    proposed_change: str  # Human-readable description
    projected_cost: Decimal
    monthly_savings: Decimal
    annual_savings: Decimal
    potential_savings_low: Decimal = Decimal("0")  # Conservative estimate
    potential_savings_high: Decimal = Decimal("0")  # Optimistic estimate
    confidence: float = Field(ge=0.0, le=1.0)
    quality_risk: QualityRisk = "medium"
    validation_status: ValidationStatus = "IDENTIFIED"
    review_status: ReviewStatus = "PENDING"
    dependencies: list[str] = Field(default_factory=list)  # Other finding_ids
    created_at: datetime = Field(default_factory=datetime.utcnow)
    reviewed_at: Optional[datetime] = None
    reviewer_notes: Optional[str] = None

    model_config = {"arbitrary_types_allowed": True}

    def model_post_init(self, __context: Any) -> None:
        """Derive savings range from monthly_savings if not explicitly set."""
        if self.potential_savings_low == Decimal("0") and self.monthly_savings > Decimal("0"):
            self.potential_savings_low = self.monthly_savings * Decimal("0.5")
        if self.potential_savings_high == Decimal("0") and self.monthly_savings > Decimal("0"):
            self.potential_savings_high = self.monthly_savings * Decimal("1.5")


# ---------------------------------------------------------------------------
# Cost Analysis Results
# ---------------------------------------------------------------------------

class CostBreakdown(BaseModel):
    """Aggregated cost metrics for an audit."""

    total_cost: Decimal
    cost_per_request: Decimal
    cost_per_successful_request: Decimal
    cost_per_1m_tokens: Decimal
    cost_by_provider: dict[str, Decimal]
    cost_by_model: dict[str, Decimal]
    cost_by_application: dict[str, Decimal]
    cost_by_workload: dict[str, Decimal]
    failure_cost: Decimal
    retry_cost: Decimal
    total_requests: int
    successful_requests: int
    failed_requests: int
    total_input_tokens: int
    total_output_tokens: int
    total_cached_tokens: int
    period_start: datetime
    period_end: datetime

    model_config = {"arbitrary_types_allowed": True}


# ---------------------------------------------------------------------------
# Scenario Engine
# ---------------------------------------------------------------------------

class ScenarioParameters(BaseModel):
    """Parameters for a cost optimization scenario."""

    scenario_id: str = Field(default_factory=new_id)
    audit_id: str = ""
    name: str
    description: str = ""
    # Model changes
    model_overrides: dict[str, str] = Field(default_factory=dict)  # {old_model: new_model}
    model_allocation: dict[str, dict[str, float]] = Field(default_factory=dict)  # {workload: {model: pct}}
    # Volume changes
    request_volume_multiplier: float = 1.0
    input_token_multiplier: float = 1.0
    output_token_multiplier: float = 1.0
    # Efficiency changes
    cache_hit_rate: Optional[float] = None  # 0.0 to 1.0
    context_reduction_factor: float = 1.0  # 1.0 = no reduction, 0.8 = 20% reduction
    retry_rate_target: Optional[float] = None  # Target retry rate (0.0 to 1.0)
    failure_rate_target: Optional[float] = None
    # Price overrides
    price_overrides: dict[str, dict[str, Decimal]] = Field(default_factory=dict)
    # Dependencies (must be applied before this scenario)
    depends_on: list[str] = Field(default_factory=list)  # Other finding_ids
    created_at: datetime = Field(default_factory=datetime.utcnow)

    model_config = {"arbitrary_types_allowed": True}


class ScenarioResult(BaseModel):
    """Result of a scenario simulation."""

    scenario_id: str
    audit_id: str
    baseline_cost: Decimal
    scenario_cost: Decimal
    projected_cost: Decimal = Decimal("0")  # Alias for scenario_cost
    monthly_savings: Decimal
    net_savings: Decimal = Decimal("0")  # Alias for monthly_savings
    annual_savings: Decimal
    percentage_reduction: float
    applied_findings: list[str]  # Finding IDs included
    calculation_notes: list[str]  # Step-by-step trace
    created_at: datetime = Field(default_factory=datetime.utcnow)

    model_config = {"arbitrary_types_allowed": True}

    def model_post_init(self, __context: Any) -> None:
        if self.projected_cost == Decimal("0"):
            self.projected_cost = self.scenario_cost
        if self.net_savings == Decimal("0"):
            self.net_savings = self.monthly_savings


# ---------------------------------------------------------------------------
# Monte Carlo
# ---------------------------------------------------------------------------

class DistributionSpec(BaseModel):
    """Specification for a random distribution."""

    variable_name: str
    distribution: Literal["uniform", "normal", "triangular", "beta_pert", "pert", "lognormal", "bernoulli", "weighted_choice"]
    params: dict[str, Any]  # Distribution-specific parameters
    description: str = ""

    @field_validator("params")
    @classmethod
    def validate_params(cls, v: dict, info) -> dict:
        # Basic validation; full validation is in the PRNG module
        return v


class SimulationManifest(BaseModel):
    """Immutable record of a Monte Carlo simulation run."""

    simulation_id: str = Field(default_factory=new_id)
    audit_id: str
    seed: int
    prng_algorithm: str = "numpy-pcg64"
    prng_version: str = "1"  # Internal version — increment if algorithm changes
    numpy_version: str  # Recorded at runtime
    application_version: str = "0.1.0"
    pricing_dataset_version: int
    distribution_definitions: list[dict[str, Any]]
    parameters: dict[str, Any]
    iteration_count: int
    input_hash: str  # SHA-256 of normalized input data
    scenario_hash: str  # SHA-256 of scenario parameters
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    results_hash: str = ""  # Set after simulation completes

    model_config = {"arbitrary_types_allowed": True}


class SimulationStats(BaseModel):
    """Statistical summary of Monte Carlo results."""

    mean: float
    median: float
    std_dev: float
    p5: float
    p10: float
    p25: float
    p50: float
    p75: float
    p90: float
    p95: float
    minimum: float
    maximum: float
    prob_savings_positive: float  # P(savings > 0)
    prob_savings_gt_target: float  # P(savings > target)
    iteration_count: int


class SimulationResult(BaseModel):
    """Complete Monte Carlo simulation output."""

    manifest: SimulationManifest
    baseline_stats: SimulationStats
    optimized_stats: SimulationStats
    monthly_savings_stats: SimulationStats
    annual_savings_stats: SimulationStats
    pct_savings_stats: SimulationStats
    raw_monthly_savings: Optional[list[float]] = None  # Omitted in production responses


# ---------------------------------------------------------------------------
# Savings Engine
# ---------------------------------------------------------------------------

class SavingsRecommendation(BaseModel):
    """Executive-level recommendation with full financial disclosure."""

    recommendation_id: str = Field(default_factory=new_id)
    audit_id: str
    finding_ids: list[str]
    title: str
    description: str
    current_cost: Decimal
    proposed_cost: Decimal
    expected_savings: Decimal  # Mathematical savings
    conservative_savings: Decimal  # P10 from Monte Carlo
    annual_savings: Decimal
    implementation_cost: Decimal = Decimal("0")
    payback_months: Optional[float] = None
    confidence: float  # 0.0 to 1.0
    quality_risk: QualityRisk
    validation_status: ValidationStatus
    review_status: ReviewStatus = "PENDING"
    simulation_id: Optional[str] = None

    model_config = {"arbitrary_types_allowed": True}


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------

class Audit(BaseModel):
    """Top-level container for an audit session."""

    audit_id: str  # e.g., "ACME-2026-001"
    customer_name: str
    period_start: date
    period_end: date
    status: Literal["ingesting", "analyzing", "awaiting_review", "complete"] = "ingesting"
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    total_records: int = 0
    baseline_monthly_cost: Decimal = Decimal("0")
    baseline_annual_cost: Decimal = Decimal("0")
    notes: Optional[str] = None

    model_config = {"arbitrary_types_allowed": True}
