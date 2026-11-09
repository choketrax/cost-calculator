/**
 * Operations Dashboard & Cost Metrics Aggregator
 * (Capability 10 of v3.0 Addendum + Section 16 & 19)
 *
 * Aggregates model routing decisions, Neurons consumed, Search/Fetch requests,
 * cache efficiency, quality metrics, provider health, and tenant profitability.
 */

import { InferenceMeterRecord } from '../billing/inference-meter';
import { ToolMeterRecord } from '../billing/tool-meter';
import { BillingReconciliationEngine, TenantProfitabilityReport } from '../billing/reconciliation';
import { USD_PER_NEURON } from '../billing/neuron-pricing';

export interface CustomerUnitEconomics {
  neuronsPerTask: number;
  /** Actual billed dollars per successful task */
  dollarsPerSuccessfulTask: number;
  /** Full unsubsidized operating dollars per successful task (never treating free tier as permanent zero-cost guarantee) */
  unsubsidizedDollarsPerSuccessfulTask: number;
  taskSuccessRatePct: number;
  modelSelectionDistributionPct: Record<string, number>;
  externalLlmPercentage: number;
  searchAndFetchRequests: number;
  cacheHitRatePct: number;
  customerBudgetUtilizationPct: number;
  avgWorkflowCompletionTimeMs: number;
  humanEscalationRatePct: number;
  grossMarginPct: number;
  unsubsidizedGrossMarginPct: number;
  costBreakdown: {
    actualProviderChargesUsd: number;
    estimatedChargesUsd: number;
    freeAllocationConsumptionUsd: number;
    internalCostAttributionUsd: number;
    customerBilledAmountUsd: number;
  };
}

export interface OperationsDashboardSnapshot {
  tenantId: string;
  totalInferenceRequests: number;
  workersAiSharePct: number;
  externalLlmSharePct: number;
  deterministicSharePct: number;
  totalEstimatedNeurons: number;
  totalActualNeurons: number;
  totalFreeTierNeurons: number;
  totalBillableNeurons: number;
  totalSearchRequests: number;
  totalFetchRequests: number;
  researchCacheHitRatePct: number;
  totalInferenceCostUsd: number;
  totalResearchCostUsd: number;
  totalCombinedCostUsd: number;
  profitability: TenantProfitabilityReport;
  unitEconomics: CustomerUnitEconomics;
  byModel: Record<string, { requests: number; neurons: number; costUsd: number }>;
}

export class CostMetricsAggregator {
  private readonly reconciler = new BillingReconciliationEngine();

