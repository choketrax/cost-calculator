import pytest
from pydantic import ValidationError
from decimal import Decimal
from core.models import UsageRecord

def test_focus_usage_requires_pricing_category():
    # Valid - Usage with pricing category
    r = UsageRecord(
        audit_id="a1",
        ServiceProviderName="OpenAI",
        ResourceName="gpt-4",
        ChargePeriodStart="2026-09-01T10:00:00Z",
        ChargePeriodEnd="2026-09-01T10:00:01Z",
        ai_model="gpt-4",
        ChargeCategory="Usage",
        SkuPriceId="price-123",
        PricingCategory="Standard"
    )
    assert r.pricing_category == "Standard"
    
    # Invalid - Usage + SkuPriceId but missing PricingCategory
    with pytest.raises(ValidationError) as exc:
        UsageRecord(
            audit_id="a1",
            ServiceProviderName="OpenAI",
            ResourceName="gpt-4",
            ChargePeriodStart="2026-09-01T10:00:00Z",
            ChargePeriodEnd="2026-09-01T10:00:01Z",
            ai_model="gpt-4",
            ChargeCategory="Usage",
            SkuPriceId="price-123",
            PricingCategory=None
        )
    assert "PricingCategory is required" in str(exc.value)

def test_focus_tax_requires_null_pricing_category():
    # Valid - Tax without pricing category
    r = UsageRecord(
        audit_id="a1",
        ServiceProviderName="OpenAI",
        ResourceName="Tax",
        ChargePeriodStart="2026-09-01T10:00:00Z",
        ChargePeriodEnd="2026-09-01T10:00:01Z",
        ai_model="none",
        ChargeCategory="Tax",
        PricingCategory=None
    )
    assert r.pricing_category is None
    
    # Invalid - Tax with pricing category
    with pytest.raises(ValidationError) as exc:
        UsageRecord(
            audit_id="a1",
            ServiceProviderName="OpenAI",
            ResourceName="Tax",
            ChargePeriodStart="2026-09-01T10:00:00Z",
            ChargePeriodEnd="2026-09-01T10:00:01Z",
            ai_model="none",
            ChargeCategory="Tax",
            PricingCategory="Standard"
        )
    assert "PricingCategory must be null" in str(exc.value)

def test_charge_category_enum():
    with pytest.raises(ValidationError):
        UsageRecord(
            audit_id="a1",
            ServiceProviderName="OpenAI",
            ResourceName="gpt-4",
            ChargePeriodStart="2026-09-01T10:00:00Z",
            ChargePeriodEnd="2026-09-01T10:00:01Z",
            ai_model="gpt-4",
            ChargeCategory="InvalidCategory"
        )
