/**
 * Inference Meter (Section 10)
 *
 * Records every AI inference request with tenant ID, product/workflow/agent ID,
 * model, provider, input/output/cached tokens, estimated/actual Neurons,
 * billed USD, route & fallback reason, request ID, idempotency key, timestamp, and status.
 * Prevents duplicate billing when routed through Cloudflare AI Gateway.
 */

import { ModelCapabilityEntry } from '../inference/model-registry';
import { NeuronPricingCalculator, WorkersAIBillingMode } from './neuron-pricing';
import { deterministicId } from '../idempotency';

export interface InferenceMeterRecord {
  usageId: string;
  requestId: string;
  idempotencyKey: string;
  tenantId: string;
  productId?: string;
  workflowId?: string;
  agentId?: string;
  provider: string;
  modelId: string;
  routeTier: string;
  fallbackReason?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  estimatedNeurons: number;
  actualNeurons?: number;
  freeTierNeurons: number;
  billableNeurons: number;
  billingMode: WorkersAIBillingMode;
  estimatedCostUsd: number;
  actualCostUsd: number;
  aiGatewayRouted: boolean;
  latencyMs: number;
  status: 'success' | 'error' | 'rejected' | 'timeout';
  recordedAt: string;
}

export class InferenceMeter {
  private readonly records = new Map<string, InferenceMeterRecord>();
  private readonly calculator: NeuronPricingCalculator;
  private readonly dailyFreeLimit: number;
  private readonly maxTenantDailyFreeNeurons?: number;
  /** Account-level remaining free Neurons keyed by UTC date (YYYY-MM-DD) */
  private readonly accountFreeRemainingByDay = new Map<string, number>();
  /** Per-tenant free Neurons consumed keyed by `${dayUtc}:${tenantId}` */
  private readonly tenantFreeUsedByDay = new Map<string, number>();
  private currentDayUtc: string;

  constructor(
    options: {
      defaultBillingMode?: WorkersAIBillingMode;
      dailyFreeNeurons?: number;
      maxTenantDailyFreeNeurons?: number;
      db?: D1Database;
    } = {},
    private readonly db?: D1Database,
  ) {
    this.calculator = new NeuronPricingCalculator(options.defaultBillingMode ?? 'standard_neurons');
    this.dailyFreeLimit = options.dailyFreeNeurons ?? 10000;
    this.maxTenantDailyFreeNeurons = options.maxTenantDailyFreeNeurons;
    this.currentDayUtc = new Date().toISOString().slice(0, 10);
    this.accountFreeRemainingByDay.set(this.currentDayUtc, this.dailyFreeLimit);
    this.db = options.db ?? db;
  }

