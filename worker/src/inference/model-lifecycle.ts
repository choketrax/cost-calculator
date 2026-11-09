/**
 * Model Lifecycle Manager (AgentGateway v3.0 Addendum)
 *
 * Monitors model availability, capability changes, pricing updates,
 * deprecation windows, and automatic safe replacement lookup.
 */

import { ModelRegistry, ModelCapabilityEntry, OperationalStatus } from './model-registry';

export interface LifecycleHealthEvent {
  modelId: string;
  previousStatus: OperationalStatus;
  newStatus: OperationalStatus;
  reason: string;
  replacementModelId?: string;
  timestamp: string;
}

export class ModelLifecycleManager {
  private events: LifecycleHealthEvent[] = [];

  constructor(private readonly registry: ModelRegistry) {}

  /**
   * Check whether a model is healthy and within its operational lifecycle.
   * If retired or deprecated with a replacement, returns the replacement candidate.
   */
  resolveOperationalModel(modelId: string): {
    usable: boolean;
    resolvedModel?: ModelCapabilityEntry;
    migratedFrom?: string;
    reason?: string;
  } {
    const entry = this.registry.get(modelId);
    if (!entry) {
      return { usable: false, reason: `Model '${modelId}' is not registered` };
    }

    const isRetiredByDate =
      entry.retirementDate !== undefined &&
      new Date(entry.retirementDate).getTime() <= Date.now();

    if (
      !entry.enabled ||
      entry.operationalStatus === 'retired' ||
      entry.operationalStatus === 'disabled' ||
      isRetiredByDate
    ) {
      if (entry.replacementModelId) {
        const replacement = this.registry.get(entry.replacementModelId);
        if (replacement && replacement.enabled && replacement.operationalStatus === 'active') {
          return {
            usable: true,
            resolvedModel: replacement,
            migratedFrom: entry.modelId,
            reason: `Migrated from retired/disabled model '${entry.modelId}' to '${replacement.modelId}'`,
          };
        }
      }
      return {
        usable: false,
        reason: `Model '${entry.modelId}' is ${isRetiredByDate ? 'past retirement date' : entry.operationalStatus}`,
      };
    }

    return { usable: true, resolvedModel: entry };
  }

  /**
   * Transition a model's operational status and record a lifecycle event.
   */
  transitionStatus(
    modelId: string,
    newStatus: OperationalStatus,
    reason: string,
    replacementModelId?: string,
  ): LifecycleHealthEvent {
    const entry = this.registry.get(modelId);
    if (!entry) {
      throw new Error(`Cannot transition unknown model '${modelId}'`);
    }
    const previousStatus = entry.operationalStatus;
    const enabled = newStatus === 'active' || newStatus === 'degraded' || newStatus === 'deprecated';
    this.registry.updateModel(modelId, {
      operationalStatus: newStatus,
      enabled,
      ...(replacementModelId ? { replacementModelId } : {}),
    });

    const event: LifecycleHealthEvent = {
      modelId: entry.modelId,
      previousStatus,
      newStatus,
      reason,
      replacementModelId: replacementModelId ?? entry.replacementModelId,
      timestamp: new Date().toISOString(),
    };
    this.events.push(event);
    return event;
  }

  /**
   * Update pricing and Neuron rates for a model when provider rates change.
   */
  updatePricing(
    modelId: string,
    rates: {
      inputPricePerMUsd?: number;
      outputPricePerMUsd?: number;
      cachedInputPricePerMUsd?: number;
      inputNeuronsPerM?: number;
      outputNeuronsPerM?: number;
    },
  ): ModelCapabilityEntry {
    return this.registry.updateModel(modelId, rates);
  }

  getEvents(): ReadonlyArray<LifecycleHealthEvent> {
    return this.events;
  }
}
