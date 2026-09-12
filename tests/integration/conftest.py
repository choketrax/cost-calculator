"""
Integration test fixtures for the Spend Control Pack.

Provides:
- async_client: AsyncClient wrapping the FastAPI app with mocked dependencies
- fake_budget_do: In-memory BudgetDO equivalent for Python-layer testing
- captured_queue: List that accumulates queue events for assertion
- fake_r2: Dict-based R2 mock
"""
import asyncio
from decimal import Decimal
from typing import AsyncGenerator
import uuid
import hashlib

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

@pytest.fixture
def fake_budget_do():
    class FakeBudgetDO:
        """In-memory BudgetDO for Python integration testing.
        Implements the same idempotency contract as the TypeScript DO."""
        
        def __init__(self, budget_usd: Decimal = Decimal("1000"), period: str = "2026-09"):
            self.budget_usd = budget_usd
            self.period = period
            self._reservations: dict[str, dict] = {}  # reservation_id -> row
            self._total_reserved = Decimal("0")
            self._total_settled = Decimal("0")
            self._lock = asyncio.Lock()  # simulates DO serialization
        
        async def reserve(self, request_id: str, amount_usd: Decimal) -> dict:
            if not request_id:
                return {"ok": False, "reason": "missing_request_id"}
            async with self._lock:
                reservation_id = hashlib.sha256(f"{request_id}:reserve".encode()).hexdigest()[:32]
                
                if reservation_id in self._reservations:
                    existing = self._reservations[reservation_id]
                    return {"ok": True, "idempotent": True, "reservation_id": reservation_id,
                            "reason": f"already_{existing['status']}"}
                
                available = self.budget_usd - self._total_reserved - self._total_settled
                if self.budget_usd > 0 and available - amount_usd < 0:
                    return {"ok": False, "reason": "budget_exceeded",
                            "available_before": float(available), "budget_usd": float(self.budget_usd)}
                
                self._reservations[reservation_id] = {
                    "reservation_id": reservation_id,
                    "request_id": request_id,
                    "reserved_usd": amount_usd,
                    "status": "active",
                }
                self._total_reserved += amount_usd
                
                return {"ok": True, "reservation_id": reservation_id,
                        "available_before": float(available),
                        "available_after": float(available - amount_usd)}
        
        async def settle(self, reservation_id: str, actual_usd: Decimal) -> dict:
            async with self._lock:
                r = self._reservations.get(reservation_id)
                if not r:
                    return {"ok": False, "reason": "reservation_not_found"}
                if r["status"] == "settled":
                    return {"ok": True, "idempotent": True, "reason": "already_settled"}
                if r["status"] == "released":
                    return {"ok": False, "reason": "already_released"}
                
                excess = r["reserved_usd"] - actual_usd
                self._total_reserved -= r["reserved_usd"]
                self._total_settled += actual_usd
                r["status"] = "settled"
                r["actual_usd"] = actual_usd
                return {"ok": True, "released_excess": float(excess)}
        
        async def release(self, reservation_id: str) -> dict:
            async with self._lock:
                r = self._reservations.get(reservation_id)
                if not r:
                    return {"ok": False, "reason": "reservation_not_found"}
                if r["status"] == "released":
                    return {"ok": True, "idempotent": True, "reason": "already_released"}
                if r["status"] == "settled":
                    return {"ok": False, "reason": "already_settled"}
                
                self._total_reserved -= r["reserved_usd"]
                r["status"] = "released"
                return {"ok": True}
        
        def status(self) -> dict:
            available = self.budget_usd - self._total_reserved - self._total_settled
            spent_pct = float((self._total_reserved + self._total_settled) / self.budget_usd * 100) \
                if self.budget_usd > 0 else 0.0
            return {
                "budget_usd": float(self.budget_usd),
                "reserved_usd": float(self._total_reserved),
                "settled_usd": float(self._total_settled),
                "available_usd": float(available),
                "consumption_pct": spent_pct,
                "status": "ok" if spent_pct < 75 else ("warning" if spent_pct < 90 else "critical"),
            }
            
        async def run_alarm(self):
            async with self._lock:
                for r in self._reservations.values():
                    if r["status"] == "active":
                        self._total_reserved -= r["reserved_usd"]
                        r["status"] = "released"

    return FakeBudgetDO()

