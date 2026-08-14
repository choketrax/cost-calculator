import aiosqlite
import json
from typing import Optional, Tuple, List
from datetime import datetime, date
from decimal import Decimal
from core.models import Audit, UsageRecord, Finding, SimulationManifest
from storage.base import AuditRepository

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS audits (
    audit_id TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ingesting',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    total_records INTEGER DEFAULT 0,
    baseline_monthly_cost TEXT DEFAULT '0',
    baseline_annual_cost TEXT DEFAULT '0',
    notes TEXT
);

CREATE TABLE IF NOT EXISTS usage_records (
    record_id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    FOREIGN KEY (audit_id) REFERENCES audits(audit_id)
);

CREATE INDEX IF NOT EXISTS idx_records_audit ON usage_records(audit_id);

CREATE TABLE IF NOT EXISTS findings (
    finding_id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL,
    finding_json TEXT NOT NULL,
    FOREIGN KEY (audit_id) REFERENCES audits(audit_id)
);

CREATE INDEX IF NOT EXISTS idx_findings_audit ON findings(audit_id);

CREATE TABLE IF NOT EXISTS simulations (
    simulation_id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (audit_id) REFERENCES audits(audit_id)
);
"""

class SQLiteRepository(AuditRepository):
    def __init__(self, db_path: str):
        self.db_path = db_path
    
    async def initialize(self) -> None:
        """Create tables if they don't exist."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.executescript(SCHEMA_SQL)
            await db.commit()

    def _row_to_audit(self, row: tuple) -> Audit:
        return Audit(
            audit_id=row[0],
            customer_name=row[1],
            period_start=date.fromisoformat(row[2]),
            period_end=date.fromisoformat(row[3]),
            status=row[4],
            created_at=datetime.fromisoformat(row[5]),
            updated_at=datetime.fromisoformat(row[6]),
            total_records=row[7],
            baseline_monthly_cost=Decimal(row[8]),
            baseline_annual_cost=Decimal(row[9]),
            notes=row[10]
        )

    # Audits
    async def create_audit(self, audit: Audit) -> Audit:
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                '''INSERT INTO audits (
                    audit_id, customer_name, period_start, period_end, status,
                    created_at, updated_at, total_records, baseline_monthly_cost,
                    baseline_annual_cost, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                (
                    audit.audit_id,
                    audit.customer_name,
                    audit.period_start.isoformat(),
                    audit.period_end.isoformat(),
                    audit.status,
                    audit.created_at.isoformat(),
                    audit.updated_at.isoformat(),
                    audit.total_records,
                    str(audit.baseline_monthly_cost),
                    str(audit.baseline_annual_cost),
                    audit.notes
                )
            )
            await db.commit()
        return audit

    async def get_audit(self, audit_id: str) -> Optional[Audit]:
        async with aiosqlite.connect(self.db_path) as db:
            async with db.execute('SELECT * FROM audits WHERE audit_id = ?', (audit_id,)) as cursor:
                row = await cursor.fetchone()
                if row:
                    return self._row_to_audit(row)
        return None

    async def list_audits(self, limit: int = 50, offset: int = 0) -> List[Audit]:
        async with aiosqlite.connect(self.db_path) as db:
            async with db.execute('SELECT * FROM audits ORDER BY created_at DESC LIMIT ? OFFSET ?', (limit, offset)) as cursor:
                rows = await cursor.fetchall()
                return [self._row_to_audit(r) for r in rows]

    async def update_audit(self, audit: Audit) -> Audit:
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                '''UPDATE audits SET
                    customer_name = ?, period_start = ?, period_end = ?, status = ?,
                    updated_at = ?, total_records = ?, baseline_monthly_cost = ?,
                    baseline_annual_cost = ?, notes = ?
                WHERE audit_id = ?''',
                (
                    audit.customer_name,
                    audit.period_start.isoformat(),
                    audit.period_end.isoformat(),
                    audit.status,
                    audit.updated_at.isoformat(),
                    audit.total_records,
                    str(audit.baseline_monthly_cost),
                    str(audit.baseline_annual_cost),
                    audit.notes,
                    audit.audit_id
                )
            )
            await db.commit()
        return audit

    async def delete_audit(self, audit_id: str) -> None:
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute('DELETE FROM audits WHERE audit_id = ?', (audit_id,))
            await db.commit()

    # Usage Records
    async def save_records(self, records: List[UsageRecord]) -> int:
        if not records:
            return 0
        async with aiosqlite.connect(self.db_path) as db:
            await db.executemany(
                'INSERT INTO usage_records (record_id, audit_id, record_json) VALUES (?, ?, ?)',
                [(r.record_id, r.audit_id, r.model_dump_json()) for r in records]
            )
            await db.commit()
        return len(records)

    async def get_records(self, audit_id: str, limit: int = 1000, offset: int = 0) -> List[UsageRecord]:
        async with aiosqlite.connect(self.db_path) as db:
            async with db.execute('SELECT record_json FROM usage_records WHERE audit_id = ? LIMIT ? OFFSET ?', (audit_id, limit, offset)) as cursor:
                rows = await cursor.fetchall()
                return [UsageRecord.model_validate_json(r[0]) for r in rows]

    async def get_all_records(self, audit_id: str) -> List[UsageRecord]:
        async with aiosqlite.connect(self.db_path) as db:
            async with db.execute('SELECT record_json FROM usage_records WHERE audit_id = ?', (audit_id,)) as cursor:
                rows = await cursor.fetchall()
                return [UsageRecord.model_validate_json(r[0]) for r in rows]

    async def delete_records(self, audit_id: str) -> int:
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute('DELETE FROM usage_records WHERE audit_id = ?', (audit_id,))
            await db.commit()
            return cursor.rowcount

    # Findings
    async def save_finding(self, finding: Finding) -> Finding:
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                'INSERT INTO findings (finding_id, audit_id, finding_json) VALUES (?, ?, ?)',
                (finding.finding_id, finding.audit_id, finding.model_dump_json())
            )
            await db.commit()
        return finding

    async def get_findings(self, audit_id: str) -> List[Finding]:
        async with aiosqlite.connect(self.db_path) as db:
            async with db.execute('SELECT finding_json FROM findings WHERE audit_id = ?', (audit_id,)) as cursor:
                rows = await cursor.fetchall()
                return [Finding.model_validate_json(r[0]) for r in rows]

    async def get_finding(self, finding_id: str) -> Optional[Finding]:
        async with aiosqlite.connect(self.db_path) as db:
            async with db.execute('SELECT finding_json FROM findings WHERE finding_id = ?', (finding_id,)) as cursor:
                row = await cursor.fetchone()
                if row:
                    return Finding.model_validate_json(row[0])
        return None

    async def update_finding(self, finding: Finding) -> Finding:
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                'UPDATE findings SET finding_json = ? WHERE finding_id = ?',
                (finding.model_dump_json(), finding.finding_id)
            )
            await db.commit()
        return finding

    async def delete_findings(self, audit_id: str) -> int:
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute('DELETE FROM findings WHERE audit_id = ?', (audit_id,))
            await db.commit()
            return cursor.rowcount

    # Simulations
    async def save_simulation(self, manifest: SimulationManifest, result_json: str) -> None:
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                'INSERT INTO simulations (simulation_id, audit_id, manifest_json, result_json, created_at) VALUES (?, ?, ?, ?, ?)',
                (manifest.simulation_id, manifest.audit_id, manifest.model_dump_json(), result_json, datetime.utcnow().isoformat())
            )
            await db.commit()

    async def get_simulation(self, simulation_id: str) -> Optional[Tuple[SimulationManifest, str]]:
        async with aiosqlite.connect(self.db_path) as db:
            async with db.execute('SELECT manifest_json, result_json FROM simulations WHERE simulation_id = ?', (simulation_id,)) as cursor:
                row = await cursor.fetchone()
                if row:
                    return (SimulationManifest.model_validate_json(row[0]), row[1])
        return None

    async def list_simulations(self, audit_id: str) -> List[SimulationManifest]:
        async with aiosqlite.connect(self.db_path) as db:
            async with db.execute('SELECT manifest_json FROM simulations WHERE audit_id = ? ORDER BY created_at DESC', (audit_id,)) as cursor:
                rows = await cursor.fetchall()
                return [SimulationManifest.model_validate_json(r[0]) for r in rows]

    async def delete_simulations(self, audit_id: str) -> int:
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute('DELETE FROM simulations WHERE audit_id = ?', (audit_id,))
            await db.commit()
            return cursor.rowcount
