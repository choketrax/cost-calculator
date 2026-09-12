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
    """FOCUS 1.4-aligned representation of a single AI usage event, with AI-specific extensions.

    The FOCUS 1.4 core columns (BilledCost, EffectiveCost, ChargePeriod*, etc.) follow the
    FinOps Open Cost and Usage Specification v1.4 (ratified June 4, 2026). The `ai.*` and
    `scp_*` namespaces are AI-specific extensions that go beyond the standard itself.

    Formal FOCUS 1.4 conformance validation has not yet been run against the hosted FOCUS
    Validator (which currently documents 1.2/1.3 selection). Do not claim formal conformance
    until that validation is complete.

    OTel GenAI semantic conventions are mapped to this schema via the ingest adapter.
    The adapter is the single point of change as OTel GenAI attributes continue to evolve.
    See: https://opentelemetry.io/docs/specs/semconv/gen-ai/
    """

    # Internal Tracking
    record_id: str = Field(default_factory=new_id)
    audit_id: str
    import_source: str = "unknown"
    import_hash: str = ""

    # FOCUS 1.4 Core Columns
    service_provider_name: str = Field(alias="ServiceProviderName")
    service_name: str = Field(alias="ServiceName", default="AI API")
    resource_name: str = Field(alias="ResourceName")
    resource_id: Optional[str] = Field(alias="ResourceId", default=None)
    sku_id: Optional[str] = Field(alias="SkuId", default=None)
    sku_price_id: Optional[str] = Field(alias="SkuPriceId", default=None)
    billed_cost: Decimal = Field(alias="BilledCost", default=Decimal("0"))
    effective_cost: Decimal = Field(alias="EffectiveCost", default=Decimal("0"))
    list_cost: Decimal = Field(alias="ListCost", default=Decimal("0"))
    charge_category: Literal["Usage", "Purchase", "Tax", "Credit", "Adjustment"] = Field(alias="ChargeCategory", default="Usage")
    pricing_category: Optional[Literal["Standard", "Committed", "Dynamic", "Other"]] = Field(alias="PricingCategory", default=None)
    consumed_quantity: Decimal = Field(alias="ConsumedQuantity", default=Decimal("1"))
    consumed_unit: str = Field(alias="ConsumedUnit", default="Requests")
    billing_currency: str = Field(alias="BillingCurrency", default="USD")
    billing_period_start: Optional[datetime] = Field(alias="BillingPeriodStart", default=None)
    billing_period_end: Optional[datetime] = Field(alias="BillingPeriodEnd", default=None)
    charge_period_start: datetime = Field(alias="ChargePeriodStart")
    charge_period_end: datetime = Field(alias="ChargePeriodEnd")

    # Custom AI Extensibility Namespace (ai.*)
    ai_model: str = Field(alias="ai.model")
    ai_workflow: Optional[str] = Field(alias="ai.workflow", default=None)
    ai_agent: Optional[str] = Field(alias="ai.agent", default=None)
    ai_use_case: Optional[str] = Field(alias="ai.use_case", default=None)
    ai_customer: Optional[str] = Field(alias="ai.customer", default=None)
    ai_input_tokens: int = Field(alias="ai.input_tokens", default=0)
    ai_output_tokens: int = Field(alias="ai.output_tokens", default=0)
    ai_cached_tokens: int = Field(alias="ai.cached_tokens", default=0)
    ai_cache_creation_tokens: int = Field(alias="ai.cache_creation_tokens", default=0)
    ai_reasoning_tokens: int = Field(alias="ai.reasoning_tokens", default=0)
    ai_latency_ms: Optional[float] = Field(alias="ai.latency_ms", default=None)
    ai_retry_count: int = Field(alias="ai.retry_count", default=0)
    ai_request_id: Optional[str] = Field(alias="ai.request_id", default=None)
    ai_status: Literal["success", "failure", "retry", "unknown"] = Field(alias="ai.status", default="success")
    ai_quality_score: Optional[float] = Field(alias="ai.quality_score", default=None)
    ai_business_outcome: Optional[str] = Field(alias="ai.business_outcome", default=None)

    # Added from OTel Adapter for data quality gates
    provider_source: Literal["otel", "legacy", "inferred", "unknown"] = Field(default="unknown")
    telemetry_presence: dict = Field(default_factory=dict)
    provenance: dict = Field(default_factory=dict)

    # ---------------------------------------------------------------------------
    # Spend Control Pack (SCP) — Financial Namespace
    # All scp_* fields are optional so existing records remain valid.
    # ---------------------------------------------------------------------------

    # Entity attribution (FOCUS-Lite extension)
    scp_customer_id: Optional[str] = Field(default=None, description="Billable customer identifier")
    scp_project_id: Optional[str] = Field(default=None, description="Project or product line identifier")
    scp_workflow_id: Optional[str] = Field(default=None, description="Workflow or pipeline identifier")
    scp_agent_id: Optional[str] = Field(default=None, description="Agent identifier (maps to policy scope_id)")
    scp_user_id: Optional[str] = Field(default=None, description="End-user identifier for per-user anomaly detection")

    # Task-episode economics
    scp_task_episode_id: Optional[str] = Field(default=None, description="Groups all LLM calls for one task outcome")
    scp_task_status: Optional[Literal["success", "failure", "pending", "cancelled"]] = Field(
        default=None, description="Final outcome of the task episode"
    )
    scp_human_review_minutes: float = Field(default=0.0, description="Human-review time charged to this episode (minutes)")
    scp_customer_revenue: Optional[Decimal] = Field(default=None, description="Revenue earned from this customer for this episode (USD)")
    scp_allocated_budget: Optional[Decimal] = Field(default=None, description="Budget allocated to this agent/project for the period (USD)")
    scp_quality_score: Optional[float] = Field(default=None, ge=0.0, le=1.0, description="Quality score 0-1 (from promptfoo or evaluator)")
    scp_policy_action: Optional[Literal["allow", "alert", "route", "pause"]] = Field(
        default=None, description="Action taken by the policy engine for this request"
    )
    scp_avoided_cost: Optional[Decimal] = Field(default=None, description="Cost avoided by routing to a cheaper model (USD)")
    scp_request_hash: Optional[str] = Field(default=None, description="SHA-256 of request payload for duplicate detection")

    model_config = {"populate_by_name": True, "arbitrary_types_allowed": True}

    from pydantic import model_validator
    
    @model_validator(mode="after")
    def validate_focus_constraints(self):
        # Tax -> PricingCategory null
        if self.charge_category == "Tax" and self.pricing_category is not None:
            raise ValueError("PricingCategory must be null for Tax charges")
        
        # Usage charge + SkuPriceId -> PricingCategory required
        if self.charge_category == "Usage" and self.sku_price_id is not None and self.pricing_category is None:
            raise ValueError("PricingCategory is required for Usage charges with a SkuPriceId")
            
        return self


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
    rule_id: str = "UNKNOWN"
    rule_version: str = "1.0.0"
    category: str
    severity: str = "MEDIUM"
    title: str
    description: str
    recommendation: str = ""
    evidence: dict[str, Any]  # Structured evidence (no raw prompts)
    affected_workloads: list[str] = Field(default_factory=list)
    affected_models: list[str] = Field(default_factory=list)
    current_cost: Decimal
    proposed_change: str = ""  # Human-readable description
    projected_cost: Decimal
    monthly_savings: Decimal
    annual_savings: Decimal
    savings_low: Decimal = Decimal("0")
    savings_p50: Decimal = Decimal("0")
    savings_high: Decimal = Decimal("0")
    potential_savings_low: Decimal = Decimal("0")  # Legacy
    potential_savings_high: Decimal = Decimal("0")  # Legacy
    confidence: float = Field(ge=0.0, le=1.0)
    quality_risk: str = "medium"
    implementation_effort: str = "medium"
    reversibility: str = "high"
    validation_status: str = "IDENTIFIED"
    validation_plan: str = ""
    overlap_group: Optional[str] = None
    review_status: str = "PENDING"
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
# Spend Control Pack — Aggregate Models
# ---------------------------------------------------------------------------

