import sys
import os
from datetime import datetime
from pathlib import Path
from decimal import Decimal

# Add current dir to path to import core
sys.path.append(os.getcwd())

from core.models import UsageRecord
from core.pricing.registry import PricingRegistry
from core.pricing.calculator import CostCalculator

pricing_data_path = Path("core/pricing/data/pricing_v1.json")
registry = PricingRegistry(pricing_data_path)
registry.load()

calc = CostCalculator(registry)

record = UsageRecord(
    record_id="123",
    audit_id="abc",
    timestamp=datetime.fromisoformat("2025-01-15T10:00:00Z"),
    provider="openai",
    model="gpt-4o",
    application="my-app",
    workload="chat",
    input_tokens=1500,
    output_tokens=350,
    cached_tokens=0,
    requests=1,
    status="success"
)

# Test the exact call that happens in the API
cost = calc.calculate_record_cost(record)
print(f"Record cost: {cost}")

breakdown = calc.build_cost_breakdown([record])
print(f"Total cost in breakdown: {breakdown.total_cost}")
print(f"Cost by model: {breakdown.cost_by_model}")
