"""Request/response Pydantic schemas for the API."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Generic, Literal, Optional, TypeVar

from pydantic import BaseModel, Field

from core.models import DistributionSpec

T = TypeVar("T")


class ApiResponse(BaseModel, Generic[T]):
    status: Literal["ok", "error"] = "ok"
    data: Optional[T] = None
    meta: dict = Field(default_factory=dict)


class CreateAuditRequest(BaseModel):
    audit_id: Optional[str] = None
    customer_name: str
    period_start: date
    period_end: date
    notes: Optional[str] = None


class IngestDataRequest(BaseModel):
    file_key: str
    provider_hint: Optional[str] = None
    application: Optional[str] = None
    workload: Optional[str] = None


class SimulateRequest(BaseModel):
    seed: int
    distribution_specs: list[DistributionSpec]
    n_iterations: int = 10_000
    savings_target: Decimal = Decimal("0")
    implementation_cost: Decimal = Decimal("0")
    baseline_monthly_cost: Optional[Decimal] = None
    pricing_info: Optional[dict[str, float]] = None


class ReviewFindingRequest(BaseModel):
    review_status: Literal["REVIEWED", "APPROVED", "REJECTED"]
    reviewer_notes: Optional[str] = None


class CreateScenarioRequest(BaseModel):
    name: str
    description: str = ""
    model_overrides: dict[str, str] = Field(default_factory=dict)
    model_allocation: dict[str, dict[str, float]] = Field(default_factory=dict)
    request_volume_multiplier: float = 1.0
    input_token_multiplier: float = 1.0
    output_token_multiplier: float = 1.0
    cache_hit_rate: Optional[float] = None
    context_reduction_factor: float = 1.0
    retry_rate_target: Optional[float] = None
    failure_rate_target: Optional[float] = None
    price_overrides: dict = Field(default_factory=dict)
    depends_on: list[str] = Field(default_factory=list)


class AddPricingRequest(BaseModel):
    provider: str
    model: str
    input_token_price: Decimal
    output_token_price: Decimal
    cached_input_price: Decimal = Decimal("0")
    cached_output_price: Decimal = Decimal("0")
    request_price: Decimal = Decimal("0")
    effective_from: date
    source: Literal["official", "manual", "estimated"] = "manual"
    notes: Optional[str] = None
