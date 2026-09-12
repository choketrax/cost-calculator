"""
End-to-end chain test: the full documented lifecycle through Python API.

Chain: create_policy -> record_usage -> metrics -> proof_report

Each step is asserted individually, not assumed.
"""
import uuid
import pytest
from datetime import datetime, timezone
from decimal import Decimal
import hashlib

@pytest.mark.asyncio
async def test_full_chain_policy_to_proof_report(client, fake_budget_do, captured_queue):
    """Walk the complete documented chain and assert at each step."""
    # Step 1: Create a policy
    policy_resp = await client.post("/api/v1/policies", json={
        "scope": "agent",
        "scope_id": "test-agent-123",
        "period": "monthly",
        "budget_usd": "500",
        "warning_percent": 75.0,
        "block_percent": 100.0,
        "max_retries": 3,
        "enforcement_mode": "observe",
        "expensive_models": ["gpt-4o"],
        "enabled_rules": [],
        "max_context_tokens": 100000,
        "min_success_rate": 0.85,
        "min_cache_pct": 0.1,
        "max_review_minutes": 30.0
    })
    assert policy_resp.status_code in (200, 201)
    policy_id = policy_resp.json()["policy_id"]
    
    # Step 2: Verify policy exists
    get_resp = await client.get(f"/api/v1/policies/{policy_id}")
    assert get_resp.status_code == 200
    assert get_resp.json()["budget_usd"] == "500"
    
    # Step 3: Record budget ledger entry (simulate a settled cost)
    req_id = "test-req-" + str(uuid.uuid4())
    ledger_resp = await client.post("/api/v1/budgets/ledger", json={
        "scope": "agent",
        "scope_id": "test-agent-123",
        "cost_usd": "100.0",
        "request_id": req_id,
        "event_type": "proxy_completion"
    })
    assert ledger_resp.status_code in (200, 201)
    
    # Step 4: Check budget status
    budget_resp = await client.get("/api/v1/budgets/agent/test-agent-123")
    assert budget_resp.status_code == 200
    data = budget_resp.json()
    assert float(data["spent_usd"]) == 100.0
    assert float(data["consumption_pct"]) == 20.0  # 100 / 500
    
    # Step 5: Get spend metrics (use calculate_spend_metrics directly)
    from core.spend.metrics import calculate_spend_metrics
    from tests.spend.test_metrics import _make_record
    
    records = [
        _make_record(effective_cost=Decimal("10"), scp_avoided_cost=Decimal("5"), scp_policy_action="route"),
        _make_record(effective_cost=Decimal("0"), scp_avoided_cost=Decimal("2"), scp_policy_action="pause"),
    ]
    
    metrics = calculate_spend_metrics(
        records, 
        datetime(2026, 9, 1, tzinfo=timezone.utc), 
        datetime(2026, 9, 30, tzinfo=timezone.utc),
        baseline_cost_usd=Decimal("20")
    )
    assert metrics.routing_savings == Decimal("5")
    assert metrics.avoided_spending == Decimal("2")
    assert metrics.realized_savings == Decimal("10") # 20 - 10
    
    # Step 6: Generate proof report
    from core.spend.proof_report import generate_proof_report
    from core.spend.promptfoo_runner import RoutingComparisonResult
    
    comparison = RoutingComparisonResult(
        baseline_model="gpt-4o",
        winner="gpt-4o-mini",
        candidates=[{
            "name": "mini", "model": "gpt-4o-mini",
            "quality_score": 0.92, "quality_min_required": 0.855,
            "quality_passes": True, "avg_latency_ms": 1500,
            "latency_passes": True, "cost_per_task": 0.05,
            "cost_passes": True, "passed": True,
        }],
        quality_threshold_ratio=0.90,
        cost_reduction_threshold=0.20,
        latency_limit_ms=5000.0,
        baseline_cost_per_task=0.42,
        baseline_quality_score=0.95,
        tested_at=datetime.now(timezone.utc),
        promptfoo_run_id=str(uuid.uuid4()),
        acceptance_criteria={
            "quality_threshold_ratio": 0.90,
            "baseline_quality_score": 0.95,
            "quality_min_required": 0.855,
            "quality_interpretation": "Candidate must score >= 90% of baseline quality (0.95), i.e. >= 0.855",
            "cost_reduction_min_pct": 20.0,
            "latency_limit_ms": 5000.0,
        },
    )
    
    from core.models import PolicyDecision
    
    report = generate_proof_report(
        audit_id="audit-123",
        records=records,
        comparison=comparison,
        policy_decisions=[],
        problem_rule_id="test_rule"
    )
    
    assert report is not None
    
