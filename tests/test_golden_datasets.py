import pytest
from core.models import UsageRecord
from core.waste.rules.spend_anomalies import VolumeSpikeRule, CostPerOutcomeRule
from core.waste.rules.execution import ZeroOutputTokenRule
from core.ingest.quality import DataQualityGate
from decimal import Decimal

def test_healthy_company_no_findings():
    """Ensures a perfectly healthy company generates zero waste findings (no false positives)."""
    # Create healthy dummy records
    records = [
        UsageRecord(
            audit_id="audit_healthy_1",
            ServiceProviderName="OpenAI",
            ResourceName="gpt-4o-mini",
            BilledCost="0.01",
            ChargePeriodStart="2026-09-01T10:00:00Z",
            ChargePeriodEnd="2026-09-01T10:00:01Z",
            ai_model="gpt-4o-mini",
            ai_workflow="customer_support",
            ai_use_case="ticket_resolution",
            ai_input_tokens=100,
            ai_output_tokens=50,
            ai_cached_tokens=80,
            ai_status="success",
            ChargeCategory="Usage",
            SkuPriceId="price-123",
            PricingCategory="Standard"
        ) for _ in range(100)
    ]
    
    # Run Data Quality Gate
    gate = DataQualityGate()
    score = gate.evaluate(records, "audit_healthy_1")
    assert score.overall_confidence > 0.8
    
    # Run rules
    rules = [ZeroOutputTokenRule(catalog=None)]
    all_findings = []
    for rule in rules:
        result = rule.evaluate(records, "audit_healthy_1")
        assert result.status == "PASS" or result.status == "NOT_EVALUATED"
        all_findings.extend(result.findings)
        
    # Assert zero false positives
    assert len(all_findings) == 0

def test_bad_company_zero_output_waste():
    """Ensures that repeated failed requests with zero output tokens trigger a finding."""
    # Create bad dummy records
    records = [
        UsageRecord(
            audit_id="audit_bad_1",
            ServiceProviderName="OpenAI",
            ResourceName="gpt-4o",
            BilledCost="0.50",
            ChargePeriodStart="2026-09-01T10:00:00Z",
            ChargePeriodEnd="2026-09-01T10:00:01Z",
            ai_model="gpt-4o",
            ai_workflow="complex_agent",
            ai_use_case="data_extraction",
            ai_input_tokens=100000,
            ai_output_tokens=0,
            ai_cached_tokens=0,
            ai_status="failure"
        ) for _ in range(10)
    ]
    
    rules = [ZeroOutputTokenRule(catalog=None)]
    all_findings = []
    for rule in rules:
        result = rule.evaluate(records, "audit_bad_1")
        if result.status == "FINDING":
            all_findings.extend(result.findings)
        
    assert len(all_findings) == 1
    finding = all_findings[0]
    assert finding.rule_id == "EXECUTION_ZERO_OUTPUT"
    assert finding.savings_p50 == 5.0  # 10 records * 0.50

def test_overlapping_savings_company():
    """Ensures that two individually correct findings do not create an incorrect combined savings number."""
    # We test the SavingsDeduplicator logic
    from core.savings.overlap import SavingsDeduplicator
    from core.models import Finding
    
    f1 = Finding(
        audit_id="test",
        rule_id="R1",
        category="Token Efficiency",
        title="Prompt Bloat",
        description="",
        evidence={},
        current_cost=10000,
        projected_cost=8000,
        monthly_savings=2000,
        annual_savings=24000,
        savings_p50=Decimal("2000"),
        confidence=1.0,
        affected_workloads=["workload_A"]
    )
    
    f2 = Finding(
        audit_id="test",
        rule_id="R2",
        category="Model Routing",
        title="Smaller Model",
        description="",
        evidence={},
        current_cost=10000,
        projected_cost=7000,
        monthly_savings=3000,
        annual_savings=36000,
        savings_p50=Decimal("3000"),
        confidence=1.0,
        affected_workloads=["workload_A"]
    )
    
    deduper = SavingsDeduplicator()
    gross, adj, net = deduper.calculate_net_savings([f1, f2])
    
    assert gross == Decimal("5000")
    # Using our simple heuristic: 30% of the smaller finding (2000 * 0.30 = 600)
    assert adj == Decimal("600")
    assert net == Decimal("4400")

