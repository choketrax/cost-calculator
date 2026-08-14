import hashlib
from typing import Optional

from ..models import UsageRecord
from .anthropic_importer import AnthropicImporter
from .generic_csv_importer import GenericCSVImporter
from .generic_json_importer import GenericJSONImporter
from .manual_importer import ManualImporter
from .openai_importer import OpenAIImporter

class ImporterDispatcher:
    def __init__(self):
        self.importers = [
            OpenAIImporter(),
            AnthropicImporter(),
            ManualImporter(),
            GenericCSVImporter(),
            GenericJSONImporter(),
        ]
    
    def import_file(
        self,
        data: bytes,
        filename: str,
        content_type: str,
        audit_id: str,
        provider_hint: Optional[str] = None,
        application: str = "unknown",
        workload: str = "unknown",
    ) -> tuple[list[UsageRecord], str]:
        """Import a file using the appropriate importer.
        Returns (records, file_hash).
        Raises ValueError if no importer can handle the file."""
        file_hash = hashlib.sha256(data).hexdigest()
        
        for importer in self.importers:
            if importer.can_handle(filename, content_type):
                records = importer.import_records(data, audit_id, application, workload)
                return records, file_hash
        
        # If no explicit match, fallback based on extension/content_type
        if content_type == "text/csv" or filename.lower().endswith(".csv"):
            records = GenericCSVImporter().import_records(data, audit_id, application, workload)
            return records, file_hash
            
        if content_type == "application/json" or filename.lower().endswith(".json"):
            records = GenericJSONImporter().import_records(data, audit_id, application, workload)
            return records, file_hash

        raise ValueError(f"No importer can handle file {filename}")
