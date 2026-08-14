import json
import threading
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Optional, List

from ..models import PricingEntry


class PricingRegistry:
    """Thread-safe in-memory pricing registry backed by JSON file.
    
    Historical pricing is NEVER overwritten — new entries supersede old ones.
    """   
    def __init__(self, data_path: Path):
        self.data_path = Path(data_path)
        self._lock = threading.RLock()
        self._version = 0
        self._entries: List[PricingEntry] = []
        
    def load(self) -> None:
        """Load pricing data from JSON file."""
        with self._lock:
            if not self.data_path.exists():
                self._version = 0
                self._entries = []
                return
                
            with open(self.data_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                
            self._version = data.get("version", 0)
            self._entries = []
            
            for ed in data.get("entries", []):
                effective_from = date.fromisoformat(ed["effective_from"]) if ed.get("effective_from") else None
                effective_to = date.fromisoformat(ed["effective_to"]) if ed.get("effective_to") else None
                created_at = datetime.fromisoformat(ed["created_at"].replace("Z", "+00:00")) if ed.get("created_at") else None
                
                entry = PricingEntry(
                    pricing_id=ed["pricing_id"],
                    provider=ed["provider"],
                    model=ed["model"],
                    input_token_price=Decimal(ed["input_token_price"]),
                    output_token_price=Decimal(ed["output_token_price"]),
                    cached_input_price=Decimal(ed["cached_input_price"]),
                    cached_output_price=Decimal(ed["cached_output_price"]),
                    request_price=Decimal(ed["request_price"]),
                    effective_from=effective_from,
                    effective_to=effective_to,
                    source=ed["source"],
                    version=ed["version"],
                    created_at=created_at,
                    is_superseded=ed["is_superseded"]
                )
                self._entries.append(entry)
                
    def save(self) -> None:
        """Persist pricing data to JSON file."""
        with self._lock:
            entries_data = []
            for entry in self._entries:
                entry_dict = {
                    "pricing_id": entry.pricing_id,
                    "provider": entry.provider,
                    "model": entry.model,
                    "input_token_price": str(entry.input_token_price),
                    "output_token_price": str(entry.output_token_price),
                    "cached_input_price": str(entry.cached_input_price),
                    "cached_output_price": str(entry.cached_output_price),
                    "request_price": str(entry.request_price),
                    "effective_from": entry.effective_from.isoformat() if entry.effective_from else None,
                    "effective_to": entry.effective_to.isoformat() if entry.effective_to else None,
                    "source": entry.source,
                    "version": entry.version,
                    "created_at": entry.created_at.isoformat().replace("+00:00", "Z") if entry.created_at else None,
                    "is_superseded": entry.is_superseded
                }
                entries_data.append(entry_dict)
                
            data = {
                "version": self._version,
                "entries": entries_data
            }
            
            self.data_path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.data_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2)
                
    def add_entry(self, entry: PricingEntry) -> PricingEntry:
        """Add a new pricing entry. If an active entry for same provider+model
        exists, mark it as superseded. Increment version."""
        with self._lock:
            today = date.today()
            
            # Find existing active entry
            active_entry = None
            for existing in self._entries:
                if (existing.provider == entry.provider and 
                    existing.model == entry.model and 
                    not existing.is_superseded):
                    active_entry = existing
                    break
            
            self._version += 1
            
            if active_entry:
                active_entry.is_superseded = True
                active_entry.effective_to = today
                entry.version = active_entry.version + 1
            else:
                entry.version = 1
                
            entry.effective_from = today
            entry.is_superseded = False
            entry.effective_to = None
            
            self._entries.append(entry)
            self.save()
            return entry
            
    def get_price(self, provider: str, model: str, as_of: Optional[date] = None) -> Optional[PricingEntry]:
        """Get active pricing for provider+model as of a given date.
        Returns None if no pricing found."""
        with self._lock:
            target_date = as_of or date.today()
            
            # Sort by version descending to get the most recent effective entry in case of ties or overlaps
            for entry in sorted(self._entries, key=lambda x: x.version, reverse=True):
                if entry.provider == provider and entry.model == model:
                    effective_from = entry.effective_from
                    effective_to = entry.effective_to
                    
                    if effective_from and target_date < effective_from:
                        continue
                        
                    if effective_to and target_date >= effective_to:
                        continue
                        
                    return entry
                    
            return None
            
    def list_entries(self, include_superseded: bool = False) -> List[PricingEntry]:
        with self._lock:
            if include_superseded:
                return list(self._entries)
            return [e for e in self._entries if not e.is_superseded]
            
    def current_version(self) -> int:
        """Monotonically increasing version number."""
        with self._lock:
            return self._version
