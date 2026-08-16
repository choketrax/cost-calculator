import sys
import os
from datetime import datetime
from decimal import Decimal

sys.path.append(os.getcwd())

from core.models import UsageRecord

record = UsageRecord(
    record_id="123",
    audit_id="abc",
    timestamp=datetime.utcnow(),
    provider="openai",
    model="gpt-4o",
    application="my-app",
    workload="chat",
    cost=Decimal("1.25")
)

print("Dump dict:", record.model_dump())
print("Dump json:", record.model_dump_json())
