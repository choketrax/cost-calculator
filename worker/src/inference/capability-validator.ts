/**
 * Capability Validator
 *
 * Verifies that a candidate model actually supports all required capabilities,
 * context window length, data classification, region constraints, and tenant allowlist
 * before routing a request to it.
 */

import { ModelCapabilityEntry, DataClassificationLevel } from './model-registry';
import { TaskClassification } from './task-classifier';

export interface CapabilityValidationResult {
  compatible: boolean;
  missingCapabilities: string[];
}

export class CapabilityValidator {
  validate(
    model: ModelCapabilityEntry,
    task: TaskClassification,
    options: {
      tenantId: string;
      requiredRegion?: string;
    },
  ): CapabilityValidationResult {
    const missing: string[] = [];

    if (!model.enabled || model.operationalStatus !== 'active') {
      missing.push(`operational_status:${model.operationalStatus}`);
    }

    if (model.retirementDate && new Date(model.retirementDate).getTime() <= Date.now()) {
      missing.push('model_retired');
    }

    const totalRequiredTokens = task.estimatedInputTokens + task.estimatedOutputTokens;
    if (totalRequiredTokens > model.contextWindow) {
      missing.push(`context_window_exceeded:${totalRequiredTokens}>${model.contextWindow}`);
    }

    if (task.requiresTools && !model.supportsFunctionCalling) {
      missing.push('function_calling');
    }

    if (task.requiresStructuredOutput && !model.supportsStructuredOutput) {
      missing.push('structured_output');
    }

    if (task.requiresVision && !model.supportsVision) {
      missing.push('vision');
    }

    if (task.requiresStreaming && !model.supportsStreaming) {
      missing.push('streaming');
    }

    if (!model.allowedDataClasses.includes(task.dataClass as DataClassificationLevel)) {
      missing.push(`data_class_not_permitted:${task.dataClass}`);
    }

    const tenantAllowed =
      model.tenantAllowlist.includes('*') || model.tenantAllowlist.includes(options.tenantId);
    if (!tenantAllowed) {
      missing.push(`tenant_not_allowlisted:${options.tenantId}`);
    }

    if (
      options.requiredRegion &&
      !model.regionConstraints.includes('global') &&
      !model.regionConstraints.includes(options.requiredRegion)
    ) {
      missing.push(`region_constraint:${options.requiredRegion}`);
    }

    return {
      compatible: missing.length === 0,
      missingCapabilities: missing,
    };
  }
}
