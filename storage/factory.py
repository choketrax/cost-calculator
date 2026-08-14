from typing import Tuple
from storage.base import AuditRepository, FileStorage

async def create_storage(settings) -> Tuple[AuditRepository, FileStorage]:
    """Create storage backend based on STORAGE_BACKEND env var.
    
    settings.storage_backend: "local" | "cloudflare"
    settings.database_url: SQLite path for local
    settings.storage_path: Base path for local file storage
    """
    if settings.storage_backend == "cloudflare":
        from storage.cloudflare import CloudflareRepository, CloudflareFileStorage
        repo = CloudflareRepository()
        files = CloudflareFileStorage()
    else:  # local
        from storage.sqlite import SQLiteRepository
        from storage.local_files import LocalFileStorage
        
        db_path = settings.database_url.replace("sqlite:///", "")
        repo = SQLiteRepository(db_path)
        await repo.initialize()
        files = LocalFileStorage(settings.storage_path)
        
    return repo, files
