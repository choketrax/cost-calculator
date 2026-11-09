/**
 * StormDrop Exploration & Continuous Model Benchmarking Engine
 * (Capabilities 6 & 8 of v3.0 Addendum)
 *
 * - Uses deterministic FNV-1a / SHA-based sampling for controlled model comparisons
 *   and synthetic training data diversification.
 * - Applies strict experimentation budgets and excludes sensitive (`confidential`/`restricted`)
 *   workloads unless explicitly authorized.
 * - Maintains task-specific evaluation benchmarks and requires human approval
 *   before promoting a candidate routing policy to active production.
 */

import { DataClassificationLevel } from './model-registry';
import { TaskType, RiskClassification } from './task-classifier';

export interface StormDropSampleDecision {
  sampled: boolean;
  bucketValue: number;
  reason: string;
}

export interface BenchmarkRunRecord {
  benchmarkId: string;
  taskType: TaskType;
  candidateModelId: string;
  baselineModelId: string;
  sampleCount: number;
  candidateQualityScore: number;
  baselineQualityScore: number;
  candidateAvgCostUsd: number;
  baselineAvgCostUsd: number;
  candidateLatencyMs: number;
  passedQualityGate: boolean;
  requiresHumanApprovalToPromote: boolean;
  approvedBy?: string;
  promoted: boolean;
}

export class StormDropExplorationEngine {
  /**
   * Deterministically decide whether a request is selected for controlled benchmark comparison.
   */
  evaluateSample(input: {
    requestId: string;
    tenantId: string;
    sampleRatePct: number;
    dataClass: DataClassificationLevel;
    risk: RiskClassification;
    remainingExperimentBudgetUsd: number;
    estimatedComparisonCostUsd: number;
    sensitiveWorkloadAuthorized?: boolean;
  }): StormDropSampleDecision {
    // Never sample confidential/restricted or high/critical risk workloads unless explicitly authorized
    if (
      (input.dataClass === 'confidential' ||
        input.dataClass === 'restricted' ||
        input.risk === 'high' ||
        input.risk === 'critical') &&
      !input.sensitiveWorkloadAuthorized
    ) {
      return {
        sampled: false,
        bucketValue: 100,
        reason: 'Excluded sensitive or high-risk workload from StormDrop exploration',
      };
    }

    if (
      input.remainingExperimentBudgetUsd <= 0 ||
      input.estimatedComparisonCostUsd > input.remainingExperimentBudgetUsd
    ) {
      return {
        sampled: false,
        bucketValue: 100,
        reason: 'Experimentation budget exhausted',
      };
    }

    const bucketValue = this.deterministicBucket(`${input.tenantId}:${input.requestId}`);
    const sampled = bucketValue < Math.max(0, Math.min(100, input.sampleRatePct));

    return {
      sampled,
      bucketValue,
      reason: sampled
        ? `Selected by deterministic StormDrop bucket (${bucketValue.toFixed(2)} < ${input.sampleRatePct}%)`
        : `Not sampled (${bucketValue.toFixed(2)} >= ${input.sampleRatePct}%)`,
    };
  }

  /**
   * Evaluate a benchmark comparison and gate production policy promotion on quality + human approval.
   */
  evaluatePromotion(input: {
    taskType: TaskType;
    candidateModelId: string;
    baselineModelId: string;
    sampleCount: number;
    candidateQualityScore?: number;
    baselineQualityScore: number;
    candidateAvgCostUsd: number;
    baselineAvgCostUsd: number;
    candidateLatencyMs: number;
    minQualityThreshold?: number;
    approvedBy?: string;
  }): BenchmarkRunRecord {
    const minQuality = input.minQualityThreshold ?? 0.85;

    // Rule: Never treat missing quality metrics as evidence that a model is suitable
    const hasValidQuality =
      typeof input.candidateQualityScore === 'number' &&
      !Number.isNaN(input.candidateQualityScore) &&
      input.sampleCount > 0;

    const passedQualityGate =
      hasValidQuality &&
      input.candidateQualityScore! >= minQuality &&
      input.candidateQualityScore! >= input.baselineQualityScore * 0.98;

    const promoted = passedQualityGate && Boolean(input.approvedBy);

    return {
      benchmarkId: `bench-${crypto.randomUUID()}`,
      taskType: input.taskType,
      candidateModelId: input.candidateModelId,
      baselineModelId: input.baselineModelId,
      sampleCount: input.sampleCount,
      candidateQualityScore: input.candidateQualityScore ?? 0,
      baselineQualityScore: input.baselineQualityScore,
      candidateAvgCostUsd: input.candidateAvgCostUsd,
      baselineAvgCostUsd: input.baselineAvgCostUsd,
      candidateLatencyMs: input.candidateLatencyMs,
      passedQualityGate,
      requiresHumanApprovalToPromote: true,
      approvedBy: input.approvedBy,
      promoted,
    };
  }

  private deterministicBucket(seed: string): number {
    // FNV-1a 32-bit hash -> [0, 100)
    let hash = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return ((hash >>> 0) % 10000) / 100;
  }
}