  buildTenantSnapshot(input: {
    tenantId: string;
    monthlyContractRevenueUsd?: number;
    monthlyBudgetLimitUsd?: number;
    humanEscalationCount?: number;
    inferenceRecords: InferenceMeterRecord[];
    toolRecords: ToolMeterRecord[];
  }): OperationsDashboardSnapshot {
    const inf = input.inferenceRecords.filter((r) => r.tenantId === input.tenantId);
    const tools = input.toolRecords.filter((r) => r.tenantId === input.tenantId);

    const totalInferenceRequests = inf.length;
    const workersAiCount = inf.filter((r) => r.provider === 'workers-ai').length;
    const externalCount = inf.filter((r) => r.routeTier === 'external').length;
    const detCount = inf.filter((r) => r.routeTier === 'deterministic').length;

    const totalEstimatedNeurons = inf.reduce((s, r) => s + r.estimatedNeurons, 0);
    const totalActualNeurons = inf.reduce((s, r) => s + (r.actualNeurons ?? r.estimatedNeurons), 0);
    const totalFreeTierNeurons = inf.reduce((s, r) => s + r.freeTierNeurons, 0);
    const totalBillableNeurons = inf.reduce((s, r) => s + r.billableNeurons, 0);

    const searchCalls = tools.filter((t) => t.toolName === 'web.search');
    const fetchCalls = tools.filter((t) => t.toolName === 'web.fetch');
    const cacheHits = tools.filter((t) => t.cacheHit).length;
    const researchCacheHitRatePct =
      tools.length > 0 ? Number(((cacheHits / tools.length) * 100).toFixed(2)) : 0;

    const totalInferenceCostUsd = Number(inf.reduce((s, r) => s + r.actualCostUsd, 0).toFixed(6));
    const totalResearchCostUsd = Number(tools.reduce((s, r) => s + r.costUsd, 0).toFixed(6));
    const totalCombinedCostUsd = Number((totalInferenceCostUsd + totalResearchCostUsd).toFixed(6));

    const byModel: Record<string, { requests: number; neurons: number; costUsd: number }> = {};
    for (const rec of inf) {
      if (!byModel[rec.modelId]) {
        byModel[rec.modelId] = { requests: 0, neurons: 0, costUsd: 0 };
      }
      byModel[rec.modelId].requests += 1;
      byModel[rec.modelId].neurons = Number(
        (byModel[rec.modelId].neurons + (rec.actualNeurons ?? rec.estimatedNeurons)).toFixed(4),
      );
      byModel[rec.modelId].costUsd = Number(
        (byModel[rec.modelId].costUsd + rec.actualCostUsd).toFixed(6),
      );
    }

    const profitability = this.reconciler.computeTenantProfitability({
      tenantId: input.tenantId,
      monthlyContractRevenueUsd: input.monthlyContractRevenueUsd ?? 100,
      inferenceRecords: inf,
      toolRecords: tools,
    });

    const successfulInf = inf.filter((r) => r.status === 'success');
    const successfulCount = successfulInf.length;
    const taskSuccessRatePct =
      totalInferenceRequests > 0 ? Number(((successfulCount / totalInferenceRequests) * 100).toFixed(2)) : 100;

    const estimatedChargesUsd = Number(
      (inf.reduce((s, r) => s + r.estimatedCostUsd, 0) + totalResearchCostUsd).toFixed(6),
    );
    const freeAllocationConsumptionUsd = Number((totalFreeTierNeurons * USD_PER_NEURON).toFixed(6));
    const actualProviderChargesUsd = totalCombinedCostUsd;
    const internalCostAttributionUsd = Number(
      (actualProviderChargesUsd + freeAllocationConsumptionUsd).toFixed(6),
    );
    const customerBilledAmountUsd = input.monthlyContractRevenueUsd ?? 100;
    const budgetLimitUsd = input.monthlyBudgetLimitUsd ?? 50;

    const modelSelectionDistributionPct: Record<string, number> = {};
    for (const [mId, stats] of Object.entries(byModel)) {
      modelSelectionDistributionPct[mId] =
        totalInferenceRequests > 0 ? Number(((stats.requests / totalInferenceRequests) * 100).toFixed(2)) : 0;
    }

    const avgWorkflowCompletionTimeMs =
      totalInferenceRequests > 0
        ? Number((inf.reduce((s, r) => s + r.latencyMs, 0) / totalInferenceRequests).toFixed(2))
        : 0;

    const humanEscalations = input.humanEscalationCount ?? 0;
    const humanEscalationRatePct =
      totalInferenceRequests > 0 ? Number(((humanEscalations / totalInferenceRequests) * 100).toFixed(2)) : 0;

    const unsubsidizedGrossMarginPct =
      customerBilledAmountUsd > 0
        ? Number(
            (((customerBilledAmountUsd - internalCostAttributionUsd) / customerBilledAmountUsd) * 100).toFixed(2),
          )
        : 0;

    const unitEconomics: CustomerUnitEconomics = {
      neuronsPerTask:
        successfulCount > 0 ? Number((totalActualNeurons / successfulCount).toFixed(4)) : 0,
      dollarsPerSuccessfulTask:
        successfulCount > 0 ? Number((actualProviderChargesUsd / successfulCount).toFixed(6)) : 0,
      unsubsidizedDollarsPerSuccessfulTask:
        successfulCount > 0 ? Number((internalCostAttributionUsd / successfulCount).toFixed(6)) : 0,
      taskSuccessRatePct,
      modelSelectionDistributionPct,
      externalLlmPercentage:
        totalInferenceRequests > 0 ? Number(((externalCount / totalInferenceRequests) * 100).toFixed(2)) : 0,
      searchAndFetchRequests: tools.length,
      cacheHitRatePct: researchCacheHitRatePct,
      customerBudgetUtilizationPct:
        budgetLimitUsd > 0 ? Number(((internalCostAttributionUsd / budgetLimitUsd) * 100).toFixed(2)) : 0,
      avgWorkflowCompletionTimeMs,
      humanEscalationRatePct,
      grossMarginPct: profitability.grossMarginPct,
      unsubsidizedGrossMarginPct,
      costBreakdown: {
        actualProviderChargesUsd,
        estimatedChargesUsd,
        freeAllocationConsumptionUsd,
        internalCostAttributionUsd,
        customerBilledAmountUsd,
      },
    };

    return {
      tenantId: input.tenantId,
      totalInferenceRequests,
      workersAiSharePct:
        totalInferenceRequests > 0 ? Number(((workersAiCount / totalInferenceRequests) * 100).toFixed(2)) : 0,
      externalLlmSharePct:
        totalInferenceRequests > 0 ? Number(((externalCount / totalInferenceRequests) * 100).toFixed(2)) : 0,
      deterministicSharePct:
        totalInferenceRequests > 0 ? Number(((detCount / totalInferenceRequests) * 100).toFixed(2)) : 0,
      totalEstimatedNeurons: Number(totalEstimatedNeurons.toFixed(4)),
      totalActualNeurons: Number(totalActualNeurons.toFixed(4)),
      totalFreeTierNeurons: Number(totalFreeTierNeurons.toFixed(4)),
      totalBillableNeurons: Number(totalBillableNeurons.toFixed(4)),
      totalSearchRequests: searchCalls.length,
      totalFetchRequests: fetchCalls.length,
      researchCacheHitRatePct,
      totalInferenceCostUsd,
      totalResearchCostUsd,
      totalCombinedCostUsd,
      profitability,
      unitEconomics,
      byModel,
    };
  }
}
