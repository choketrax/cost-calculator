from pydantic import BaseModel, Field
from decimal import Decimal
from typing import Optional
from datetime import date

class PricingEntry(BaseModel):
    provider_id: str
    model_id: str
    input_token_price: Decimal  # Per 1M tokens
    output_token_price: Decimal
    cached_input_price: Decimal = Decimal("0")
    cached_output_price: Decimal = Decimal("0")
    request_price: Decimal = Decimal("0")
    effective_from: date
    effective_to: Optional[date] = None
    version: int = 1
