# AI Cost Auditor — Production Dockerfile
# Multi-stage build using uv and a virtual environment for maximum reliability

FROM python:3.12-slim AS builder

WORKDIR /build

# Install uv directly
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Create a virtual environment
RUN uv venv /opt/venv
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy project files AND source code required for building
COPY pyproject.toml .
COPY core/ ./core/
COPY storage/ ./storage/
COPY api/ ./api/

# Install dependencies and the package itself into the venv
RUN uv pip install --no-cache ".[llm]" \
    && uv pip install --no-cache pip-audit

# Aggressive artifact cleanup
RUN find /opt/venv -name "__pycache__" -exec rm -rf {} + \
    && find /opt/venv -name "*.pyc" -delete \
    && find /opt/venv -type d -name "tests" -exec rm -rf {} +

# -------------------------------------------------------
FROM python:3.12-slim AS runtime

# Non-root user for security
RUN useradd -m -u 1001 auditor

WORKDIR /app

# Copy the virtual environment from the builder
COPY --from=builder /opt/venv /opt/venv

# Activate the virtual environment for all subsequent commands
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Set runtime environment
ENV STORAGE_BACKEND="cloudflare"
ENV APP_ENV="production"

# Copy application code
COPY core/ ./core/
COPY storage/ ./storage/
COPY api/ ./api/
COPY pyproject.toml .

# Create data directories
RUN mkdir -p /app/data/uploads /app/data \
    && chown -R auditor:auditor /app

USER auditor

# Expose the port matching defaultPort in the Cloudflare Container class
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD sh -c "python -c \"import urllib.request; urllib.request.urlopen('http://localhost:${PORT:-8000}/api/v1/health')\"" || exit 1

# Start uvicorn with production settings. Support PORT env var dynamically if injected by runtime.
CMD ["sh", "-c", "uvicorn api.main:app --host :: --port ${PORT:-8000} --workers 1 --log-level info --access-log"]