TaskStatus = Literal["success", "failure", "pending", "cancelled"]
PolicyAction = Literal["allow", "alert", "route", "pause"]
EnforcementMode = Literal["observe", "enforce"]
CircuitState = Literal["closed", "open", "half_open"]


class SpendMetrics(BaseModel):
    """Aggregate financial metrics for the Spend Control Pack dashboard."""

    period_start: datetime
    period_end: datetime
    computed_at: datetime = Field(default_factory=datetime.utcnow)

    # Per-entity costs
    cost_per_customer: dict[str, Decimal] = Field(default_factory=dict)
    cost_per_project: dict[str, Decimal] = Field(default_factory=dict)
    cost_per_agent: dict[str, Decimal] = Field(default_factory=dict)
    cost_per_user: dict[str, Decimal] = Field(default_factory=dict)

    # Task-episode economics
    total_task_episodes: int = 0
    successful_task_episodes: int = 0
    cost_per_successful_task: Decimal = Decimal("0")
    cost_per_failed_task: Decimal = Decimal("0")

    # Margin accounting
    total_cost: Decimal = Decimal("0")
    total_revenue: Decimal = Decimal("0")
    gross_margin_usd: Decimal = Decimal("0")
    gross_margin_pct: Optional[float] = None  # None when revenue unknown

    # Concentration risk (top-3 customers as % of total)
    cost_concentration_pct: float = 0.0
    top_customers_by_cost: list[str] = Field(default_factory=list)

    # Budget tracking
    budget_consumption_pct: float = 0.0  # 0-100
    total_allocated_budget: Decimal = Decimal("0")

    # ---------------------------------------------------------------------------
    # Savings Accounting — three separate line items (CFO/FinOps standard)
    # Do NOT aggregate these; they represent different certainty levels.
    # ---------------------------------------------------------------------------

    realized_savings: Decimal = Decimal("0")
    """Actual spend reduction measured against a validated cost baseline (past tense).
    Example: Customer spent $8,200 vs validated $12,000 baseline = $3,800 realized.
    Populated by proof_report when a baseline_cost_usd is provided."""

    avoided_spending: Decimal = Decimal("0")
    """Estimated cost prevented by circuit-breaker or pause actions (present tense).
    From records where scp_policy_action='pause' and scp_avoided_cost > 0.
    Example: Circuit breaker stopped an estimated $840 runaway episode."""

    routing_savings: Decimal = Decimal("0")
    """Cost reduction from model routing actions during the period (present tense).
    From records where scp_policy_action='route' and scp_avoided_cost > 0.
    Example: gpt-4o to gpt-4o-mini saved $1.20 on this task."""

    routing_savings_count: int = 0
    """Number of requests where a cheaper model was substituted by routing."""

    projected_annual_savings: Decimal = Decimal("0")
    """Annualized savings from currently approved routing configs (future tense).
    Not a measured figure — caller passes from approved scp_routing_table records."""

    # Human review cost (at $X/min)
    total_human_review_minutes: float = 0.0
    human_review_cost_estimate: Decimal = Decimal("0")

    model_config = {"arbitrary_types_allowed": True}


class PolicyDecision(BaseModel):
    """Result of the policy engine evaluation for a single request."""

    request_id: str = Field(default_factory=new_id)
    evaluated_at: datetime = Field(default_factory=datetime.utcnow)
    action: PolicyAction
    rule_id: Optional[str] = None          # First triggering rule
    triggered_rules: list[str] = Field(default_factory=list)
    reason: str = ""
    evidence: dict[str, Any] = Field(default_factory=dict)
    model_override: Optional[str] = None   # Set when action == "route"
    policy_id: Optional[str] = None
    enforcement_mode: EnforcementMode = "observe"

    model_config = {"arbitrary_types_allowed": True}


class CircuitBreakerState(BaseModel):
    """Live circuit breaker state for an agent or project."""

    scope: str                             # "agent" | "project" | "customer"
    scope_id: str
    state: CircuitState = "closed"
    open_reason: Optional[str] = None
    open_at: Optional[datetime] = None
    consecutive_failures: int = 0
    cost_anomaly_count: int = 0
    low_quality_count: int = 0
    last_evaluated: datetime = Field(default_factory=datetime.utcnow)
    reset_requires_approval: bool = True
    approval_id: Optional[str] = None

    model_config = {"arbitrary_types_allowed": True}


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
