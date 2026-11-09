/**
 * Tenant Tool Policy, Rate Limiter & Commercial Risk Controls (Phase 3 of v3.2)
 */

import { VerifiedTenantIdentity } from '../gateway/middleware/identity';
import { ForbiddenError } from '../gateway/middleware/authorization';

export interface TenantToolRateWindow {
  count: number;
  windowStartMs: number;
}

export interface CommercialRiskPolicy {
  planName: 'internal' | 'starter' | 'growth' | 'enterprise';
  monthlyInferenceBudgetUsd: number;
  dailyNeuronCeiling: number;
  externalResearchBudgetUsd: number;
  maxRequestsPerMinute: number;
  maxConcurrentOperations: number;
  maxTokensPerRequest: number;
  maxAutomatedRetries: number;
  maxWorkflowExecutionDepth: number;
  externalLlmPermitted: boolean;
  requireHumanApprovalForProduction: boolean;
}

export const DEFAULT_COMMERCIAL_RISK_POLICY: CommercialRiskPolicy = {
  planName: 'starter',
  monthlyInferenceBudgetUsd: 50.0,
  dailyNeuronCeiling: 50_000,
  externalResearchBudgetUsd: 15.0,
  maxRequestsPerMinute: 60,
  maxConcurrentOperations: 20,
  maxTokensPerRequest: 32_768,
  maxAutomatedRetries: 3,
  maxWorkflowExecutionDepth: 10,
  externalLlmPermitted: false,
  requireHumanApprovalForProduction: true,
};

export class TenantToolPolicyEngine {
  private readonly windows = new Map<string, TenantToolRateWindow>();
  private readonly tenantPolicies = new Map<string, CommercialRiskPolicy>();
  private readonly activeConcurrency = new Map<string, number>();

  setTenantCommercialPolicy(tenantId: string, policy: Partial<CommercialRiskPolicy>): CommercialRiskPolicy {
    const merged: CommercialRiskPolicy = {
      ...DEFAULT_COMMERCIAL_RISK_POLICY,
      ...(this.tenantPolicies.get(tenantId) ?? {}),
      ...policy,
    };
    this.tenantPolicies.set(tenantId, merged);
    return merged;
  }

  getTenantCommercialPolicy(tenantId: string): CommercialRiskPolicy {
    return this.tenantPolicies.get(tenantId) ?? DEFAULT_COMMERCIAL_RISK_POLICY;
  }

  enforceCommercialGuardrails(input: {
    tenantId: string;
    requestedTokens?: number;
    requestedRetries?: number;
    workflowDepth?: number;
    requiresExternalLlm?: boolean;
  }): CommercialRiskPolicy {
    const policy = this.getTenantCommercialPolicy(input.tenantId);

    if (input.requestedTokens !== undefined && input.requestedTokens > policy.maxTokensPerRequest) {
      throw new ForbiddenError(
        `Requested tokens (${input.requestedTokens}) exceed tenant maxTokensPerRequest (${policy.maxTokensPerRequest})`,
        'commercial.tokens_within_limit',
      );
    }
    if (input.requestedRetries !== undefined && input.requestedRetries > policy.maxAutomatedRetries) {
      throw new ForbiddenError(
        `Requested retries (${input.requestedRetries}) exceed tenant maxAutomatedRetries (${policy.maxAutomatedRetries})`,
        'commercial.retries_within_limit',
      );
    }
    if (input.workflowDepth !== undefined && input.workflowDepth > policy.maxWorkflowExecutionDepth) {
      throw new ForbiddenError(
        `Workflow execution depth (${input.workflowDepth}) exceeds tenant maxWorkflowExecutionDepth (${policy.maxWorkflowExecutionDepth})`,
        'commercial.workflow_depth_within_limit',
      );
    }
    if (input.requiresExternalLlm && !policy.externalLlmPermitted) {
      throw new ForbiddenError(
        `External LLM invocation is disabled under tenant commercial policy ('${policy.planName}')`,
        'commercial.external_llm',
      );
    }
    const inFlight = this.activeConcurrency.get(input.tenantId) ?? 0;
    if (inFlight >= policy.maxConcurrentOperations) {
      const err = new Error(
        `Concurrent operation limit (${policy.maxConcurrentOperations}) reached for tenant '${input.tenantId}'`,
      );
      (err as any).statusCode = 429;
      (err as any).code = 'CONCURRENCY_LIMIT_EXCEEDED';
      throw err;
    }
    return policy;
  }

  acquireConcurrencySlot(tenantId: string): () => void {
    const policy = this.getTenantCommercialPolicy(tenantId);
    const current = this.activeConcurrency.get(tenantId) ?? 0;
    if (current >= policy.maxConcurrentOperations) {
      const err = new Error(
        `Concurrent operation limit (${policy.maxConcurrentOperations}) reached for tenant '${tenantId}'`,
      );
      (err as any).statusCode = 429;
      (err as any).code = 'CONCURRENCY_LIMIT_EXCEEDED';
      throw err;
    }
    this.activeConcurrency.set(tenantId, current + 1);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        const nowCount = this.activeConcurrency.get(tenantId) ?? 1;
        this.activeConcurrency.set(tenantId, Math.max(0, nowCount - 1));
      }
    };
  }

  enforceToolAccess(
    identity: VerifiedTenantIdentity,
    toolName: 'web.search' | 'web.fetch',
    maxRpm?: number,
  ): void {
    const policy = this.getTenantCommercialPolicy(identity.tenantId);
    const effectiveRpm = maxRpm ?? policy.maxRequestsPerMinute;
    const requiredPerm = `tools.${toolName}`;
    const hasPerm =
      identity.roles.includes('admin') ||
      identity.permissions.includes('*') ||
      identity.permissions.includes(requiredPerm);

    if (!hasPerm) {
      throw new ForbiddenError(
        `Tenant '${identity.tenantId}' is not authorized to invoke '${toolName}'`,
        requiredPerm,
      );
    }

    const key = `${identity.tenantId}:${toolName}`;
    const now = Date.now();
    const current = this.windows.get(key);

    if (!current || now - current.windowStartMs >= 60_000) {
      this.windows.set(key, { count: 1, windowStartMs: now });
      return;
    }

    if (current.count >= effectiveRpm) {
      const err = new Error(
        `Rate limit of ${effectiveRpm} RPM exceeded for tenant '${identity.tenantId}' on '${toolName}'`,
      );
      (err as any).statusCode = 429;
      (err as any).code = 'RATE_LIMIT_EXCEEDED';
      throw err;
    }

    current.count += 1;
  }
}
