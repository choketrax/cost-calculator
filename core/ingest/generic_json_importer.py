import json
import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List

from ..models import UsageRecord
from .base import BaseImporter

logger = logging.getLogger(__name__)

class GenericJSONImporter(BaseImporter):
    source_name = "generic_json"

    def can_handle(self, filename: str, content_type: str) -> bool:
        return filename.lower().endswith((".json", ".ndjson", ".jsonl")) or "json" in content_type.lower()

    def import_records(
        self,
        data: bytes,
        audit_id: str,
        application: str = "unknown",
        workload: str = "unknown",
    ) -> List[UsageRecord]:
        records: List[UsageRecord] = []
        text_data = data.decode("utf-8", errors="replace")
        
        items = []
        try:
            parsed = json.loads(text_data)
            if isinstance(parsed, list):
                items = parsed
            elif isinstance(parsed, dict):
                for key in ["data", "records", "results", "items"]:
                    if key in parsed and isinstance(parsed[key], list):
                        items = parsed[key]
                        break
                if not items:
                    items = [parsed]
        except json.JSONDecodeError:
            # Try NDJSON
            for line in text_data.splitlines():
                if not line.strip():
                    continue
                try:
                    items.append(json.loads(line))
                except Exception:
                    pass

        for row in items:
            if not isinstance(row, dict):
                continue
            try:
                record_id = str(uuid.uuid4())
                row_lower = {k.lower().strip(): v for k, v in row.items()}
                
                # Extract timestamp
                ts_str = row_lower.get("timestamp") or row_lower.get("date") or row_lower.get("time")
                if ts_str:
                    try:
                        ts = datetime.fromisoformat(str(ts_str).replace("Z", "+00:00"))
                    except ValueError:
                        try:
                            ts = datetime.strptime(str(ts_str), "%Y-%m-%d").replace(tzinfo=timezone.utc)
                        except ValueError:
                            ts = datetime.now(timezone.utc)
                else:
                    ts = datetime.now(timezone.utc)
                    
                provider = str(row_lower.get("provider", "generic"))
                model = str(row_lower.get("model", "unknown"))
                app_val = str(row_lower.get("application") or row_lower.get("app") or application)
                wl_val = str(row_lower.get("workload") or workload)
                
                requests = int(row_lower.get("requests") or row_lower.get("count") or 1)
                input_tokens = int(row_lower.get("input_tokens") or row_lower.get("prompt_tokens") or 0)
                output_tokens = int(row_lower.get("output_tokens") or row_lower.get("completion_tokens") or 0)
                cached_tokens = int(row_lower.get("cached_tokens", 0))
                
                cost_val = row_lower.get("cost") or row_lower.get("price") or row_lower.get("amount")
                raw_cost = Decimal(str(cost_val)) if cost_val is not None else None
                
                status = str(row_lower.get("status", "success"))
                if status not in ["success", "failure", "retry"]:
                    status = "success"
                    
                retries = int(row_lower.get("retries") or row_lower.get("retry_count") or 0)

                records.append(UsageRecord(
                    record_id=record_id,
                    audit_id=audit_id,
                    timestamp=ts,
                    provider=provider,
                    model=model,
                    application=app_val,
                    workload=wl_val,
                    requests=requests,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cached_tokens=cached_tokens,
                    latency_ms=None,
                    status=status,
                    retries=retries,
                    cost=Decimal("0"),
                    currency="USD",
                    raw_cost=raw_cost,
                    import_source=self.source_name,
                    import_hash=self._hash_row(json.dumps(row, sort_keys=True))
                ))
            except Exception as e:
                logger.warning(f"Failed to parse generic JSON row: {e}")

        return records
