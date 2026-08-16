CREATE TABLE IF NOT EXISTS audits (
    audit_id TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ingesting',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    total_records INTEGER DEFAULT 0,
    baseline_monthly_cost TEXT DEFAULT '0',
    baseline_annual_cost TEXT DEFAULT '0',
    notes TEXT
);

CREATE TABLE IF NOT EXISTS usage_records (
    record_id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    FOREIGN KEY (audit_id) REFERENCES audits(audit_id)
);

CREATE INDEX IF NOT EXISTS idx_records_audit ON usage_records(audit_id);

CREATE TABLE IF NOT EXISTS findings (
    finding_id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL,
    finding_json TEXT NOT NULL,
    FOREIGN KEY (audit_id) REFERENCES audits(audit_id)
);

CREATE INDEX IF NOT EXISTS idx_findings_audit ON findings(audit_id);

CREATE TABLE IF NOT EXISTS simulations (
    simulation_id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (audit_id) REFERENCES audits(audit_id)
);
