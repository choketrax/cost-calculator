-- Migration: Create Client Key Vault for BYOK
CREATE TABLE IF NOT EXISTS scp_client_vault (
    client_id TEXT NOT NULL,
    provider_name TEXT NOT NULL,
    api_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (client_id, provider_name)
);
