/**
 * External LLM Fallback Safety Policy (Section 11)
 *
 * Default: external inference DISABLED unless explicitly authorized by policy.
 * Verifies all 7 mandatory conditions before permitting external LLM invocation.
 * Prevents prompt-injected provider overrides and blocks automatic conversion
 * of BYOK requests to Cloudflare Unified Billing.
 */

import { ModelCapabilityEntry, DataClassificationLevel } from './model-registry';

export type FallbackTriggerReason =
  | 'missing_workers_ai_capability'
  | 'workers_ai_quality_threshold_failed'
  | 'workers_ai_unavailable_or_capacity'
  | 'specialized_workflow_requirement'
  | 'policy_authorized_escalation'
  | 'latency_slowdown_only'
  | 'budget_or_security_check_failed'
  | 'prompt_requested_override';

export interface ExternalFallbackEvaluationInput {
  candidateModel: ModelCapabilityEntry;
  tenantId: string;
  tenantExternalLlmEnabled: boolean;
  policyExternalFallbackEnabled: boolean;
  policyRequiresExplicitAuthorization: boolean;
  dataClass: DataClassificationLevel;
  remainingExternalBudgetUsd: number;
  estimatedRequestCostUsd: number;
  maxRequestCeilingUsd: number;
  triggerReason: FallbackTriggerReason;
  isByokRequest?: boolean;
  byokVaultKeyPresent?: boolean;
  unifiedBillingFallbackAuthorized?: boolean;
}

export interface ExternalFallbackDecision {
  allowed: boolean;
  reason: string;
  failedChecks: string[];
  requireHumanApproval: boolean;
}

const VALID_TRIGGER_REASONS: ReadonlySet<FallbackTriggerReason> = new Set([
  'missing_workers_ai_capability',
  'workers_ai_quality_threshold_failed',
  'workers_ai_unavailable_or_capacity',
  'specialized_workflow_requirement',
  'policy_authorized_escalation',
]);

export class ExternalFallbackPolicy {
  evaluate(input: ExternalFallbackEvaluationInput): ExternalFallbackDecision {
    const failedChecks: string[] = [];

    // Rule: Never enable external API usage automatically in response to a failed budget or security check
    if (input.triggerReason === 'budget_or_security_check_failed') {
      failedChecks.push('prohibited_trigger_budget_or_security_failure');
    }

    // Rule: A request that is merely taking longer than expected must not cause expensive provider escalation
    if (input.triggerReason === 'latency_slowdown_only') {
      failedChecks.push('prohibited_trigger_latency_only');
    }

    // Rule: Do not allow an agent's own prompt to override provider restrictions
    if (input.triggerReason === 'prompt_requested_override') {
      failedChecks.push('prohibited_prompt_provider_override');
    }

    // Check 1: External model is allowlisted and enabled
    const tenantAllowlisted =
      input.candidateModel.tenantAllowlist.includes('*') ||
      input.candidateModel.tenantAllowlist.includes(input.tenantId);
    if (!input.candidateModel.enabled || !tenantAllowlisted) {
      failedChecks.push('model_not_allowlisted');
    }

    // Check 2: Tenant has explicitly enabled external LLM capability
    if (!input.policyExternalFallbackEnabled || (input.policyRequiresExplicitAuthorization && !input.tenantExternalLlmEnabled)) {
      failedChecks.push('tenant_external_llm_disabled');
    }

    // Check 3: Data classification permits the selected provider
    if (!input.candidateModel.allowedDataClasses.includes(input.dataClass)) {
      failedChecks.push(`data_classification_denied:${input.dataClass}`);
    }

    // Check 4: Workflow has sufficient remaining external budget
    if (input.remainingExternalBudgetUsd <= 0 || input.estimatedRequestCostUsd > input.remainingExternalBudgetUsd) {
      failedChecks.push('insufficient_external_budget');
    }

    // Check 5: Expected cost stays within configured ceiling
    if (input.estimatedRequestCostUsd > input.maxRequestCeilingUsd) {
      failedChecks.push('exceeds_request_cost_ceiling');
    }

    // Check 6: Request has a valid fallback reason
    if (!VALID_TRIGGER_REASONS.has(input.triggerReason)) {
      failedChecks.push(`invalid_fallback_reason:${input.triggerReason}`);
    }

    // BYOK safety: prevent automatic conversion of BYOK request to Cloudflare Unified Billing
    if (input.isByokRequest && !input.byokVaultKeyPresent && !input.unifiedBillingFallbackAuthorized) {
      failedChecks.push('byok_missing_cannot_convert_to_unified_billing');
    }

    const allowed = failedChecks.length === 0;
    return {
      allowed,
      reason: allowed
        ? `External fallback authorized (${input.triggerReason})`
        : `External fallback denied: ${failedChecks.join(', ')}`,
      failedChecks,
      requireHumanApproval: !allowed,
    };
  }
}
