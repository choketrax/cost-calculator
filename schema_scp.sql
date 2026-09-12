-- =============================================================================
-- Spend Control Pack — Additive Database Migration
-- Run AFTER existing schema.sql (audits, usage_records, findings, simulations)
-- All SCP tables are prefixed scp_ to avoid collisions.
-- =============================================================================

-- 1. Policy definitions
CREATE TABLE IF NOT EXISTS scp_policies (
    policy_id           TEXT PRIMARY KEY,
    scope               TEXT NOT NULL CHECK(scope IN ("agent","project","customer","global")),
    scope_id            TEXT NOT NULL,
    period              TEXT NOT NULL CHECK(period IN ("daily","monthly")),
    budget_usd          TEXT NOT NULL,
    warning_percent     REAL NOT NULL DEFAULT 75.0,
    block_percent       REAL NOT NULL DEFAULT 100.0,
    max_retries         INTEGER NOT NULL DEFAULT 3,
    fallback_model      TEXT,
    max_context_tokens  INTEGER NOT NULL DEFAULT 100000,
    min_success_rate    REAL NOT NULL DEFAULT 0.85,
    min_cache_pct       REAL NOT NULL DEFAULT 0.10,
    max_review_minutes  REAL NOT NULL DEFAULT 30.0,
    allowed_hours_start INTEGER,
    allowed_hours_end   INTEGER,
    expensive_models    TEXT NOT NULL DEFAULT '["gpt-4o","claude-opus-4-5","gemini-ultra"]',
    enforcement_mode    TEXT NOT NULL DEFAULT "observe" CHECK(enforcement_mode IN ("observe","enforce")),
    enabled_rules       TEXT NOT NULL DEFAULT "[]",
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scp_policies_scope ON scp_policies(scope, scope_id);

-- 2. Budget ledger (append-only)
CREATE TABLE IF NOT EXISTS scp_budget_ledger (
    ledger_id           TEXT PRIMARY KEY,
    policy_id           TEXT,
    scope               TEXT NOT NULL,
    scope_id            TEXT NOT NULL,
    period              TEXT NOT NULL,
    cost_usd            TEXT NOT NULL,
    avoided_cost_usd    TEXT NOT NULL DEFAULT "0",
    request_id          TEXT,
    model               TEXT,
    action_taken        TEXT,
    customer_id         TEXT,
    project_id          TEXT,
    agent_id            TEXT,
    recorded_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scp_ledger_scope   ON scp_budget_ledger(scope, scope_id, period);
CREATE INDEX IF NOT EXISTS idx_scp_ledger_period  ON scp_budget_ledger(period, recorded_at);
CREATE INDEX IF NOT EXISTS idx_scp_ledger_request ON scp_budget_ledger(request_id);

-- 3. Circuit breaker state
CREATE TABLE IF NOT EXISTS scp_circuit_state (
    state_id                TEXT PRIMARY KEY,
    scope                   TEXT NOT NULL,
    scope_id                TEXT NOT NULL,
    state                   TEXT NOT NULL DEFAULT "closed" CHECK(state IN ("closed","open","half_open")),
    open_reason             TEXT,
    open_at                 TEXT,
    consecutive_failures    INTEGER NOT NULL DEFAULT 0,
    cost_anomaly_count      INTEGER NOT NULL DEFAULT 0,
    low_quality_count       INTEGER NOT NULL DEFAULT 0,
    reset_requires_approval INTEGER NOT NULL DEFAULT 1,
    approval_id             TEXT,
    last_evaluated          TEXT NOT NULL,
    UNIQUE(scope, scope_id)
);

-- 4. Quality-gated routing table
CREATE TABLE IF NOT EXISTS scp_routing_table (
    routing_id              TEXT PRIMARY KEY,
    scope                   TEXT NOT NULL,
    scope_id                TEXT NOT NULL,
    baseline_model          TEXT NOT NULL,
    approved_model          TEXT NOT NULL,
    config_name             TEXT NOT NULL,
    quality_score           REAL NOT NULL,
    success_rate            REAL NOT NULL,
    avg_latency_ms          REAL NOT NULL,
    cost_per_task           TEXT NOT NULL,
    baseline_cost_per_task  TEXT NOT NULL,
    cost_reduction_pct      REAL NOT NULL,
    quality_threshold       REAL NOT NULL DEFAULT 0.90,
    approved_by             TEXT,
    approved_at             TEXT,
    tested_at               TEXT NOT NULL,
    is_active               INTEGER NOT NULL DEFAULT 0,
    promptfoo_run_id        TEXT
);
CREATE INDEX IF NOT EXISTS idx_scp_routing_scope ON scp_routing_table(scope, scope_id, is_active);

-- 5. Approvals queue
CREATE TABLE IF NOT EXISTS scp_approvals (
    approval_id     TEXT PRIMARY KEY,
    approval_type   TEXT NOT NULL CHECK(approval_type IN ("routing_config","circuit_reset","policy_enforce")),
    subject_id      TEXT NOT NULL,
    subject_label   TEXT,
    requested_at    TEXT NOT NULL,
    requested_by    TEXT,
    approved_at     TEXT,
    approved_by     TEXT,
    status          TEXT NOT NULL DEFAULT "pending" CHECK(status IN ("pending","approved","rejected")),
    notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_scp_approvals_status ON scp_approvals(status, requested_at);

-- 6. Policy decision log (append-only)
CREATE TABLE IF NOT EXISTS scp_policy_log (
    log_id          TEXT PRIMARY KEY,
    request_id      TEXT,
    policy_id       TEXT,
    scope           TEXT,
    scope_id        TEXT,
    action          TEXT NOT NULL,
    rule_id         TEXT,
    triggered_rules TEXT NOT NULL DEFAULT "[]",
    reason          TEXT,
    model           TEXT,
    model_override  TEXT,
    enforcement_mode TEXT,
    cost_usd        TEXT,
    avoided_cost_usd TEXT,
    evaluated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scp_log_scope  ON scp_policy_log(scope, scope_id, evaluated_at);
CREATE INDEX IF NOT EXISTS idx_scp_log_action ON scp_policy_log(action, evaluated_at);

-- 7. Usage summary (materialised, refreshed by scheduler)
CREATE TABLE IF NOT EXISTS scp_usage_summary (
    summary_id          TEXT PRIMARY KEY,
    scope               TEXT NOT NULL,
    scope_id            TEXT NOT NULL,
    period              TEXT NOT NULL,
    total_cost_usd      TEXT NOT NULL DEFAULT "0",
    avoided_cost_usd    TEXT NOT NULL DEFAULT "0",
    total_episodes      INTEGER NOT NULL DEFAULT 0,
    successful_episodes INTEGER NOT NULL DEFAULT 0,
    failed_episodes     INTEGER NOT NULL DEFAULT 0,
    total_revenue_usd   TEXT NOT NULL DEFAULT "0",
    total_review_minutes REAL NOT NULL DEFAULT 0.0,
    allow_count         INTEGER NOT NULL DEFAULT 0,
    alert_count         INTEGER NOT NULL DEFAULT 0,
    route_count         INTEGER NOT NULL DEFAULT 0,
    pause_count         INTEGER NOT NULL DEFAULT 0,
    last_refreshed      TEXT NOT NULL,
    UNIQUE(scope, scope_id, period)
);
CREATE INDEX IF NOT EXISTS idx_scp_summary_period ON scp_usage_summary(period, scope);
