-- =============================================================================
-- Migration: add-research-tool-metadata.sql
-- Adds Tool Registry metadata, DeepSeek Search/Fetch metering, Research Cache
-- index, Tenant API credentials, and Execution Recovery checkpoints.
-- =============================================================================

-- 1. Tool Registry & Permissions
CREATE TABLE IF NOT EXISTS scp_tool_registry (
    tool_name            TEXT PRIMARY KEY,
    mcp_name             TEXT NOT NULL UNIQUE,
    version              TEXT NOT NULL,
    provider             TEXT NOT NULL,
    read_only            INTEGER NOT NULL DEFAULT 1,
    required_permission  TEXT NOT NULL,
    billing_category     TEXT NOT NULL,
    cost_per_call_usd    REAL NOT NULL DEFAULT 0.00075,
    rate_limit_rpm       INTEGER NOT NULL DEFAULT 60,
    default_timeout_ms   INTEGER NOT NULL DEFAULT 15000,
    max_output_chars     INTEGER NOT NULL DEFAULT 65536,
    schema_json          TEXT NOT NULL,
    enabled              INTEGER NOT NULL DEFAULT 1,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
);

-- 2. Tool Execution & Metering Ledger
CREATE TABLE IF NOT EXISTS scp_tool_usage (
    tool_usage_id        TEXT PRIMARY KEY,
    request_id           TEXT NOT NULL UNIQUE,
    tenant_id            TEXT NOT NULL,
    agent_id             TEXT,
    workflow_id          TEXT,
    tool_name            TEXT NOT NULL,
    provider             TEXT NOT NULL,
    cache_hit            INTEGER NOT NULL DEFAULT 0,
    http_status          INTEGER NOT NULL,
    billable_success     INTEGER NOT NULL DEFAULT 0,
    cost_usd             REAL NOT NULL DEFAULT 0.0,
    execution_time_ms    REAL NOT NULL DEFAULT 0.0,
    r2_artifact_key      TEXT,
    error_code           TEXT,
    recorded_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scp_tool_usage_tenant ON scp_tool_usage(tenant_id, tool_name, recorded_at);

-- 3. Tenant-Isolated Research Cache Index
CREATE TABLE IF NOT EXISTS scp_research_cache (
    cache_key            TEXT PRIMARY KEY,
    tenant_id            TEXT NOT NULL,
    tool_name            TEXT NOT NULL,
    provider             TEXT NOT NULL,
    normalized_target    TEXT NOT NULL,
    content_class        TEXT NOT NULL,
    r2_object_key        TEXT,
    inline_payload_json  TEXT,
    created_at           TEXT NOT NULL,
    expires_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scp_research_cache_tenant ON scp_research_cache(tenant_id, expires_at);

-- 4. Verified Tenant Token & RBAC Policy Table
CREATE TABLE IF NOT EXISTS scp_tenant_credentials (
    token_hash           TEXT PRIMARY KEY,
    tenant_id            TEXT NOT NULL,
    tenant_name          TEXT NOT NULL,
    roles_json           TEXT NOT NULL DEFAULT '["agent"]',
    permissions_json     TEXT NOT NULL DEFAULT '["inference.invoke","tools.web.search","tools.web.fetch"]',
    allowed_data_class   TEXT NOT NULL DEFAULT 'internal',
    external_llm_enabled INTEGER NOT NULL DEFAULT 0,
    minimind_prefer      INTEGER NOT NULL DEFAULT 0,
    Contract_revenue_monthly_usd REAL NOT NULL DEFAULT 0.0,
    status               TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','revoked')),
    created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scp_tenant_cred_tenant ON scp_tenant_credentials(tenant_id);

-- 5. Execution Recovery Checkpoints & Dead-Letter Queue (v3.0)
CREATE TABLE IF NOT EXISTS scp_execution_checkpoints (
    checkpoint_id        TEXT PRIMARY KEY,
    request_id           TEXT NOT NULL,
    tenant_id            TEXT NOT NULL,
    workflow_id          TEXT,
    stage                TEXT NOT NULL,
    state_json           TEXT NOT NULL,
    attempt_count        INTEGER NOT NULL DEFAULT 1,
    status               TEXT NOT NULL CHECK(status IN ('in_progress','completed','dlq','human_escalation')),
    last_error           TEXT,
    updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scp_checkpoints_req ON scp_execution_checkpoints(request_id, tenant_id);
