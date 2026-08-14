from decimal import Decimal
from datetime import datetime, timezone
from typing import Any, Optional
from ..models import UsageRecord, ScenarioParameters, ScenarioResult
import copy

class ScenarioEngine:
    def __init__(self, pricing_registry: Any):
        self.pricing_registry = pricing_registry
    
    def calculate_scenario(
        self,
        records: list[UsageRecord],
        scenario: ScenarioParameters,
        baseline_cost: Optional[Decimal] = None,
    ) -> ScenarioResult:
        """Apply scenario parameters to records and calculate costs.
        
        Dependency ordering (CRITICAL — prevents double-counting):
        1. Apply context_reduction_factor to input_tokens
        2. Apply model_overrides / model_allocation  
        3. Apply cache_hit_rate (on ALREADY REDUCED tokens)
        4. Apply retry_rate_target / failure_rate_target
        5. Apply request_volume_multiplier
        6. Recalculate all costs with modified records
        
        Each step records a note in calculation_notes for traceability.
        """
        working_records = []
        for r in records:
            working_records.append(r.model_copy() if hasattr(r, 'model_copy') else copy.deepcopy(r))
            
        if baseline_cost is None:
            baseline_cost = sum((r.cost for r in working_records), Decimal(0))
            
        calculation_notes = []
        
        # 1. Apply context_reduction_factor
        if scenario.context_reduction_factor != 1.0:
            working_records = self._apply_context_reduction(working_records, scenario.context_reduction_factor)
            calculation_notes.append(f"Applied context reduction factor {scenario.context_reduction_factor}")
            
        # 2. Apply model_overrides / model_allocation
        if scenario.model_overrides or scenario.model_allocation:
            working_records = self._apply_model_routing(working_records, scenario)
            calculation_notes.append("Applied model overrides and allocations")
            
        # 3. Apply cache_hit_rate
        if scenario.cache_hit_rate is not None:
            working_records = self._apply_caching(working_records, scenario.cache_hit_rate)
            calculation_notes.append(f"Applied target cache hit rate {scenario.cache_hit_rate}")
            
        # 4. Apply retry/failure targets
        if scenario.retry_rate_target is not None or scenario.failure_rate_target is not None:
            working_records = self._apply_retry_reduction(
                working_records, 
                scenario.retry_rate_target, 
                scenario.failure_rate_target
            )
            calculation_notes.append("Applied retry/failure reductions")
            
        # 5. Apply request_volume_multiplier
        if scenario.request_volume_multiplier != 1.0:
            working_records = self._apply_volume_multiplier(working_records, scenario.request_volume_multiplier)
            calculation_notes.append(f"Applied request volume multiplier {scenario.request_volume_multiplier}")
            
        # 6. Recalculate costs
        working_records = self._recalculate_costs(working_records, scenario.price_overrides)
        scenario_cost = sum((r.cost for r in working_records), Decimal(0))
        
        monthly_savings = baseline_cost - scenario_cost
        annual_savings = monthly_savings * 12
        percentage_reduction = float(monthly_savings / baseline_cost * 100) if baseline_cost > 0 else 0.0
        
        return ScenarioResult(
            scenario_id=scenario.scenario_id,
            audit_id=scenario.audit_id,
            baseline_cost=baseline_cost,
            scenario_cost=scenario_cost,
            monthly_savings=monthly_savings,
            annual_savings=annual_savings,
            percentage_reduction=percentage_reduction,
            applied_findings=scenario.depends_on,
            calculation_notes=calculation_notes,
            created_at=datetime.now(timezone.utc)
        )
    
    def _apply_context_reduction(self, records: list[UsageRecord], factor: float) -> list[UsageRecord]:
        """Reduce input tokens by factor. E.g., factor=0.8 = 20% reduction."""
        for r in records:
            r.input_tokens = int(r.input_tokens * factor)
        return records
    
    def _apply_model_routing(self, records: list[UsageRecord], scenario: ScenarioParameters) -> list[UsageRecord]:
        """Apply model overrides and allocation splits."""
        new_records = []
        for r in records:
            if scenario.model_overrides and r.model in scenario.model_overrides:
                r.model = scenario.model_overrides[r.model]
                new_records.append(r)
            elif scenario.model_allocation and r.workload in scenario.model_allocation:
                allocation = scenario.model_allocation[r.workload]
                for model_name, pct in allocation.items():
                    if pct > 0:
                        split_r = r.model_copy() if hasattr(r, 'model_copy') else copy.deepcopy(r)
                        split_r.model = model_name
                        split_r.requests = max(1, int(split_r.requests * pct))
                        split_r.input_tokens = int(split_r.input_tokens * pct)
                        split_r.output_tokens = int(split_r.output_tokens * pct)
                        split_r.cached_tokens = int(split_r.cached_tokens * pct)
                        new_records.append(split_r)
            else:
                new_records.append(r)
        return new_records
    
    def _apply_caching(self, records: list[UsageRecord], cache_hit_rate: float) -> list[UsageRecord]:
        """Convert cache_hit_rate fraction of input tokens to cached tokens."""
        for r in records:
            if r.input_tokens > 0:
                r.cached_tokens = int(r.input_tokens * cache_hit_rate)
        return records
    
    def _apply_retry_reduction(
        self, 
        records: list[UsageRecord], 
        retry_rate_target: Optional[float],
        failure_rate_target: Optional[float]
    ) -> list[UsageRecord]:
        """Reduce retries toward target rate."""
        for r in records:
            if retry_rate_target is not None and r.retries > 0:
                r.retries = int(r.retries * retry_rate_target)
        return records
        
    def _apply_volume_multiplier(self, records: list[UsageRecord], multiplier: float) -> list[UsageRecord]:
        for r in records:
            r.requests = int(r.requests * multiplier)
            r.input_tokens = int(r.input_tokens * multiplier)
            r.output_tokens = int(r.output_tokens * multiplier)
            r.cached_tokens = int(r.cached_tokens * multiplier)
        return records
    
    def _recalculate_costs(self, records: list[UsageRecord], price_overrides: dict) -> list[UsageRecord]:
        """Recalculate cost for each record using current pricing."""
        for r in records:
            provider = r.provider
            model = r.model
            
            try:
                pricing = self.pricing_registry.get_price(provider, model)
                input_price = pricing.input_token_price
                output_price = pricing.output_token_price
                cached_price = getattr(pricing, 'cached_input_price', input_price * Decimal("0.5"))
                
                if model in price_overrides:
                    overrides = price_overrides[model]
                    if 'input_token_price' in overrides:
                        input_price = Decimal(overrides['input_token_price'])
                    if 'output_token_price' in overrides:
                        output_price = Decimal(overrides['output_token_price'])
                    if 'cached_input_price' in overrides:
                        cached_price = Decimal(overrides['cached_input_price'])
                
                uncached_inputs = max(0, r.input_tokens - r.cached_tokens)
                
                cost = (
                    Decimal(uncached_inputs) * input_price / Decimal(1_000_000) +
                    Decimal(r.cached_tokens) * cached_price / Decimal(1_000_000) +
                    Decimal(r.output_tokens) * output_price / Decimal(1_000_000)
                )
                
                r.cost = cost * Decimal(1 + r.retries)
            except Exception:
                pass
                
        return records
