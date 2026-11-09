-- =============================================================================
-- Migration: add-neuron-pricing.sql
-- Adds Workers AI Neuron pricing, model registry, lifecycle tracking,
-- category budgets, inference metering, and cost reconciliation tables
-- to the existing Spend Control Pack D1 database.
-- =============================================================================

-- 1. Model Registry & Lifecycle Tracking
CREATE TABLE IF NOT EXISTS scp_model_registry (
    model_id                 TEXT PRIMARY KEY,
    canonical_alias          TEXT,
    provider                 TEXT NOT NULL,
    tier                     TEXT NOT NULL CHECK(tier IN ('deterministic','lightweight','general','reasoning','minimind','external')),
    input_price_per_m_usd    REAL NOT NULL DEFAULT 0.0,
    output_price_per_m_usd   REAL NOT NULL DEFAULT 0.0,
    cached_input_price_per_m REAL NOT NULL DEFAULT 0.0,
    input_neurons_per_m      REAL NOT NULL DEFAULT 0.0,
    output_neurons_per_m     REAL NOT NULL DEFAULT 0.0,
    context_window           INTEGER NOT NULL DEFAULT 8192,
    supports_streaming       INTEGER NOT NULL DEFAULT 1,
    supports_function_calling INTEGER NOT NULL DEFAULT 0,
    supports_structured_output INTEGER NOT NULL DEFAULT 0,
    supports_vision          INTEGER NOT NULL DEFAULT 0,
    region_constraints       TEXT NOT NULL DEFAULT '["global"]',
    allowed_data_classes     TEXT NOT NULL DEFAULT '["public","internal"]',
    tenant_allowlist         TEXT NOT NULL DEFAULT '["*"]',
    operational_status       TEXT NOT NULL DEFAULT 'active' CHECK(operational_status IN ('active','degraded','deprecated','retired','disabled','unverified')),
    enabled                  INTEGER NOT NULL DEFAULT 1,
    retirement_date          TEXT,
    replacement_model_id     TEXT,
    quality_baseline         REAL NOT NULL DEFAULT 0.80,
    avg_latency_ms           REAL NOT NULL DEFAULT 500.0,
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scp_model_registry_provider ON scp_model_registry(provider, tier, enabled);

-- 2. Tenant Category Budgets (extending SCP)
-- Categories: workers_ai_neurons, external_llm_usd, web_search_usd, web_fetch_usd, mini_mind_compute_usd, training_usd
CREATE TABLE IF NOT EXISTS scp_tenant_category_budgets (
    budget_id           TEXT PRIMARY KEY,
    tenant_id           TEXT NOT NULL,
    category            TEXT NOT NULL CHECK(category IN (
        'workers_ai_neurons',
        'external_llm_usd',
        'web_search_usd',
        'web_fetch_usd',
        'mini_mind_compute_usd',
        'training_usd'
    )),
    period              TEXT NOT NULL,
    limit_value         REAL NOT NULL,
    used_value          REAL NOT NULL DEFAULT 0.0,
    reserved_value      REAL NOT NULL DEFAULT 0.0,
    warning_pct         REAL NOT NULL DEFAULT 75.0,
    block_pct           REAL NOT NULL DEFAULT 100.0,
    overrun_action      TEXT NOT NULL DEFAULT 'deny' CHECK(overrun_action IN ('deny','alert','human_approval')),
    updated_at          TEXT NOT NULL,
    UNIQUE(tenant_id, category, period)
);
CREATE INDEX IF NOT EXISTS idx_scp_cat_budgets_tenant ON scp_tenant_category_budgets(tenant_id, period);

-- 3. Inference Usage & Neuron Meter (extends scp_budget_ledger without duplicating it)
CREATE TABLE IF NOT EXISTS scp_inference_usage (
    usage_id             TEXT PRIMARY KEY,
    request_id           TEXT NOT NULL UNIQUE,
    idempotency_key      TEXT NOT NULL,
    tenant_id            TEXT NOT NULL,
    product_id           TEXT,
    workflow_id          TEXT,
    agent_id             TEXT,
    provider             TEXT NOT NULL,
    model_id             TEXT NOT NULL,
    route_tier           TEXT NOT NULL,
    fallback_reason      TEXT,
    input_tokens         INTEGER NOT NULL DEFAULT 0,
    output_tokens        INTEGER NOT NULL DEFAULT 0,
    cached_tokens        INTEGER NOT NULL DEFAULT 0,
    estimated_neurons    REAL NOT NULL DEFAULT 0.0,
    actual_neurons       REAL,
    free_tier_neurons    REAL NOT NULL DEFAULT 0.0,
    billable_neurons     REAL NOT NULL DEFAULT 0.0,
    billing_mode         TEXT NOT NULL DEFAULT 'standard_neurons' CHECK(billing_mode IN ('standard_neurons','prepaid_gateway_credits','byok_passthrough')),
    estimated_cost_usd   REAL NOT NULL DEFAULT 0.0,
    actual_cost_usd      REAL NOT NULL DEFAULT 0.0,
    ai_gateway_routed    INTEGER NOT NULL DEFAULT 0,
    latency_ms           REAL NOT NULL DEFAULT 0.0,
    status               TEXT NOT NULL CHECK(status IN ('success','error','rejected','timeout')),
    recorded_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scp_inference_tenant ON scp_inference_usage(tenant_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_scp_inference_model  ON scp_inference_usage(provider, model_id, recorded_at);

-- 4. Daily Account Free Neuron Tracker
CREATE TABLE IF NOT EXISTS scp_daily_neuron_allocation (
    day_utc              TEXT PRIMARY KEY, -- YYYY-MM-DD
    free_limit_neurons   REAL NOT NULL DEFAULT 10000.0,
    consumed_neurons     REAL NOT NULL DEFAULT 0.0,
    updated_at           TEXT NOT NULL
);

-- 5. Billing Reconciliation Ledger
CREATE TABLE IF NOT EXISTS scp_billing_reconciliation (
    reconciliation_id    TEXT PRIMARY KEY,
    request_id           TEXT NOT NULL,
    tenant_id            TEXT NOT NULL,
    category             TEXT NOT NULL,
    provider             TEXT NOT NULL,
    estimated_units      REAL NOT NULL,
    provider_actual_units REAL NOT NULL,
    estimated_cost_usd   REAL NOT NULL,
    provider_actual_usd  REAL NOT NULL,
    delta_usd            REAL NOT NULL,
    billing_mode         TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'reconciled' CHECK(status IN ('reconciled','discrepancy_flagged','adjusted')),
    notes                TEXT,
    reconciled_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scp_reconcile_req ON scp_billing_reconciliation(request_id);

-- 6. Versioned Routing Policies & Canary Promotion (v3.0)
CREATE TABLE IF NOT EXISTS scp_routing_policy_versions (
    version_id           TEXT PRIMARY KEY,
    tenant_id            TEXT NOT NULL,
    version_number       INTEGER NOT NULL,
    policy_json          TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','evaluated','canary','active','rolled_back')),
    canary_traffic_pct   REAL NOT NULL DEFAULT 0.0,
    benchmark_run_id     TEXT,
    approved_by          TEXT,
    approved_at          TEXT,
    created_at           TEXT NOT NULL,
    UNIQUE(tenant_id, version_number)
);

-- 7. Continuous Model Benchmarks (v3.0)
CREATE TABLE IF NOT EXISTS scp_model_benchmarks (
    benchmark_id         TEXT PRIMARY KEY,
    task_type            TEXT NOT NULL,
    model_id             TEXT NOT NULL,
    provider             TEXT NOT NULL,
    sample_count         INTEGER NOT NULL,
    avg_quality_score    REAL NOT NULL,
    p95_latency_ms       REAL NOT NULL,
    avg_neurons          REAL NOT NULL,
    avg_cost_usd         REAL NOT NULL,
    pass_rate            REAL NOT NULL,
    evaluated_at         TEXT NOT NULL
);

-- 8. Seed Verified Cloudflare Workers AI & External Model Registry (Synced 2026-11-08)
INSERT OR REPLACE INTO scp_model_registry (
    model_id, canonical_alias, provider, tier,
    input_price_per_m_usd, output_price_per_m_usd, cached_input_price_per_m,
    input_neurons_per_m, output_neurons_per_m, context_window,
    supports_streaming, supports_function_calling, supports_structured_output, supports_vision,
    region_constraints, allowed_data_classes, tenant_allowlist,
    operational_status, enabled, quality_baseline, avg_latency_ms, created_at, updated_at
) VALUES
    ('@cf/ibm-granite/granite-4.0-h-micro', '@cf/ibm-granite/granite-4.0-h-micro', 'workers-ai', 'lightweight',
     0.035, 0.11, 0.0175, 3182, 10000, 131000,
     1, 1, 1, 0, '["global"]', '["public","internal","confidential"]', '["*"]',
     'active', 1, 0.78, 210.0, datetime('now'), datetime('now')),
    ('@cf/zai-org/glm-4.7-flash', '@cf/zai-org/glm-4.7-flash', 'workers-ai', 'lightweight',
     0.0605, 0.40, 0.03025, 5500, 36364, 131072,
     1, 1, 1, 0, '["global"]', '["public","internal","confidential"]', '["*"]',
     'active', 1, 0.82, 280.0, datetime('now'), datetime('now')),
    ('@cf/google/gemma-4-26b-a4b', '@cf/google/gemma-4-26b-a4b-it', 'workers-ai', 'general',
     0.10, 0.30, 0.05, 9091, 27273, 256000,
     1, 1, 1, 1, '["global"]', '["public","internal","confidential"]', '["*"]',
     'active', 1, 0.88, 490.0, datetime('now'), datetime('now')),
    ('@cf/deepseek-ai/deepseek-v4.1-flash-1017', '@cf/deepseek-ai/deepseek-v4.1-flash-1017', 'workers-ai', 'general',
     0.30, 1.20, 0.006, 27273, 109091, 1048576,
     1, 1, 1, 1, '["global"]', '["public","internal","confidential"]', '["*"]',
     'active', 1, 0.90, 420.0, datetime('now'), datetime('now')),
    ('@cf/zai-org/glm-5.3', '@cf/zai-org/glm-5.3', 'workers-ai', 'reasoning',
     1.40, 4.40, 0.26, 127273, 400000, 1048576,
     1, 1, 1, 0, '["global"]', '["public","internal","confidential"]', '["*"]',
     'active', 1, 0.94, 950.0, datetime('now'), datetime('now')),
    ('minimind/specialist-v1', 'minimind', 'minimind', 'minimind',
     0.02, 0.05, 0.01, 0, 0, 32768,
     1, 1, 1, 0, '["global"]', '["public","internal","confidential","restricted"]', '["*"]',
     'active', 1, 0.85, 180.0, datetime('now'), datetime('now')),
    ('openai/gpt-4o', 'gpt-4o', 'openai', 'external',
     2.50, 10.00, 1.25, 0, 0, 128000,
     1, 1, 1, 1, '["us","eu"]', '["public","internal"]', '[]',
     'disabled', 0, 0.95, 850.0, datetime('now'), datetime('now')),
    ('anthropic/claude-3-5-sonnet', 'claude-3-5-sonnet-latest', 'anthropic', 'external',
     3.00, 15.00, 0.30, 0, 0, 200000,
     1, 1, 1, 1, '["us","eu"]', '["public","internal"]', '[]',
     'disabled', 0, 0.96, 920.0, datetime('now'), datetime('now'));
