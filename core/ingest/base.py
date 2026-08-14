import hashlib
from abc import ABC, abstractmethod
from typing import Optional

from ..models import UsageRecord

class BaseImporter(ABC):
    """Base class for all data importers.
    
    EXTENSION POINT: To add new importers (e.g., OpenTelemetry, Datadog, AWS Cost Explorer),
    subclass BaseImporter and implement the `import_records` method.
    Future OpenTelemetry importer: subclass BaseImporter with source='opentelemetry'
    """
    
    source_name: str = "unknown"  # Override in subclass
    
    @abstractmethod
    def can_handle(self, filename: str, content_type: str) -> bool:
        """Return True if this importer can handle the given file."""
        ...
    
    @abstractmethod  
    def import_records(
        self,
        data: bytes,
        audit_id: str,
        application: str = "unknown",
        workload: str = "unknown",
    ) -> list[UsageRecord]:
        """Parse data and return normalized UsageRecord list.
        
        Implementations must:
        1. Hash each source row with SHA-256 and store in import_hash
        2. Never crash on malformed rows — log and skip
        3. Never include raw prompt text in UsageRecord
        4. Set import_source to self.source_name
        """
        ...
    
    def _hash_row(self, row_data: str | bytes) -> str:
        """SHA-256 hash of a source row for deduplication."""
        if isinstance(row_data, str):
            row_data = row_data.encode('utf-8')
        return hashlib.sha256(row_data).hexdigest()
    
    def _hash_file(self, data: bytes) -> str:
        """SHA-256 hash of entire file."""
        return hashlib.sha256(data).hexdigest()
