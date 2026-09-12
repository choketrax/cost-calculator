import csv
import json
import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from io import StringIO
from typing import Any, Dict, List, Optional

from ..models import UsageRecord
from .base import BaseImporter

logger = logging.getLogger(__name__)

class OpenAIImporter(BaseImporter):
    source_name = "openai"

    def can_handle(self, filename: str, content_type: str) -> bool:
        if "openai" in filename.lower():
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
            items = parsed_json.get("data", []) if isinstance(parsed_json, dict) else parsed_json
            if isinstance(items, list):
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    try:
                        record_id = str(uuid.uuid4())
                        
                        # OpenAI API JSON has no clear timestamp per record unless provided, fallback to now
                        # Wait, sometimes there is 'created' or similar. We default to now.
                        ts_val = item.get("created")
                        if ts_val:
                            ts = datetime.fromtimestamp(ts_val, tz=timezone.utc)
                        else:
                            ts = datetime.now(timezone.utc)
                            
                        # 'input_cached_tokens' -> 'cached_tokens'
                        cached_tokens = item.get("input_cached_tokens", 0)

                        records.append(UsageRecord(
                            record_id=record_id,
                            audit_id=audit_id,
                            charge_period_start=ts,
                            charge_period_end=ts,
                            service_provider_name="openai",
                            resource_name=item.get("model", "unknown"),
                            ai_model=item.get("model", "unknown"),
                            ai_use_case=item.get("project_id") or application,
                            ai_workflow=workload,
                            consumed_quantity=item.get("num_model_requests", 1),
                            ai_input_tokens=item.get("input_tokens", 0),
                            ai_output_tokens=item.get("output_tokens", 0),
                            ai_cached_tokens=cached_tokens,
                            ai_latency_ms=item.get("latency_ms"),
                            ai_status="success",
                            ai_retry_count=0,
                            effective_cost=Decimal("0"),
                            billing_currency="USD",
                            billed_cost=Decimal("0"),
                            import_source=self.source_name,
                            import_hash=self._hash_row(json.dumps(item, sort_keys=True))
                        ))
                    except Exception as e:
                        logger.warning(f"Failed to parse JSON row: {e}")
        else:
            # Try CSV
            try:
                reader = csv.DictReader(StringIO(text_data))
                for row in reader:
                    try:
                        record_id = str(uuid.uuid4())
                        
                        date_str = row.get("date") or row.get("timestamp")
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
                            charge_period_start=ts,
                            charge_period_end=ts,
                            service_provider_name="openai",
                            resource_name=row.get("model", "unknown"),
                            ai_model=row.get("model", "unknown"),
                            ai_use_case=row.get("organization_id") or application,
                            ai_workflow=workload,
                            consumed_quantity=int(row.get("requests", 1)),
                            ai_input_tokens=int(row.get("input_tokens", 0)),
                            ai_output_tokens=int(row.get("output_tokens", 0)),
                            ai_cached_tokens=int(row.get("cached_tokens", 0) or row.get("input_cached_tokens", 0)),
                            ai_latency_ms=None,
                            ai_status="success",
                            ai_retry_count=0,
                            effective_cost=Decimal("0"),
                            billing_currency="USD",
                            billed_cost=Decimal("0"),
                            import_source=self.source_name,
                            import_hash=self._hash_row(json.dumps(row, sort_keys=True))
                        ))
                    except Exception as e:
                        logger.warning(f"Failed to parse CSV row: {e}")
            except Exception as e:
                logger.error(f"Failed to parse OpenAI data as CSV: {e}")

        return records
