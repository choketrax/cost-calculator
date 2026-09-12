"""
Concurrent request handling test.

Proves that the FakeBudgetDO's asyncio.Lock() prevents over-reservation
when 100 tasks call reserve() concurrently.

Note: The real proof of strong consistency under concurrency is in the
Vitest suite (budget_do_idempotency.test.ts) which runs against the actual
Cloudflare Durable Object runtime. This Python test validates the same
behavior contract using the FakeBudgetDO's asyncio.Lock().
"""
import asyncio
from decimal import Decimal
import pytest
import uuid

@pytest.mark.asyncio
async def test_100_concurrent_reserves_within_10_dollar_budget(fake_budget_do):
    fake_budget_do.budget_usd = Decimal("10.00")
    reqs = [str(uuid.uuid4()) for _ in range(100)]
    
    results = await asyncio.gather(*(fake_budget_do.reserve(r, Decimal("0.20")) for r in reqs))
    
    allowed = sum(1 for res in results if res["ok"])
    rejected = sum(1 for res in results if not res["ok"])
    
    assert allowed == 50
    assert rejected == 50
    assert fake_budget_do._total_reserved == Decimal("10.00")
    assert fake_budget_do._total_reserved + fake_budget_do._total_settled <= fake_budget_do.budget_usd

@pytest.mark.asyncio
async def test_concurrent_reserve_then_settle_all(fake_budget_do):
    fake_budget_do.budget_usd = Decimal("10.00")
    reqs = [str(uuid.uuid4()) for _ in range(10)]
    
    # Reserve
    res_results = await asyncio.gather(*(fake_budget_do.reserve(r, Decimal("1.00")) for r in reqs))
    assert all(r["ok"] for r in res_results)
    
    # Settle
    res_ids = [r["reservation_id"] for r in res_results]
    set_results = await asyncio.gather(*(fake_budget_do.settle(rid, Decimal("0.80")) for rid in res_ids))
    
    assert all(s["ok"] for s in set_results)
    assert fake_budget_do._total_settled == Decimal("8.00")
    assert fake_budget_do._total_reserved == Decimal("0")
    assert fake_budget_do._total_reserved + fake_budget_do._total_settled <= fake_budget_do.budget_usd

@pytest.mark.asyncio
async def test_concurrent_reserve_and_release(fake_budget_do):
    fake_budget_do.budget_usd = Decimal("10.00")
    reqs = [str(uuid.uuid4()) for _ in range(50)]
    
    # Reserve
    res_results = await asyncio.gather(*(fake_budget_do.reserve(r, Decimal("0.40")) for r in reqs))
    allowed_ids = [r["reservation_id"] for r in res_results if r["ok"]]
    
    assert len(allowed_ids) == 25
    assert fake_budget_do._total_reserved == Decimal("10.00")
    
    # Release
    rel_results = await asyncio.gather(*(fake_budget_do.release(rid) for rid in allowed_ids))
    assert all(r["ok"] for r in rel_results)
    assert fake_budget_do._total_reserved == Decimal("0")
    assert fake_budget_do._total_reserved + fake_budget_do._total_settled <= fake_budget_do.budget_usd

@pytest.mark.asyncio
async def test_no_double_counting_under_concurrent_settle(fake_budget_do):
    fake_budget_do.budget_usd = Decimal("10.00")
    r = await fake_budget_do.reserve("req-conc", Decimal("5.00"))
    res_id = r["reservation_id"]
    
    # Concurrent settle same reservation
    set_results = await asyncio.gather(*(fake_budget_do.settle(res_id, Decimal("4.00")) for _ in range(10)))
    
    assert fake_budget_do._total_settled == Decimal("4.00")
    assert fake_budget_do._total_reserved == Decimal("0")
    assert fake_budget_do._total_reserved + fake_budget_do._total_settled <= fake_budget_do.budget_usd
