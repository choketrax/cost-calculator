import os
from pathlib import Path
from typing import Optional, List
from storage.base import FileStorage

class LocalFileStorage(FileStorage):
    def __init__(self, base_path: str):
        self.base = Path(base_path)
        self.base.mkdir(parents=True, exist_ok=True)
    
    async def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
        path = self.base / key.replace("/", os.sep)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    
    async def get(self, key: str) -> Optional[bytes]:
        path = self.base / key.replace("/", os.sep)
        if not path.exists() or not path.is_file():
            return None
        return path.read_bytes()
    
    async def delete(self, key: str) -> None:
        path = self.base / key.replace("/", os.sep)
        if path.exists() and path.is_file():
            path.unlink()
    
    async def list_keys(self, prefix: str = "") -> List[str]:
        keys = []
        for p in self.base.rglob("*"):
            if p.is_file():
                rel_path = p.relative_to(self.base).as_posix()
                if rel_path.startswith(prefix):
                    keys.append(rel_path)
        return keys
