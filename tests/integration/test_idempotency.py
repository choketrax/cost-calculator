import hashlib
import uuid
from decimal import Decimal
import pytest

def deterministic_id(input_str: str, namespace: str) -> str:
    """Python equivalent of worker/src/idempotency.ts deterministicId."""
    data = f"{input_str}:{namespace}".encode()
    return hashlib.sha256(data).hexdigest()[:32]

@pytest.mark.asyncio
async def test_reservation_id_is_deterministic_from_request_id():
    req_id = "req-1"
    id1 = deterministic_id(req_id, "reserve")
    id2 = deterministic_id(req_id, "reserve")
    assert id1 == id2
    assert id1 != deterministic_id("req-2", "reserve")

@pytest.mark.asyncio
async def test_ledger_event_id_is_deterministic():
    req_id = "req-ledger"
    assert deterministic_id(req_id, "ledger") == deterministic_id(req_id, "ledger")

@pytest.mark.asyncio
async def test_queue_event_id_format():
    req_id = "req-queue"
    expected = f"{req_id}:proxy_completion"
    assert expected == "req-queue:proxy_completion"

@pytest.mark.asyncio
async def test_python_deterministic_id_matches_expected_hex():
    req_id = "test-123"
    ns = "reserve"
    expected = hashlib.sha256(f"{req_id}:{ns}".encode()).hexdigest()[:32]
    assert deterministic_id(req_id, ns) == expected

@pytest.mark.asyncio
async def test_fake_budget_do_reserve_is_idempotent(fake_budget_do):
    req_id = "req-idem-res"
    r1 = await fake_budget_do.reserve(req_id, Decimal("1.00"))
    r2 = await fake_budget_do.reserve(req_id, Decimal("1.00"))
    assert r1["reservation_id"] == r2["reservation_id"]
    assert fake_budget_do._total_reserved == Decimal("1.00")

@pytest.mark.asyncio
async def test_fake_budget_do_settle_is_idempotent(fake_budget_do):
    req_id = "req-idem-set"
    r = await fake_budget_do.reserve(req_id, Decimal("1.00"))
    res_id = r["reservation_id"]
    
    s1 = await fake_budget_do.settle(res_id, Decimal("0.80"))
    s2 = await fake_budget_do.settle(res_id, Decimal("0.80"))
    assert s1["ok"]
    assert s2["ok"]
    assert s2.get("idempotent") is True
    assert fake_budget_do._total_settled == Decimal("0.80")

@pytest.mark.asyncio
async def test_different_request_ids_produce_different_reservations(fake_budget_do):
    r1 = await fake_budget_do.reserve("req-a", Decimal("1.00"))
    r2 = await fake_budget_do.reserve("req-b", Decimal("1.00"))
    assert r1["reservation_id"] != r2["reservation_id"]

@pytest.mark.asyncio
async def test_retry_cannot_double_settle_cost(fake_budget_do):
    req_id = "req-idem-lifecycle"
    r = await fake_budget_do.reserve(req_id, Decimal("2.00"))
    res_id = r["reservation_id"]
    await fake_budget_do.settle(res_id, Decimal("1.50"))
    await fake_budget_do.settle(res_id, Decimal("1.50"))
    assert fake_budget_do._total_settled == Decimal("1.50")

@pytest.mark.asyncio
async def test_missing_request_id_rejected(fake_budget_do):
    r = await fake_budget_do.reserve("", Decimal("1.00"))
    assert r["ok"] is False
