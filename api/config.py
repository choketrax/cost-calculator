"""API configuration using pydantic-settings."""
from functools import lru_cache
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Required (except when running behind Cloudflare Worker proxy)
    api_key: str = Field("local-dev-key", description="API authentication key")

    # Storage
    storage_backend: str = Field("local", description="'local' or 'cloudflare'")
    database_url: str = Field("sqlite:////app/data/auditor.db")
    storage_path: str = Field("/app/data/uploads")

    # LLM (optional, disabled by default)
    llm_enabled: bool = Field(False)
    llm_provider: str = Field("openai")
    llm_model: str = Field("gpt-4o-mini")
    openai_api_key: Optional[str] = Field(None)
    anthropic_api_key: Optional[str] = Field(None)

    # Limits
    max_upload_size_bytes: int = Field(50 * 1024 * 1024)  # 50MB

    # App
    log_level: str = Field("INFO")
    app_version: str = Field("0.1.0")

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
