import sys
import os
from datetime import date
from pathlib import Path

sys.path.append(os.getcwd())

from core.pricing.registry import PricingRegistry

registry = PricingRegistry(Path("core/pricing/data/pricing_v1.json"))
registry.load()

print("Num entries:", len(registry.list_entries()))

p = registry.get_price("openai", "gpt-4o", as_of=date(2025, 1, 15))
print("openai gpt-4o 2025-01-15:", p)

p2 = registry.get_price("anthropic", "claude-3-5-sonnet-20241022", as_of=date(2025, 1, 15))
print("anthropic claude-3-5-sonnet-20241022 2025-01-15:", p2)
