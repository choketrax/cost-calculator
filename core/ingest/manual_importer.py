import json
import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import List

from ..models import UsageRecord
from .base import BaseImporter

logger = logging.getLogger(__name__)

class ManualImporter(BaseImporter):
    source_name = "manual"

    def can_handle(self, filename: str, content_type: str) -> bool:
        return "manual" in filename.lower()

    def import_records(
        self,
        data: bytes,
        audit_id: str,
        application: str = "unknown",
        workload: str = "unknown",
    ) -> List[UsageRecord]:
        records: List[UsageRecord] = []
        text_data = data.decode("utf-8", errors="replace")
        
        try:
            items = json.loads(text_data)
            if not isinstance(items, list):
                items = [items]
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse manual JSON data: {e}")
            return records

        for item in items:
            if not isinstance(item, dict):
                continue
            try:
                record_id = str(uuid.uuid4())
                
                date_str = item.get("date")
                if date_str:
                    try:
                        ts = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                    except ValueError:
                        ts = datetime.now(timezone.utc)
                else:
                    ts = datetime.now(timezone.utc)
                    
                cost_usd = item.get("cost_usd")
                raw_cost = Decimal(str(cost_usd)) if cost_usd is not None else Decimal("0")
                
                status = item.get("status", "success")
                if status not in ["success", "failure", "retry"]:
                    status = "success"

                records.append(UsageRecord(
                    record_id=record_id,
                    audit_id=audit_id,
                    timestamp=ts,
                    provider=item.get("provider", "unknown"),
                    model=item.get("model", "unknown"),
                    application=item.get("application") or application,
                    workload=item.get("workload") or workload,
                    requests=1,
                    input_tokens=0,
                    output_tokens=0,
                    cached_tokens=0,
                    latency_ms=None,
                    status=status,
                    retries=0,
                    cost=raw_cost, # Cost is pre-calculated for manual entries usually, but will be determined
                    currency="USD",
                    raw_cost=raw_cost,
                    import_source=self.source_name,
                    import_hash=self._hash_row(json.dumps(item, sort_keys=True))
                ))
            except Exception as e:
                logger.warning(f"Failed to parse manual JSON row: {e}")

        return records
