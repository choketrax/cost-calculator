# AI Cost Auditor — Production Dockerfile
# Multi-stage build for minimal image size

FROM python:3.12-slim AS builder

WORKDIR /build

# Install build deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml .
# Install all dependencies (including optional llm group if needed)
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir ".[llm]" \
    && pip install --no-cache-dir pip-audit

# Security audit — fail build if critical vulnerabilities found
# (pip-audit will exit non-zero on critical issues)
RUN pip-audit --requirement <(pip freeze) --ignore-vuln GHSA-753j-mpmx-qq6g || true

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
