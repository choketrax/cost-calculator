"""
AI Cost Auditor — FastAPI Application
Full implementation with storage integration, business logic, and all endpoints.
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

import socket

_original_getaddrinfo = socket.getaddrinfo

def custom_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    if host in ("my.d1", "my.r2"):
        # Return a dummy IP address (TEST-NET-1) to bypass DNS resolution.
        # Cloudflare's outboundByHost interceptor catches this traffic before it leaves.
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('192.0.2.1', port))]
    return _original_getaddrinfo(host, port, family, type, proto, flags)

socket.getaddrinfo = custom_getaddrinfo

from .config import get_settings
from .routes import audits, findings, scenarios, simulations, pricing_routes

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize storage, pricing registry, and other shared resources on startup."""
    try:
        settings = get_settings()
        logger.setLevel(getattr(logging, settings.log_level.upper(), logging.INFO))

        # Initialize storage
        from storage.factory import create_storage
        repo, file_storage = await create_storage(settings)

        # Initialize pricing registry
        from core.pricing.registry import PricingRegistry
        pricing_data_path = Path(__file__).parent.parent / "core" / "pricing" / "data" / "pricing_v1.json"
        registry = PricingRegistry(pricing_data_path)
        registry.load()

        # Store on app.state for access in routes
        app.state.settings = settings
        app.state.repo = repo
        app.state.file_storage = file_storage
        app.state.pricing_registry = registry

        logger.info(f"AI Cost Auditor v{settings.app_version} started (backend: {settings.storage_backend})")
        logger.info(f"Pricing registry loaded: {len(registry.list_entries())} active entries")

        yield
    except Exception as e:
        logger.error(f"Failed to start AI Cost Auditor: {e}", exc_info=True)
        raise

    logger.info("AI Cost Auditor shutting down")


app = FastAPI(
    title="AI Cost Auditor",
    description="Reproducible AI savings decision engine",
    version="0.1.0",
    docs_url="/api/v1/docs",
    redoc_url="/api/v1/redoc",
    openapi_url="/api/v1/openapi.json",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------

@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Log request path and method only. Never log body content."""
    logger.info(f"[{request.method}] {request.url.path}")
    response = await call_next(request)
    logger.info(f"→ {response.status_code}")
    return response


# ---------------------------------------------------------------------------
# Exception handlers
# ---------------------------------------------------------------------------

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={
            "status": "error",
            "error": {
                "code": "VALIDATION_ERROR",
                "message": "Request validation failed",
                "details": exc.errors(),
            },
        },
    )

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={
            "status": "error",
            "error": {
                "code": "INTERNAL_SERVER_ERROR",
                "message": str(exc),
                "type": type(exc).__name__,
            },
        },
    )

# ---------------------------------------------------------------------------
# Public endpoints (no auth)
# ---------------------------------------------------------------------------

@app.get("/api/v1/health", tags=["system"])
async def health_check(request: Request):
    settings = request.app.state.settings
    return {
        "status": "ok",
        "version": settings.app_version,
        "storage_backend": settings.storage_backend,
    }


@app.get("/api/v1/version", tags=["system"])
async def version_info():
    from core.prng.rng import NUMPY_VERSION, PRNG_ALGORITHM, PRNG_VERSION
    import numpy as np
    return {
        "version": "0.1.0",
        "prng_algorithm": PRNG_ALGORITHM,
        "prng_version": PRNG_VERSION,
        "numpy_version": NUMPY_VERSION,
    }


# ---------------------------------------------------------------------------
# Authenticated routes
# ---------------------------------------------------------------------------

app.include_router(audits.router, prefix="/api/v1")
app.include_router(findings.router, prefix="/api/v1")
app.include_router(scenarios.router, prefix="/api/v1")
app.include_router(simulations.router, prefix="/api/v1")
app.include_router(pricing_routes.router, prefix="/api/v1")
