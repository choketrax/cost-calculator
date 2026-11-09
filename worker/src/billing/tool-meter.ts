/**
 * Search & Fetch Tool Meter (Section 10)
 *
 * DeepSeek currently charges $0.00075 per billable successful Search or Fetch request.
 * Marks requests as billable ONLY when the provider returns a successful (HTTP 200),
 * non-empty result under its published rules, and is NOT a local cache hit.
 */

import { deterministicId } from '../idempotency';

export const DEEPSEEK_COST_PER_SUCCESS_USD = 0.00075;

export interface ToolMeterRecord {
  toolUsageId: string;
  requestId: string;
  tenantId: string;
  agentId?: string;
  workflowId?: string;
  toolName: 'web.search' | 'web.fetch';
  provider: 'deepseek';
  cacheHit: boolean;
  httpStatus: number;
  billableSuccess: boolean;
  costUsd: number;
  executionTimeMs: number;
  r2ArtifactKey?: string;
  errorCode?: string;
  recordedAt: string;
}

export class ToolMeter {
  private readonly records = new Map<string, ToolMeterRecord>();

  constructor(private readonly db?: D1Database) {}

  async recordToolCall(input: {
    requestId: string;
    tenantId: string;
    agentId?: string;
    workflowId?: string;
    toolName: 'web.search' | 'web.fetch';
    provider?: 'deepseek';
    cacheHit: boolean;
    httpStatus: number;
    hasNonEmptyResult: boolean;
    executionTimeMs: number;
    r2ArtifactKey?: string;
    errorCode?: string;
  }): Promise<{ record: ToolMeterRecord; idempotent: boolean }> {
    const existing = this.records.get(input.requestId);
    if (existing) {
      return { record: existing, idempotent: true };
    }

    const toolUsageId = await deterministicId(input.requestId, 'tool_usage');
    // Only mark as billable when non-cached, HTTP 2xx, and non-empty result
    const billableSuccess =
      !input.cacheHit &&
      input.httpStatus >= 200 &&
      input.httpStatus < 300 &&
      input.hasNonEmptyResult;

    const costUsd = billableSuccess ? DEEPSEEK_COST_PER_SUCCESS_USD : 0;

    const record: ToolMeterRecord = {
      toolUsageId,
      requestId: input.requestId,
      tenantId: input.tenantId,
      agentId: input.agentId,
      workflowId: input.workflowId,
      toolName: input.toolName,
      provider: input.provider ?? 'deepseek',
      cacheHit: input.cacheHit,
      httpStatus: input.httpStatus,
      billableSuccess,
      costUsd,
      executionTimeMs: input.executionTimeMs,
      r2ArtifactKey: input.r2ArtifactKey,
      errorCode: input.errorCode,
      recordedAt: new Date().toISOString(),
    };

    this.records.set(input.requestId, record);

    if (this.db) {
      try {
        await this.db
          .prepare(
            `INSERT OR IGNORE INTO scp_tool_usage (
              tool_usage_id, request_id, tenant_id, agent_id, workflow_id,
              tool_name, provider, cache_hit, http_status, billable_success,
              cost_usd, execution_time_ms, r2_artifact_key, error_code, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            record.toolUsageId,
            record.requestId,
            record.tenantId,
            record.agentId ?? null,
            record.workflowId ?? null,
            record.toolName,
            record.provider,
            record.cacheHit ? 1 : 0,
            record.httpStatus,
            record.billableSuccess ? 1 : 0,
            record.costUsd,
            record.executionTimeMs,
            record.r2ArtifactKey ?? null,
            record.errorCode ?? null,
            record.recordedAt,
          )
          .run();
      } catch {
        // Non-fatal in unit tests without D1 table migrated
      }
    }

    return { record, idempotent: false };
  }

  listRecords(tenantId?: string): ToolMeterRecord[] {
    const all = Array.from(this.records.values());
    return tenantId ? all.filter((r) => r.tenantId === tenantId) : all;
  }

  async listRecordsAsync(tenantId?: string): Promise<ToolMeterRecord[]> {
    const mem = this.listRecords(tenantId);
    if (!this.db) return mem;
    try {
      const stmt = tenantId
        ? this.db
            .prepare(`SELECT * FROM scp_tool_usage WHERE tenant_id = ? ORDER BY recorded_at DESC LIMIT 100`)
            .bind(tenantId)
        : this.db.prepare(`SELECT * FROM scp_tool_usage ORDER BY recorded_at DESC LIMIT 100`);
      const res = await stmt.all();
      const rows = (res.results ?? []) as any[];
      if (rows.length === 0) return mem;
      return rows.map((r) => ({
        toolUsageId: String(r.tool_usage_id),
        requestId: String(r.request_id),
        tenantId: String(r.tenant_id),
        agentId: r.agent_id ?? undefined,
        workflowId: r.workflow_id ?? undefined,
        toolName: (r.tool_name as 'web.search' | 'web.fetch') ?? 'web.search',
        provider: 'deepseek',
        cacheHit: Boolean(r.cache_hit),
        httpStatus: Number(r.http_status ?? 200),
        billableSuccess: Boolean(r.billable_success),
        costUsd: Number(r.cost_usd ?? 0),
        executionTimeMs: Number(r.execution_time_ms ?? 0),
        r2ArtifactKey: r.r2_artifact_key ?? undefined,
        errorCode: r.error_code ?? undefined,
        recordedAt: String(r.recorded_at),
      }));
    } catch {
      return mem;
    }
  }
}