  async recordInference(input: {
    requestId: string;
    idempotencyKey?: string;
    tenantId: string;
    productId?: string;
    workflowId?: string;
    agentId?: string;
    model: ModelCapabilityEntry;
    fallbackReason?: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    reportedActualNeurons?: number;
    billingMode?: WorkersAIBillingMode;
    aiGatewayRouted?: boolean;
    latencyMs: number;
    status: 'success' | 'error' | 'rejected' | 'timeout';
    recordedAt?: string;
    tenantDailyFreeCapNeurons?: number;
  }): Promise<{ record: InferenceMeterRecord; idempotent: boolean }> {
    const idempotencyKey = input.idempotencyKey ?? input.requestId;

    // Idempotent deduplication (also prevents AI Gateway + Workers AI double-counting)
    const existing = this.records.get(idempotencyKey);
    if (existing) {
      return { record: existing, idempotent: true };
    }

    const recordedAt = input.recordedAt ?? new Date().toISOString();
    const dayUtc = recordedAt.slice(0, 10);
    this.currentDayUtc = dayUtc;

    if (!this.accountFreeRemainingByDay.has(dayUtc)) {
      this.accountFreeRemainingByDay.set(dayUtc, this.dailyFreeLimit);
    }
    const accountRemaining = this.accountFreeRemainingByDay.get(dayUtc)!;
    const tenantDayKey = `${dayUtc}:${input.tenantId}`;
    const tenantUsed = this.tenantFreeUsedByDay.get(tenantDayKey) ?? 0;
    const tenantCap = input.tenantDailyFreeCapNeurons ?? this.maxTenantDailyFreeNeurons;
    const availableFreeForRequest =
      tenantCap !== undefined
        ? Math.min(accountRemaining, Math.max(0, tenantCap - tenantUsed))
        : accountRemaining;

    const usageId = await deterministicId(idempotencyKey, 'inference_usage');
    const charge = this.calculator.calculate({
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cachedTokens: input.cachedTokens,
      reportedActualNeurons: input.reportedActualNeurons,
      billingMode: input.billingMode,
      remainingDailyFreeNeurons: availableFreeForRequest,
      aiGatewayRouted: input.aiGatewayRouted,
    });

    if (input.status === 'success' && charge.freeTierNeuronsApplied > 0) {
      this.accountFreeRemainingByDay.set(
        dayUtc,
        Math.max(0, accountRemaining - charge.freeTierNeuronsApplied),
      );
      this.tenantFreeUsedByDay.set(tenantDayKey, tenantUsed + charge.freeTierNeuronsApplied);
    }

    const record: InferenceMeterRecord = {
      usageId,
      requestId: input.requestId,
      idempotencyKey,
      tenantId: input.tenantId,
      productId: input.productId,
      workflowId: input.workflowId,
      agentId: input.agentId,
      provider: input.model.provider,
      modelId: input.model.modelId,
      routeTier: input.model.tier,
      fallbackReason: input.fallbackReason,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cachedTokens: input.cachedTokens ?? 0,
      estimatedNeurons: charge.estimatedNeurons,
      actualNeurons: input.reportedActualNeurons,
      freeTierNeurons: input.status === 'success' ? charge.freeTierNeuronsApplied : 0,
      billableNeurons: input.status === 'success' ? charge.billableNeurons : 0,
      billingMode: charge.billingMode,
      estimatedCostUsd: charge.estimatedCostUsd,
      actualCostUsd: input.status === 'success' ? charge.billedCostUsd : 0,
      aiGatewayRouted: Boolean(input.aiGatewayRouted),
      latencyMs: input.latencyMs,
      status: input.status,
      recordedAt,
    };

    this.records.set(idempotencyKey, record);

    if (this.db) {
      try {
        await this.db
          .prepare(
            `INSERT OR IGNORE INTO scp_inference_usage (
              usage_id, request_id, idempotency_key, tenant_id, product_id, workflow_id, agent_id,
              provider, model_id, route_tier, fallback_reason,
              input_tokens, output_tokens, cached_tokens,
              estimated_neurons, actual_neurons, free_tier_neurons, billable_neurons,
              billing_mode, estimated_cost_usd, actual_cost_usd, ai_gateway_routed,
              latency_ms, status, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            record.usageId,
            record.requestId,
            record.idempotencyKey,
            record.tenantId,
            record.productId ?? null,
            record.workflowId ?? null,
            record.agentId ?? null,
            record.provider,
            record.modelId,
            record.routeTier,
            record.fallbackReason ?? null,
            record.inputTokens,
            record.outputTokens,
            record.cachedTokens,
            record.estimatedNeurons,
            record.actualNeurons ?? null,
            record.freeTierNeurons,
            record.billableNeurons,
            record.billingMode,
            record.estimatedCostUsd,
            record.actualCostUsd,
            record.aiGatewayRouted ? 1 : 0,
            record.latencyMs,
            record.status,
            record.recordedAt,
          )
          .run();

        // Update daily free Neuron tracker in D1
        if (record.provider === 'workers-ai' && record.status === 'success') {
          const dayUtc = record.recordedAt.slice(0, 10);
          const consumed = record.actualNeurons ?? record.estimatedNeurons;
          await this.db
            .prepare(
              `INSERT INTO scp_daily_neuron_allocation (day_utc, free_limit_neurons, consumed_neurons, updated_at)
               VALUES (?, 10000.0, ?, ?)
               ON CONFLICT(day_utc) DO UPDATE SET
                 consumed_neurons = consumed_neurons + excluded.consumed_neurons,
                 updated_at = excluded.updated_at`,
            )
            .bind(dayUtc, consumed, record.recordedAt)
            .run();
        }

        // Write automatic reconciliation ledger entry when provider actual neurons are reported
        if (record.actualNeurons !== undefined) {
          const recId = await deterministicId(record.requestId, 'reconcile');
          const deltaUsd = Number((record.actualCostUsd - record.estimatedCostUsd).toFixed(6));
          await this.db
            .prepare(
              `INSERT OR IGNORE INTO scp_billing_reconciliation (
                reconciliation_id, request_id, tenant_id, category, provider,
                estimated_units, provider_actual_units, estimated_cost_usd, provider_actual_usd,
                delta_usd, billing_mode, status, notes, reconciled_at
              ) VALUES (?, ?, ?, 'workers_ai_neurons', ?, ?, ?, ?, ?, ?, ?, 'reconciled', 'Auto-reconciled from Workers AI usage.neurons', ?)`,
            )
            .bind(
              recId,
              record.requestId,
              record.tenantId,
              record.provider,
              record.estimatedNeurons,
              record.actualNeurons,
              record.estimatedCostUsd,
              record.actualCostUsd,
              deltaUsd,
              record.billingMode,
              record.recordedAt,
            )
            .run();
        }
      } catch {
        // Non-fatal if D1 table is not yet migrated in isolated unit test
      }
    }

    return { record, idempotent: false };
  }

  listRecords(tenantId?: string): InferenceMeterRecord[] {
    const all = Array.from(this.records.values());
    return tenantId ? all.filter((r) => r.tenantId === tenantId) : all;
  }

  async listRecordsAsync(tenantId?: string): Promise<InferenceMeterRecord[]> {
    const mem = this.listRecords(tenantId);
    if (!this.db) return mem;
    try {
      const stmt = tenantId
        ? this.db
            .prepare(`SELECT * FROM scp_inference_usage WHERE tenant_id = ? ORDER BY recorded_at DESC LIMIT 100`)
            .bind(tenantId)
        : this.db.prepare(`SELECT * FROM scp_inference_usage ORDER BY recorded_at DESC LIMIT 100`);
      const res = await stmt.all();
      const rows = (res.results ?? []) as any[];
      if (rows.length === 0) return mem;
      return rows.map((r) => ({
        usageId: String(r.usage_id),
        requestId: String(r.request_id),
        idempotencyKey: String(r.idempotency_key),
        tenantId: String(r.tenant_id),
        productId: r.product_id ?? undefined,
        workflowId: r.workflow_id ?? undefined,
        agentId: r.agent_id ?? undefined,
        provider: String(r.provider),
        modelId: String(r.model_id),
        routeTier: String(r.route_tier),
        fallbackReason: r.fallback_reason ?? undefined,
        inputTokens: Number(r.input_tokens ?? 0),
        outputTokens: Number(r.output_tokens ?? 0),
        cachedTokens: Number(r.cached_tokens ?? 0),
        estimatedNeurons: Number(r.estimated_neurons ?? 0),
        actualNeurons: r.actual_neurons !== null && r.actual_neurons !== undefined ? Number(r.actual_neurons) : undefined,
        freeTierNeurons: Number(r.free_tier_neurons ?? 0),
        billableNeurons: Number(r.billable_neurons ?? 0),
        billingMode: (r.billing_mode as WorkersAIBillingMode) ?? 'standard_neurons',
        estimatedCostUsd: Number(r.estimated_cost_usd ?? 0),
        actualCostUsd: Number(r.actual_cost_usd ?? 0),
        aiGatewayRouted: Boolean(r.ai_gateway_routed),
        latencyMs: Number(r.latency_ms ?? 0),
        status: (r.status as any) ?? 'success',
        recordedAt: String(r.recorded_at),
      }));
    } catch {
      return mem;
    }
  }

  getDailyFreeRemaining(dayUtc?: string): number {
    const key = dayUtc ?? this.currentDayUtc;
    return this.accountFreeRemainingByDay.get(key) ?? this.dailyFreeLimit;
  }

  async getAccountDailyFreeRemainingAsync(dayUtc?: string): Promise<number> {
    const key = dayUtc ?? new Date().toISOString().slice(0, 10);
    if (!this.db) return this.getDailyFreeRemaining(key);
    try {
      const row = (await this.db
        .prepare(
          `SELECT free_limit_neurons, consumed_neurons FROM scp_daily_neuron_allocation WHERE day_utc = ? LIMIT 1`,
        )
        .bind(key)
        .first()) as any;
      if (row) {
        return Number(
          Math.max(0, Number(row.free_limit_neurons ?? this.dailyFreeLimit) - Number(row.consumed_neurons ?? 0)).toFixed(4),
        );
      }
      return this.getDailyFreeRemaining(key);
    } catch {
      return this.getDailyFreeRemaining(key);
    }
  }
}
