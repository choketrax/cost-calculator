import json
import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List

from ..models import UsageRecord
from .base import BaseImporter

logger = logging.getLogger(__name__)

class TokentabImporter(BaseImporter):
    source_name = "tokentab"

    def can_handle(self, filename: str, content_type: str) -> bool:
        # We can look at the filename or rely on the user to specify it, 
        # but realistically we can peek at the json content if we had access.
        # For now, let's just match filenames that hint at tokentab.
        return filename.lower().endswith(".json") and "tokentab" in filename.lower()

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
            parsed = json.loads(text_data)
            if not isinstance(parsed, list):
                # tokentab --json outputs a list
                parsed = [parsed]
        except json.JSONDecodeError:
            logger.error("Failed to parse tokentab JSON")
            return records

        for row in parsed:
            if not isinstance(row, dict):
                continue
            
            try:
                record_id = str(uuid.uuid4())
                
                # Extract timestamp
                ts_str = row.get("timestamp")
                if ts_str:
                    try:
                        ts = datetime.fromisoformat(str(ts_str).replace("Z", "+00:00"))
                    except ValueError:
                        ts = datetime.now(timezone.utc)
                else:
                    ts = datetime.now(timezone.utc)
                    
                provider = str(row.get("provider", "generic"))
                model = str(row.get("model", "unknown"))
                
                # tokentab maps project to application
                app_val = str(row.get("project") or application)
                # tokentab maps activity to workload
                wl_val = str(row.get("activity") or workload)
                
                # Extract tokens from the nested "tokens" object
                tokens = row.get("tokens", {})
                input_tokens = int(tokens.get("input", 0))
                output_tokens = int(tokens.get("output", 0))
                cached_tokens = int(tokens.get("cache_read", 0))
                # Note: tokens.get("cache_write", 0) is usually billed similarly to input, 
                # depending on the provider. For AI Cost Auditor, we track input_tokens, 
                # output_tokens, and cached_tokens.

                # Determine raw_cost if tokentab priced it
                cost_val = row.get("cost")
                raw_cost = Decimal(str(cost_val)) if cost_val is not None else None
                
                records.append(UsageRecord(
                    record_id=record_id,
                    audit_id=audit_id,
                    charge_period_start=ts,
                    charge_period_end=ts,
                    service_provider_name=provider,
                    resource_name=model,
                    ai_model=model,
                    ai_use_case=app_val,
                    ai_workflow=wl_val,
                    consumed_quantity=1,
                    ai_input_tokens=input_tokens,
                    ai_output_tokens=output_tokens,
                    ai_cached_tokens=cached_tokens,
                    ai_latency_ms=None,
                    ai_status="success",
                    ai_retry_count=0,
                    effective_cost=Decimal("0"),
                    billing_currency="USD",
                    billed_cost=raw_cost if raw_cost is not None else Decimal("0"),
                    import_source=self.source_name,
                    import_hash=self._hash_row(json.dumps(row, sort_keys=True))
                ))
            except Exception as e:
                logger.warning(f"Failed to parse tokentab row: {e}")

        return records
