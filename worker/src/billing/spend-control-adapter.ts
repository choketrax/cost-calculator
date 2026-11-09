/**
 * Spend Control Pack Adapter (Section 10)
 *
 * Bridges AgentGateway v2.0/v3.0 category budgets and atomic reservations
 * onto the existing `BudgetDO` Durable Object and `scp_budget_ledger` D1 table
 * WITHOUT creating a duplicate billing engine.
 *
 * Supported tenant budget categories:
 *   - workers_ai_neurons
 *   - external_llm_usd
 *   - web_search_usd
 *   - web_fetch_usd
 *   - mini_mind_compute_usd
 *   - training_usd
 */

import { currentPeriod } from '../budget_do';
import { deterministicId } from '../idempotency';

export type TenantBudgetCategory =
  | 'workers_ai_neurons'
  | 'external_llm_usd'
  | 'web_search_usd'
  | 'web_fetch_usd'
  | 'mini_mind_compute_usd'
  | 'training_usd';

export const ALL_BUDGET_CATEGORIES: ReadonlyArray<TenantBudgetCategory> = [
  'workers_ai_neurons',
  'external_llm_usd',
  'web_search_usd',
  'web_fetch_usd',
  'mini_mind_compute_usd',
  'training_usd',
];

export interface ReservationHandle {
  ok: boolean;
  reservationId?: string;
  scopeKey: string;
  period: string;
  reservedAmount: number;
  availableAfter: number;
  reason?: string;
  idempotent?: boolean;
}

export class SpendControlAdapter {
  constructor(
    private readonly budgetDoNamespace: DurableObjectNamespace,
    private readonly db?: D1Database,
  ) {}

  /**
   * Build the composite scope_id used inside BudgetDO so each (tenant, category)
   * has isolated atomic SQLite reservations in the existing BudgetDO.
   */
  buildScopeKey(tenantId: string, category: TenantBudgetCategory): string {
    return `tenant:${tenantId}:cat:${category}`;
  }

  private getStub(tenantId: string): DurableObjectStub {
    const id = this.budgetDoNamespace.idFromName(`tenant:${tenantId}`);
    return this.budgetDoNamespace.get(id);
  }

  async configureCategoryBudget(options: {
    tenantId: string;
    category: TenantBudgetCategory;
    budgetAmount: number;
    period?: string;
    warningPct?: number;
    blockPct?: number;
  }): Promise<void> {
    const period = options.period ?? currentPeriod();
    const scopeKey = this.buildScopeKey(options.tenantId, options.category);
    const stub = this.getStub(options.tenantId);

    const res = await stub.fetch('http://do/configure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope_id: scopeKey,
        period,
        budget_usd: options.budgetAmount,
        warning_pct: options.warningPct ?? 75.0,
        block_pct: options.blockPct ?? 100.0,
      }),
    });
    await res.json();
  }

  async reserve(options: {
    tenantId: string;
    category: TenantBudgetCategory;
    amount: number;
    requestId: string;
    period?: string;
  }): Promise<ReservationHandle> {
    const period = options.period ?? currentPeriod();
    const scopeKey = this.buildScopeKey(options.tenantId, options.category);
    const stub = this.getStub(options.tenantId);
    const scopedRequestId = `${options.requestId}:${options.category}`;

    const res = await stub.fetch('http://do/reserve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope_id: scopeKey,
        period,
        amount_usd: options.amount,
        request_id: scopedRequestId,
      }),
    });
    const data = (await res.json()) as any;
    return {
      ok: Boolean(data.ok),
      reservationId: data.reservation_id,
      scopeKey,
      period,
      reservedAmount: options.amount,
      availableAfter: data.available_after ?? 0,
      reason: data.reason,
      idempotent: data.idempotent,
    };
  }

  async settle(
    handle: ReservationHandle,
    tenantId: string,
    actualAmount: number,
  ): Promise<{ ok: boolean; idempotent?: boolean; releasedExcess?: number }> {
    if (!handle.reservationId) {
      return { ok: false };
    }
    const stub = this.getStub(tenantId);
    const res = await stub.fetch('http://do/settle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reservation_id: handle.reservationId,
        scope_id: handle.scopeKey,
        period: handle.period,
        actual_usd: actualAmount,
      }),
    });
    const data = (await res.json()) as any;
    return {
      ok: Boolean(data.ok),
      idempotent: data.idempotent,
      releasedExcess: data.released_excess,
    };
  }

  async release(handle: ReservationHandle, tenantId: string): Promise<{ ok: boolean }> {
    if (!handle.reservationId) {
      return { ok: true };
    }
    const stub = this.getStub(tenantId);
    const res = await stub.fetch('http://do/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reservation_id: handle.reservationId,
        scope_id: handle.scopeKey,
        period: handle.period,
      }),
    });
    const data = (await res.json()) as any;
    return { ok: Boolean(data.ok) };
  }

  async getStatus(
    tenantId: string,
    category: TenantBudgetCategory,
    period = currentPeriod(),
  ): Promise<{
    budget: number;
    reserved: number;
    settled: number;
    available: number;
    status: string;
  }> {
    const scopeKey = this.buildScopeKey(tenantId, category);
    const stub = this.getStub(tenantId);
    const res = await stub.fetch(
      `http://do/status?scope_id=${encodeURIComponent(scopeKey)}&period=${encodeURIComponent(period)}`,
    );
    const data = (await res.json()) as any;
    return {
      budget: data.budget_usd ?? 0,
      reserved: data.reserved_usd ?? 0,
      settled: data.settled_usd ?? 0,
      available: data.available_usd ?? Infinity,
      status: data.status ?? 'ok',
    };
  }

  /**
   * Append to existing `scp_budget_ledger` in D1 if D1 is bound.
   */
  async recordLedgerEntry(entry: {
    requestId: string;
    tenantId: string;
    projectId?: string;
    agentId?: string;
    model: string;
    costUsd: number;
    avoidedCostUsd?: number;
    actionTaken: string;
    period?: string;
  }): Promise<void> {
    if (!this.db) return;
    try {
      const ledgerId = await deterministicId(entry.requestId, 'ledger');
      const period = entry.period ?? currentPeriod();
      await this.db
        .prepare(
          `INSERT OR IGNORE INTO scp_budget_ledger (
            ledger_id, scope, scope_id, period, cost_usd, avoided_cost_usd,
            request_id, model, action_taken, customer_id, project_id, agent_id, recorded_at
          ) VALUES (?, 'customer', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          ledgerId,
          entry.tenantId,
          period,
          String(entry.costUsd),
          String(entry.avoidedCostUsd ?? 0),
          entry.requestId,
          entry.model,
          entry.actionTaken,
          entry.tenantId,
          entry.projectId ?? null,
          entry.agentId ?? null,
          new Date().toISOString(),
        )
        .run();
    } catch {
      // Schema variation safe fallback
    }
  }
}
