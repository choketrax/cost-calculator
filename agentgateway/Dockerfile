# Custom AgentGateway image with SCP config baked in.
# Built from the official Rust binary; config is copied at build time.
# Environment variables (API keys) are injected at runtime by Render.
FROM ghcr.io/agentgateway/agentgateway:latest

COPY agentgateway.yaml /app/config.yaml

EXPOSE 3000 3001 15000 15020

CMD ["--config", "/app/config.yaml"]