@pytest.fixture
def captured_queue() -> list[dict]:
    """In-memory queue. Integration tests assert on events appended here."""
    return []

class R2Mock(dict):
    pass

@pytest.fixture
def fake_r2() -> R2Mock:
    """In-memory R2 bucket. Keys are object paths, values are bytes."""
    return R2Mock()

@pytest_asyncio.fixture
async def test_app(fake_budget_do, captured_queue, fake_r2) -> AsyncGenerator[FastAPI, None]:
    """FastAPI app with all external dependencies mocked."""
    from contextlib import asynccontextmanager
    from fastapi import FastAPI
    from api.routes import policies, budgets, spend, reports
    try:
        from api.routes import routing
    except ImportError:
        routing = None
    
    # Minimal in-memory repo
    class InMemoryRepo:
        def __init__(self, conn):
            self._conn = conn
        
        async def execute_raw(self, query: str, params=None):
            """Execute a raw SQL query against the in-memory SQLite db."""
            async with self._conn.execute(query, params or []) as cur:
                rows = await cur.fetchall()
                if rows:
                    cols = [d[0] for d in cur.description]
                    return [{c: r[i] for i, c in enumerate(cols)} for r in rows]
                return []
        
        async def execute_write(self, query: str, params=None):
            await self._conn.execute(query, params or [])
            await self._conn.commit()
    
    class FakeFileStorage:
        def __init__(self, store):
            self._store = store
        async def put(self, key: str, data: bytes, content_type: str = "application/octet-stream"):
            if getattr(self._store, "raise_on_put", False):
                raise RuntimeError("Failed to write to R2")
            self._store[key] = data
        async def get(self, key: str) -> bytes | None:
            return self._store.get(key)
    
    @asynccontextmanager
    async def test_lifespan(app: FastAPI):
        # Set up in-memory SQLite with full schema
        conn = await aiosqlite.connect(':memory:')
        conn.row_factory = aiosqlite.Row
        
        # Apply schemas
        import pathlib
        root = pathlib.Path('C:/Users/chief/.gemini/antigravity/scratch/ai-cost-auditor')
        for schema_file in ['schema.sql', 'schema_scp.sql']:
            schema = (root / schema_file).read_text(encoding='utf-8').lstrip('\ufeff')
            # Split on semicolons and execute each statement
            for stmt in schema.split(';'):
                stmt = stmt.strip()
                if stmt:
                    try:
                        await conn.execute(stmt)
                    except Exception as e:
                        print(f"Schema execution failed: {e} for stmt: {stmt[:50]}")
        await conn.commit()
        
        app.state.repo = InMemoryRepo(conn)
        app.state.file_storage = FakeFileStorage(fake_r2)
        app.state.budget_do = fake_budget_do
        app.state.queue = captured_queue
        
        # Minimal settings stub
        class FakeSettings:
            app_version = "test"
            storage_backend = "sqlite_test"
            log_level = "WARNING"
        app.state.settings = FakeSettings()
        
        # Minimal pricing registry stub
        class FakePricingRegistry:
            def list_entries(self): return []
            def get_price(self, *a, **kw): return None
        app.state.pricing_registry = FakePricingRegistry()
        
        yield
        await conn.close()
    
    test_app = FastAPI(lifespan=test_lifespan)
    # Include SCP routes only (the ones we're testing)
    test_app.include_router(policies.router)
    test_app.include_router(budgets.router)
    test_app.include_router(spend.router)
    if routing:
        test_app.include_router(routing.router)
    test_app.include_router(reports.router)
    
    async with test_lifespan(test_app):
        yield test_app

@pytest_asyncio.fixture
async def client(test_app) -> AsyncGenerator[AsyncClient, None]:
    async with AsyncClient(
        transport=ASGITransport(app=test_app),
        base_url="http://test",
    ) as ac:
        yield ac
