from datetime import date
from decimal import Decimal
from typing import Optional, List, Dict
from collections import defaultdict

from ..models import UsageRecord, CostBreakdown
from .registry import PricingRegistry


class CostCalculator:
    def __init__(self, registry: PricingRegistry):
        self.registry = registry
        
    def calculate_record_cost(
        self, 
        record: UsageRecord,
        pricing_date: Optional[date] = None
    ) -> Decimal:
        """Calculate the cost of a single usage record.
        
        Cost = (input_tokens / 1_000_000) * input_price
               + (output_tokens / 1_000_000) * output_price  
               + (cached_tokens / 1_000_000) * cached_input_price
               + requests * request_price
               
        Uses pricing active as of pricing_date (defaults to record.timestamp.date()).
        Returns Decimal, never float.
        """
        p_date = pricing_date or record.timestamp.date()
        pricing = self.registry.get_price(record.provider, record.model, as_of=p_date)
        
        if not pricing:
            return Decimal('0')
            
        m = Decimal('1000000')
        cost = (
            (Decimal(record.input_tokens) / m) * pricing.input_token_price +
            (Decimal(record.output_tokens) / m) * pricing.output_token_price +
            (Decimal(record.cached_tokens) / m) * pricing.cached_input_price +
            Decimal(record.requests) * pricing.request_price
        )
        return cost

    def calculate_batch(
        self,
        records: List[UsageRecord],
        pricing_date: Optional[date] = None
    ) -> List[UsageRecord]:
        """Calculate costs for all records in batch. Returns records with .cost populated."""
        if not records:
            return []
            
        for record in records:
            record.cost = self.calculate_record_cost(record, pricing_date)
        return records

    def build_cost_breakdown(self, records: List[UsageRecord]) -> CostBreakdown:
        """Aggregate records into CostBreakdown metrics.
        
        Calculates:
        - total_cost
        - cost_per_request
        - cost_per_successful_request  
        - cost_per_1m_tokens
        - cost_by_provider (dict)
        - cost_by_model (dict)
        - cost_by_application (dict)
        - cost_by_workload (dict)
        - failure_cost (cost of failed requests)
        - retry_cost (cost of retry requests)
        - total_requests, successful_requests, failed_requests
        - total_input_tokens, total_output_tokens, total_cached_tokens
        - period_start, period_end
        """
        if not records:
            # Handle empty records gracefully by returning a zeroed breakdown
            return CostBreakdown(
                total_cost=Decimal('0'),
                cost_per_request=Decimal('0'),
                cost_per_successful_request=Decimal('0'),
                cost_per_1m_tokens=Decimal('0'),
                cost_by_provider={},
                cost_by_model={},
                cost_by_application={},
                cost_by_workload={},
                failure_cost=Decimal('0'),
                retry_cost=Decimal('0'),
                total_requests=0,
                successful_requests=0,
                failed_requests=0,
                total_input_tokens=0,
                total_output_tokens=0,
                total_cached_tokens=0,
                period_start=None,
                period_end=None
            )

        total_cost = Decimal('0')
        failure_cost = Decimal('0')
        retry_cost = Decimal('0')
        
        total_requests = 0
        successful_requests = 0
        failed_requests = 0
        
        total_input_tokens = 0
        total_output_tokens = 0
        total_cached_tokens = 0
        
        cost_by_provider: Dict[str, Decimal] = defaultdict(lambda: Decimal('0'))
        cost_by_model: Dict[str, Decimal] = defaultdict(lambda: Decimal('0'))
        cost_by_application: Dict[str, Decimal] = defaultdict(lambda: Decimal('0'))
        cost_by_workload: Dict[str, Decimal] = defaultdict(lambda: Decimal('0'))
        
        period_start = None
        period_end = None
        
        for record in records:
            cost = record.cost or Decimal('0')
            total_cost += cost
            
            total_requests += record.requests
            total_input_tokens += record.input_tokens
            total_output_tokens += record.output_tokens
            total_cached_tokens += record.cached_tokens
            
            if record.status == "success":
                successful_requests += record.requests
            elif record.status == "failure":
                failed_requests += record.requests
                failure_cost += cost
            elif record.status == "retry":
                retry_cost += cost
                
            cost_by_provider[record.provider] += cost
            cost_by_model[record.model] += cost
            cost_by_application[record.application] += cost
            cost_by_workload[record.workload] += cost
            
            ts = record.timestamp
            if period_start is None or ts < period_start:
                period_start = ts
            if period_end is None or ts > period_end:
                period_end = ts
                
        cost_per_request = total_cost / Decimal(total_requests) if total_requests > 0 else Decimal('0')
        cost_per_successful_request = total_cost / Decimal(successful_requests) if successful_requests > 0 else Decimal('0')
        
        total_tokens = total_input_tokens + total_output_tokens + total_cached_tokens
        cost_per_1m_tokens = (total_cost / Decimal(total_tokens)) * Decimal('1000000') if total_tokens > 0 else Decimal('0')
        
        return CostBreakdown(
            total_cost=total_cost,
            cost_per_request=cost_per_request,
            cost_per_successful_request=cost_per_successful_request,
            cost_per_1m_tokens=cost_per_1m_tokens,
            cost_by_provider=dict(cost_by_provider),
            cost_by_model=dict(cost_by_model),
            cost_by_application=dict(cost_by_application),
            cost_by_workload=dict(cost_by_workload),
            failure_cost=failure_cost,
            retry_cost=retry_cost,
            total_requests=total_requests,
            successful_requests=successful_requests,
            failed_requests=failed_requests,
            total_input_tokens=total_input_tokens,
            total_output_tokens=total_output_tokens,
            total_cached_tokens=total_cached_tokens,
            period_start=period_start,
            period_end=period_end
        )
