"""API authentication dependency."""
from functools import lru_cache

from fastapi import HTTPException, Security, status
from fastapi.security.api_key import APIKeyHeader

from .config import get_settings

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


async def require_api_key(api_key: str = Security(api_key_header)) -> str:
    """Validates X-API-Key header against the configured API_KEY env var."""
    settings = get_settings()
    
    # In Cloudflare mode, the Worker proxy handles authentication
    if settings.storage_backend == "cloudflare":
        return api_key or "cloudflare-proxy-auth"
        
    if not api_key or api_key != settings.api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing API key",
            headers={"WWW-Authenticate": "ApiKey"},
        )
    return api_key
