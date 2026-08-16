import csv
import json
import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from io import StringIO
from typing import List

from ..models import UsageRecord
from .base import BaseImporter

logger = logging.getLogger(__name__)

class GenericCSVImporter(BaseImporter):
    source_name = "generic_csv"

    def can_handle(self, filename: str, content_type: str) -> bool:
        return filename.lower().endswith(".csv") or "csv" in content_type.lower()

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
            reader = csv.DictReader(StringIO(text_data))
            
            for row in reader:
                try:
                    record_id = str(uuid.uuid4())
                    row_lower = {k.lower().strip(): v for k, v in row.items() if k}
                    
                    # Extract timestamp
                    ts_str = row_lower.get("timestamp") or row_lower.get("date") or row_lower.get("time")
                    if ts_str:
                        try:
                            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                        except ValueError:
                            try:
                                ts = datetime.strptime(ts_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                            except ValueError:
                                ts = datetime.now(timezone.utc)
                    else:
                        ts = datetime.now(timezone.utc)
                        
                    provider = row_lower.get("provider", "generic")
                    model = row_lower.get("model", "unknown")
                    
                    if provider == "generic" or not provider:
                        if model.startswith("gpt-") or model.startswith("text-embedding"):
                            provider = "openai"
                        elif model.startswith("claude-"):
                            provider = "anthropic"
                            
                    app_val = row_lower.get("application") or row_lower.get("app") or application
                    wl_val = row_lower.get("workload") or workload
                    
                    requests = int(row_lower.get("requests") or row_lower.get("count") or 1)
                    input_tokens = int(row_lower.get("input_tokens") or row_lower.get("prompt_tokens") or 0)
                    output_tokens = int(row_lower.get("output_tokens") or row_lower.get("completion_tokens") or 0)
                    cached_tokens = int(row_lower.get("cached_tokens", 0))
                    
                    cost_str = row_lower.get("cost") or row_lower.get("price") or row_lower.get("amount")
                    raw_cost = Decimal(cost_str) if cost_str else None
                    
                    status = row_lower.get("status", "success")
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
                    logger.warning(f"Failed to parse generic CSV row: {e}")
        except Exception as e:
            logger.error(f"Failed to parse generic CSV file: {e}")

        return records
