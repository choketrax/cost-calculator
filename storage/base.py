from abc import ABC, abstractmethod
from typing import Optional, Tuple, List
from core.models import Audit, UsageRecord, Finding, SimulationManifest

class AuditRepository(ABC):
    # Audits
    @abstractmethod
    async def create_audit(self, audit: Audit) -> Audit: ...
    
    @abstractmethod
    async def get_audit(self, audit_id: str) -> Optional[Audit]: ...
    
    @abstractmethod
    async def list_audits(self, limit: int = 50, offset: int = 0) -> List[Audit]: ...
    
    @abstractmethod
    async def update_audit(self, audit: Audit) -> Audit: ...
    
    @abstractmethod
    async def delete_audit(self, audit_id: str) -> None: ...
    
    # Usage Records
    @abstractmethod
    async def save_records(self, records: List[UsageRecord]) -> int: ...
    
    @abstractmethod
    async def get_records(self, audit_id: str, limit: int = 1000, offset: int = 0) -> List[UsageRecord]: ...
    
    @abstractmethod
    async def get_all_records(self, audit_id: str) -> List[UsageRecord]: ...
    
    @abstractmethod
    async def delete_records(self, audit_id: str) -> int: ...
    
    # Findings
    @abstractmethod
    async def save_finding(self, finding: Finding) -> Finding: ...
    
    @abstractmethod
    async def get_findings(self, audit_id: str) -> List[Finding]: ...
    
    @abstractmethod
    async def get_finding(self, finding_id: str) -> Optional[Finding]: ...
    
    @abstractmethod
    async def update_finding(self, finding: Finding) -> Finding: ...
    
    @abstractmethod
    async def delete_findings(self, audit_id: str) -> int: ...
    
    # Simulations
    @abstractmethod
    async def save_simulation(self, manifest: SimulationManifest, result_json: str) -> None: ...
    
    @abstractmethod
    async def get_simulation(self, simulation_id: str) -> Optional[Tuple[SimulationManifest, str]]: ...
    
    @abstractmethod
    async def list_simulations(self, audit_id: str) -> List[SimulationManifest]: ...
    
    @abstractmethod
    async def delete_simulations(self, audit_id: str) -> int: ...

class FileStorage(ABC):
    @abstractmethod
    async def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> None: ...
    
    @abstractmethod
    async def get(self, key: str) -> Optional[bytes]: ...
    
    @abstractmethod
    async def delete(self, key: str) -> None: ...
    
    @abstractmethod
    async def list_keys(self, prefix: str = "") -> List[str]: ...
