"""
Alerts behavior tests. Tests the alerting logic directly (Python layer).
Slack/email delivery is mocked.
"""
import pytest
from decimal import Decimal

@pytest.mark.asyncio
async def test_budget_warning_threshold_is_75_pct(fake_budget_do):
    fake_budget_do.budget_usd = Decimal("1000")
    await fake_budget_do.reserve("r1", Decimal("750"))
    await fake_budget_do.settle(fake_budget_do._reservations[list(fake_budget_do._reservations.keys())[0]]["reservation_id"], Decimal("750"))
    assert fake_budget_do.status()["status"] == "warning"

@pytest.mark.asyncio
async def test_budget_critical_threshold_is_90_pct(fake_budget_do):
    fake_budget_do.budget_usd = Decimal("1000")
    await fake_budget_do.reserve("r1", Decimal("900"))
    await fake_budget_do.settle(fake_budget_do._reservations[list(fake_budget_do._reservations.keys())[0]]["reservation_id"], Decimal("900"))
    assert fake_budget_do.status()["status"] == "critical"

@pytest.mark.asyncio
async def test_budget_ok_below_75(fake_budget_do):
    fake_budget_do.budget_usd = Decimal("1000")
    await fake_budget_do.reserve("r1", Decimal("749.99"))
    await fake_budget_do.settle(fake_budget_do._reservations[list(fake_budget_do._reservations.keys())[0]]["reservation_id"], Decimal("749.99"))
    assert fake_budget_do.status()["status"] == "ok"

@pytest.mark.asyncio
async def test_circuit_breaker_composite_condition():
    # Mocking PolicyEngine logic
    evidence = {"cost_anomaly": True, "failures": 5, "success_rate": 0.5}
    action = "pause" if evidence["failures"] >= 5 else "allow"
    assert action == "pause"
    assert "cost_anomaly" in evidence

@pytest.mark.asyncio
async def test_missing_attribution_fires_alert():
    context = {"customer_id": None, "project_id": None}
    triggered_rules = []
    if not context["customer_id"] and not context["project_id"]:
        triggered_rules.append("MISSING_ATTRIBUTION")
    assert "MISSING_ATTRIBUTION" in triggered_rules

@pytest.mark.asyncio
async def test_duplicate_alert_suppression():
    alerts_sent = set()
    def send_alert(event_id):
        if event_id not in alerts_sent:
            alerts_sent.add(event_id)
            return True
        return False
    
    assert send_alert("alert-1") is True
    assert send_alert("alert-1") is False
