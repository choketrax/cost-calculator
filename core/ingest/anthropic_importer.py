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

class AnthropicImporter(BaseImporter):
    source_name = "anthropic"

    def can_handle(self, filename: str, content_type: str) -> bool:
        if "anthropic" in filename.lower() or "claude" in filename.lower():
            return True
        return False

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
            parsed_json = json.loads(text_data)
            is_json = True
        except json.JSONDecodeError:
            is_json = False

        if is_json:
            items = parsed_json.get("results", []) if isinstance(parsed_json, dict) else parsed_json
            if isinstance(items, list):
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    try:
                        record_id = str(uuid.uuid4())
                        
                        ts_val = item.get("start_time")
                        if ts_val:
                            ts = datetime.fromisoformat(ts_val.replace("Z", "+00:00"))
                        else:
                            ts = datetime.now(timezone.utc)
                            
                        usage = item.get("usage", {})
                        cached_tokens = usage.get("cache_read_input_tokens", 0)

                        records.append(UsageRecord(
                            record_id=record_id,
                            audit_id=audit_id,
                            timestamp=ts,
                            provider="anthropic",
                            model=item.get("model", "unknown"),
                            application=application,
                            workload=workload,
                            requests=item.get("request_count", 1),
                            input_tokens=usage.get("input_tokens", 0),
                            output_tokens=usage.get("output_tokens", 0),
                            cached_tokens=cached_tokens,
                            latency_ms=item.get("latency_ms"),
                            status="success",
                            retries=0,
                            cost=Decimal("0"),
                            currency="USD",
                            raw_cost=None,
                            import_source=self.source_name,
                            import_hash=self._hash_row(json.dumps(item, sort_keys=True))
                        ))
                    except Exception as e:
                        logger.warning(f"Failed to parse JSON row: {e}")
        else:
            try:
                reader = csv.DictReader(StringIO(text_data))
                for row in reader:
                    try:
                        record_id = str(uuid.uuid4())
                        
                        date_str = row.get("date") or row.get("start_time")
                        if date_str:
                            try:
                                ts = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
                            except ValueError:
                                try:
                                    ts = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                                except ValueError:
                                    ts = datetime.now(timezone.utc)
                        else:
                            ts = datetime.now(timezone.utc)

                        records.append(UsageRecord(
                            record_id=record_id,
                            audit_id=audit_id,
                            timestamp=ts,
                            provider="anthropic",
                            model=row.get("model", "unknown"),
                            application=application,
                            workload=workload,
                            requests=int(row.get("requests", 1)),
                            input_tokens=int(row.get("input_tokens", 0)),
                            output_tokens=int(row.get("output_tokens", 0)),
                            cached_tokens=int(row.get("cache_read_input_tokens", 0) or row.get("cached_tokens", 0)),
                            latency_ms=None,
                            status="success",
                            retries=0,
                            cost=Decimal("0"),
                            currency="USD",
                            raw_cost=None,
                            import_source=self.source_name,
                            import_hash=self._hash_row(json.dumps(row, sort_keys=True))
                        ))
                    except Exception as e:
                        logger.warning(f"Failed to parse CSV row: {e}")
            except Exception as e:
                logger.error(f"Failed to parse Anthropic data as CSV: {e}")

        return records
