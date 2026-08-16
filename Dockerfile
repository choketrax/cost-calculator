# AI Cost Auditor — Production Dockerfile
# Multi-stage build for minimal image size

FROM python:3.12-slim AS builder

WORKDIR /build

# Install uv directly
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Copy project files AND source code required for building
COPY pyproject.toml .
COPY core/ ./core/
COPY storage/ ./storage/
COPY api/ ./api/

# Install dependencies and the package itself
RUN uv pip install --system --no-cache ".[llm]" \
    && uv pip install --system --no-cache pip-audit

# Aggressive artifact cleanup: remove __pycache__, .pyc files, and tests to reduce image size
RUN find /usr/local/lib/python3.12/site-packages -name "__pycache__" -exec rm -rf {} + \
    && find /usr/local/lib/python3.12/site-packages -name "*.pyc" -delete \
    && find /usr/local/lib/python3.12/site-packages -type d -name "tests" -exec rm -rf {} +

# -------------------------------------------------------
FROM python:3.12-slim AS runtime

# Non-root user for security
RUN useradd -m -u 1001 auditor

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy application code
COPY core/ ./core/
COPY storage/ ./storage/
COPY api/ ./api/
COPY pyproject.toml .

# Create data directories (used for local/volume-mounted data)
RUN mkdir -p /app/data/uploads /app/data \
    && chown -R auditor:auditor /app

USER auditor

# Expose the port matching defaultPort in the Cloudflare Container class
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/v1/health')" || exit 1

# Start uvicorn with production settings
CMD ["uvicorn", "api.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "1", \
     "--log-level", "info", \
     "--access-log"]