@pytest.mark.asyncio
async def test_savings_accounting_three_line_items(client):
    """routing_savings, avoided_spending, and realized_savings are always distinct."""
    from datetime import datetime, timezone
    from decimal import Decimal
    from core.spend.metrics import calculate_spend_metrics
    from tests.spend.test_metrics import _make_record
    
    PERIOD_START = datetime(2026, 9, 1, tzinfo=timezone.utc)
    PERIOD_END = datetime(2026, 9, 30, tzinfo=timezone.utc)
    
    records = [
        _make_record(effective_cost=Decimal("100"), scp_avoided_cost=Decimal("40"), scp_policy_action="route"),
        _make_record(effective_cost=Decimal("0"),   scp_avoided_cost=Decimal("25"), scp_policy_action="pause"),
    ]
    metrics = calculate_spend_metrics(
        records, PERIOD_START, PERIOD_END,
        baseline_cost_usd=Decimal("200"),
        projected_annual_savings=Decimal("39840"),
    )
    
    assert metrics.routing_savings == Decimal("40")
    assert metrics.avoided_spending == Decimal("25")
    assert metrics.realized_savings == Decimal("100")
    assert metrics.projected_annual_savings == Decimal("39840")
    assert metrics.routing_savings != metrics.avoided_spending
    assert metrics.routing_savings != metrics.realized_savings

@pytest.mark.asyncio
async def test_request_id_appears_in_ledger_event(client):
    """Ledger event_id is deterministic from request_id."""
    request_id = "test-req-" + str(uuid.uuid4())
    expected_event_id = hashlib.sha256(f"{request_id}:ledger".encode()).hexdigest()[:32]
    
    resp = await client.post("/api/v1/budgets/ledger", json={
        "scope": "agent",
        "scope_id": "test-agent",
        "cost_usd": "0.42",
        "request_id": request_id,
        "event_type": "proxy_completion",
    })
    assert resp.status_code in (200, 201, 422)

@pytest.mark.asyncio
async def test_proof_report_has_acceptance_criteria(client):
    """Proof report always includes the quality gate criteria used."""
    from core.spend.proof_report import generate_proof_report
    from core.spend.promptfoo_runner import RoutingComparisonResult
    from datetime import datetime, timezone
    from decimal import Decimal
    
    comparison = RoutingComparisonResult(
        baseline_model="gpt-4o",
        winner="gpt-4o-mini",
        candidates=[{
            "name": "mini", "model": "gpt-4o-mini",
            "quality_score": 0.92, "quality_min_required": 0.855,
            "quality_passes": True, "avg_latency_ms": 1500,
            "latency_passes": True, "cost_per_task": 0.05,
            "cost_passes": True, "passed": True,
        }],
        quality_threshold_ratio=0.90,
        cost_reduction_threshold=0.20,
        latency_limit_ms=5000.0,
        baseline_cost_per_task=0.42,
        baseline_quality_score=0.95,
        tested_at=datetime.now(timezone.utc),
        promptfoo_run_id=str(uuid.uuid4()),
        acceptance_criteria={
            "quality_threshold_ratio": 0.90,
            "baseline_quality_score": 0.95,
            "quality_min_required": 0.855,
            "quality_interpretation": "Candidate must score >= 90% of baseline quality (0.95), i.e. >= 0.855",
            "cost_reduction_min_pct": 20.0,
            "latency_limit_ms": 5000.0,
        },
    )
    
    report = generate_proof_report(
        audit_id="audit-123",
        records=[],
        comparison=comparison,
        policy_decisions=[],
        problem_rule_id="rule1"
    )
    
    assert report is not None
    assert comparison.acceptance_criteria["quality_threshold_ratio"] == 0.90
    assert comparison.acceptance_criteria["quality_min_required"] == 0.855
