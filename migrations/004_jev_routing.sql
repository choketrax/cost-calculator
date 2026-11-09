-- =============================================================================
-- Jev Router Integration — Additive Migration
-- Adds routing decision log table for SCP + Jev Router telemetry.
-- Run AFTER schema_scp.sql
-- =============================================================================

-- Routing decision log (append-only audit trail)
CREATE TABLE IF NOT EXISTS scp_routing_log (
    request_id          TEXT NOT NULL,
    tenant_id           TEXT NOT NULL,
    agent_id            TEXT,
    workflow_id         TEXT,
    strategy            TEXT NOT NULL CHECK(strategy IN ('deterministic','jev','local','fallback','human')),
    router_model        TEXT,
    selected_provider   TEXT,
    selected_model      TEXT,
    estimated_cost_usd  REAL,
    actual_cost_usd     REAL,
    quality_score       REAL,
    latency_ms          INTEGER,
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    retry_count         INTEGER NOT NULL DEFAULT 0,
    escalated           INTEGER NOT NULL DEFAULT 0,
    human_review        INTEGER NOT NULL DEFAULT 0,
    policy_action       TEXT,
    circuit_breaker_state TEXT,
    reason              TEXT,
    created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scp_routing_log_tenant   ON scp_routing_log(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_scp_routing_log_strategy ON scp_routing_log(strategy, created_at);
CREATE INDEX IF NOT EXISTS idx_scp_routing_log_model    ON scp_routing_log(selected_model, created_at);
CREATE INDEX IF NOT EXISTS idx_scp_routing_log_request  ON scp_routing_log(request_id);

-- Add routing_mode column to scp_policies if not exists
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we use a safe approach
-- This column controls which routing strategy is used: 'deterministic', 'jev', 'local', 'human'
ALTER TABLE scp_policies ADD COLUMN routing_mode TEXT DEFAULT 'jev';
ALTER TABLE scp_policies ADD COLUMN allowed_providers TEXT DEFAULT '["openai","anthropic","google","deepseek"]';
ALTER TABLE scp_policies ADD COLUMN blocked_models TEXT DEFAULT '[]';
ALTER TABLE scp_policies ADD COLUMN max_cost_per_request_usd REAL DEFAULT 1.00;
ALTER TABLE scp_policies ADD COLUMN max_reasoning_level TEXT DEFAULT 'medium';
ALTER TABLE scp_policies ADD COLUMN deterministic_model TEXT;
ALTER TABLE scp_policies ADD COLUMN latency_target_ms INTEGER DEFAULT 30000;
ALTER TABLE scp_policies ADD COLUMN min_quality_score REAL DEFAULT 0.70;
ALTER TABLE scp_policies ADD COLUMN require_human_review INTEGER DEFAULT 0;

-- Policy-configured fallback chain
ALTER TABLE scp_policies ADD COLUMN fallback_model TEXT;
ALTER TABLE scp_policies ADD COLUMN fallback_provider TEXT;
ALTER TABLE scp_policies ADD COLUMN fallback_max_cost_usd REAL;
ALTER TABLE scp_policies ADD COLUMN fallback_reasoning_level TEXT;
