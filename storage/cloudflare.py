import httpx
import os
from typing import Optional, Tuple, List
from datetime import datetime, date
from decimal import Decimal
from core.models import Audit, UsageRecord, Finding, SimulationManifest
from storage.base import AuditRepository, FileStorage

class CloudflareRepository(AuditRepository):
    """Cloudflare D1 & R2 backed repository."""
    
    D1_BASE = os.getenv("D1_BASE", "http://192.0.2.1")
    R2_BASE = os.getenv("R2_BASE", "http://192.0.2.1")
    
    async def _d1_query(self, query: str, params: list = None) -> dict:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self.D1_BASE}/query",
                json={"query": query, "params": params or []},
                headers={"Host": "my.d1"},
                timeout=30.0,
            )
            if not resp.is_success:
                raise Exception(f"D1 Query Failed: {resp.status_code} {resp.text}")
            return resp.json()

    def _row_to_audit(self, row) -> Audit:
        if isinstance(row, dict):
            return Audit(
                audit_id=row['audit_id'],
                customer_name=row['customer_name'],
                period_start=date.fromisoformat(row['period_start']),
                period_end=date.fromisoformat(row['period_end']),
                status=row['status'],
                created_at=datetime.fromisoformat(row['created_at']),
                updated_at=datetime.fromisoformat(row['updated_at']),
                total_records=row['total_records'],
                baseline_monthly_cost=Decimal(row['baseline_monthly_cost']),
                baseline_annual_cost=Decimal(row['baseline_annual_cost']),
                notes=row.get('notes')
            )
        else:
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
                notes=row[10] if len(row) > 10 else None
            )

    # Audits
    async def create_audit(self, audit: Audit) -> Audit:
        await self._d1_query(
            '''INSERT INTO audits (
                audit_id, customer_name, period_start, period_end, status,
                created_at, updated_at, total_records, baseline_monthly_cost,
                baseline_annual_cost, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            [
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
            ]
        )
        return audit

    async def get_audit(self, audit_id: str) -> Optional[Audit]:
        result = await self._d1_query('SELECT * FROM audits WHERE audit_id = ?', [audit_id])
        rows = result.get("results", [])
        if rows:
            return self._row_to_audit(rows[0])
        return None

    async def list_audits(self, limit: int = 50, offset: int = 0) -> List[Audit]:
        result = await self._d1_query('SELECT * FROM audits ORDER BY created_at DESC LIMIT ? OFFSET ?', [limit, offset])
        return [self._row_to_audit(r) for r in result.get("results", [])]

    async def update_audit(self, audit: Audit) -> Audit:
        await self._d1_query(
            '''UPDATE audits SET
                customer_name = ?, period_start = ?, period_end = ?, status = ?,
                updated_at = ?, total_records = ?, baseline_monthly_cost = ?,
                baseline_annual_cost = ?, notes = ?
            WHERE audit_id = ?''',
            [
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
            ]
        )
        return audit

    async def delete_audit(self, audit_id: str) -> None:
        await self._d1_query('DELETE FROM audits WHERE audit_id = ?', [audit_id])

    async def _d1_batch(self, batch_payload: list) -> dict:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self.D1_BASE}/query",
                json={"batch": batch_payload},
                headers={"Host": "my.d1"},
                timeout=30.0,
            )
            if not resp.is_success:
                raise Exception(f"D1 Batch Query Failed: {resp.status_code} {resp.text}")
            return resp.json()

    # Usage Records
    async def save_records(self, records: List[UsageRecord]) -> int:
        if not records:
            return 0
        
        batch_size = 50
        for i in range(0, len(records), batch_size):
            batch = records[i:i+batch_size]
            payload = []
            for r in batch:
                payload.append({
                    "query": 'INSERT INTO usage_records (record_id, audit_id, record_json) VALUES (?, ?, ?)',
                    "params": [r.record_id, r.audit_id, r.model_dump_json()]
                })
            await self._d1_batch(payload)
            
        return len(records)

    async def get_records(self, audit_id: str, limit: int = 1000, offset: int = 0) -> List[UsageRecord]:
        result = await self._d1_query('SELECT record_json FROM usage_records WHERE audit_id = ? LIMIT ? OFFSET ?', [audit_id, limit, offset])
        return [UsageRecord.model_validate_json(r['record_json'] if isinstance(r, dict) else r[0]) for r in result.get("results", [])]

    async def get_all_records(self, audit_id: str) -> List[UsageRecord]:
        result = await self._d1_query('SELECT record_json FROM usage_records WHERE audit_id = ?', [audit_id])
        return [UsageRecord.model_validate_json(r['record_json'] if isinstance(r, dict) else r[0]) for r in result.get("results", [])]

    async def delete_records(self, audit_id: str) -> int:
        result = await self._d1_query('DELETE FROM usage_records WHERE audit_id = ?', [audit_id])
        return result.get("meta", {}).get("changes", 0)

    # Findings
    async def save_finding(self, finding: Finding) -> Finding:
        await self._d1_query(
            'INSERT INTO findings (finding_id, audit_id, finding_json) VALUES (?, ?, ?)',
            [finding.finding_id, finding.audit_id, finding.model_dump_json()]
        )
        return finding

    async def get_findings(self, audit_id: str) -> List[Finding]:
        result = await self._d1_query('SELECT finding_json FROM findings WHERE audit_id = ?', [audit_id])
        return [Finding.model_validate_json(r['finding_json'] if isinstance(r, dict) else r[0]) for r in result.get("results", [])]

    async def get_finding(self, finding_id: str) -> Optional[Finding]:
        result = await self._d1_query('SELECT finding_json FROM findings WHERE finding_id = ?', [finding_id])
        rows = result.get("results", [])
        if rows:
            row = rows[0]
            return Finding.model_validate_json(row['finding_json'] if isinstance(row, dict) else row[0])
        return None

    async def update_finding(self, finding: Finding) -> Finding:
        await self._d1_query(
            'UPDATE findings SET finding_json = ? WHERE finding_id = ?',
            [finding.model_dump_json(), finding.finding_id]
        )
        return finding

    async def delete_findings(self, audit_id: str) -> int:
        result = await self._d1_query('DELETE FROM findings WHERE audit_id = ?', [audit_id])
        return result.get("meta", {}).get("changes", 0)

    # Simulations
    async def save_simulation(self, manifest: SimulationManifest, result_json: str) -> None:
        await self._d1_query(
            'INSERT INTO simulations (simulation_id, audit_id, manifest_json, result_json, created_at) VALUES (?, ?, ?, ?, ?)',
            [manifest.simulation_id, manifest.audit_id, manifest.model_dump_json(), result_json, datetime.utcnow().isoformat()]
        )

    async def get_simulation(self, simulation_id: str) -> Optional[Tuple[SimulationManifest, str]]:
        result = await self._d1_query('SELECT manifest_json, result_json FROM simulations WHERE simulation_id = ?', [simulation_id])
        rows = result.get("results", [])
        if rows:
            row = rows[0]
            if isinstance(row, dict):
                return (SimulationManifest.model_validate_json(row['manifest_json']), row['result_json'])
            else:
                return (SimulationManifest.model_validate_json(row[0]), row[1])
        return None

    async def list_simulations(self, audit_id: str) -> List[SimulationManifest]:
        result = await self._d1_query('SELECT manifest_json FROM simulations WHERE audit_id = ? ORDER BY created_at DESC', [audit_id])
        return [SimulationManifest.model_validate_json(r['manifest_json'] if isinstance(r, dict) else r[0]) for r in result.get("results", [])]

    async def delete_simulations(self, audit_id: str) -> int:
        result = await self._d1_query('DELETE FROM simulations WHERE audit_id = ?', [audit_id])
        return result.get("meta", {}).get("changes", 0)

class CloudflareFileStorage(FileStorage):
    """Accesses R2 via http://192.0.2.1/{key} with Host: my.r2 header (intercepted by Worker catch-all outbound)."""
    
    R2_BASE = "http://192.0.2.1"
    
    async def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
        async with httpx.AsyncClient() as client:
            resp = await client.put(f"{self.R2_BASE}/{key}", content=data,
                           headers={"Content-Type": content_type, "Host": "my.r2"})
            resp.raise_for_status()
    
    async def get(self, key: str) -> Optional[bytes]:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{self.R2_BASE}/{key}", headers={"Host": "my.r2"})
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return resp.content
            
    async def delete(self, key: str) -> None:
        async with httpx.AsyncClient() as client:
            resp = await client.delete(f"{self.R2_BASE}/{key}", headers={"Host": "my.r2"})
            if resp.status_code != 404:
                resp.raise_for_status()
                
    async def list_keys(self, prefix: str = "") -> List[str]:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{self.R2_BASE}/", params={"prefix": prefix}, headers={"Host": "my.r2"})
            if resp.status_code == 404:
                return []
            resp.raise_for_status()
            data = resp.json()
            return data.get("keys", [])
