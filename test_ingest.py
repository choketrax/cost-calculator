import sys
import os
from decimal import Decimal
from pathlib import Path

sys.path.append(os.getcwd())

from core.ingest.dispatcher import ImporterDispatcher
from core.pricing.registry import PricingRegistry
from core.pricing.calculator import CostCalculator

data = b"""timestamp,provider,model,application,workload,input_tokens,output_tokens,cached_tokens,requests,status
2025-01-15T10:00:00Z,openai,gpt-4o,my-app,chat,1500,350,0,1,success
2025-01-15T10:05:00Z,openai,gpt-4o-mini,my-app,summarize,2000,500,200,1,success
2025-01-15T10:10:00Z,anthropic,claude-3-5-sonnet-20241022,my-app,analysis,3000,800,0,1,success
2025-01-15T10:15:00Z,openai,gpt-4o,my-app,chat,1200,300,600,1,success
2025-01-15T10:20:00Z,openai,gpt-4o,my-app,chat,1800,400,0,2,failure
"""

dispatcher = ImporterDispatcher()
records, file_hash = dispatcher.import_file(
    data=data,
    filename="test_usage.csv",
    content_type="text/csv",
    audit_id="audit123",
    provider_hint=None,
    application="unknown",
    workload="unknown"
)

print(f"Imported {len(records)} records")
print(f"First record: model={records[0].model}, date={records[0].timestamp.date()}")

registry = PricingRegistry(Path("core/pricing/data/pricing_v1.json"))
registry.load()
calc = CostCalculator(registry)

records = calc.calculate_batch(records)

for i, r in enumerate(records):
    print(f"Record {i} cost: {r.cost}")

total_cost = sum(r.cost for r in records)
print(f"Total cost: {total_cost}")
