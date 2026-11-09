/**
 * Workers AI Neuron Pricing & Billing Mode Calculator (Section 2 & 10)
 *
 * Implements standard Workers AI Neuron pricing ($0.011 per 1,000 Neurons = $11 / 1M Neurons),
 * daily free Neuron allocation deduction, cached-token discount handling,
 * and reconciliation without double-billing requests routed through Cloudflare AI Gateway.
 */

import { ModelCapabilityEntry } from '../inference/model-registry';

export type WorkersAIBillingMode =
  | 'standard_neurons'
  | 'prepaid_gateway_credits'
  | 'byok_passthrough';

export const USD_PER_THOUSAND_NEURONS = 0.011;
export const USD_PER_NEURON = USD_PER_THOUSAND_NEURONS / 1000; // 0.000011
export const DEFAULT_DAILY_FREE_NEURONS = 10000;

export interface NeuronChargeInput {
  model: ModelCapabilityEntry;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  reportedActualNeurons?: number;
  billingMode?: WorkersAIBillingMode;
  remainingDailyFreeNeurons?: number;
  aiGatewayRouted?: boolean;
}

export interface NeuronChargeCalculation {
  estimatedNeurons: number;
  effectiveNeurons: number;
  freeTierNeuronsApplied: number;
  billableNeurons: number;
  estimatedCostUsd: number;
  billedCostUsd: number;
  billingMode: WorkersAIBillingMode;
  aiGatewayDeduplicated: boolean;
}

export class NeuronPricingCalculator {
  constructor(
    private readonly defaultBillingMode: WorkersAIBillingMode = 'standard_neurons',
  ) {}

  calculate(input: NeuronChargeInput): NeuronChargeCalculation {
    const billingMode = input.billingMode ?? this.defaultBillingMode;
    const cachedTokens = Math.min(input.inputTokens, Math.max(0, input.cachedTokens ?? 0));
    const uncachedInputTokens = Math.max(0, input.inputTokens - cachedTokens);

    // Cached tokens use cachedInputPricePerMUsd (50% weight for Neurons)
    const effectiveInputTokensForNeurons = uncachedInputTokens + cachedTokens * 0.5;

    let estimatedNeurons = 0;
    if (input.model.provider === 'workers-ai') {
      estimatedNeurons =
        (effectiveInputTokensForNeurons / 1_000_000) * input.model.inputNeuronsPerM +
        (input.outputTokens / 1_000_000) * input.model.outputNeuronsPerM;
    }
    estimatedNeurons = Number(estimatedNeurons.toFixed(4));

    const effectiveNeurons =
      typeof input.reportedActualNeurons === 'number' && input.reportedActualNeurons >= 0
        ? Number(input.reportedActualNeurons.toFixed(4))
        : estimatedNeurons;

    const remainingFree = Math.max(0, input.remainingDailyFreeNeurons ?? 0);
    let freeTierNeuronsApplied = 0;
    let billableNeurons = effectiveNeurons;

    if (input.model.provider === 'workers-ai' && billingMode === 'standard_neurons') {
      freeTierNeuronsApplied = Number(Math.min(effectiveNeurons, remainingFree).toFixed(4));
      billableNeurons = Number(Math.max(0, effectiveNeurons - freeTierNeuronsApplied).toFixed(4));
    } else if (input.model.provider !== 'workers-ai') {
      billableNeurons = 0;
    }

    // Calculate USD
    let estimatedCostUsd = 0;
    let billedCostUsd = 0;

    if (input.model.provider === 'workers-ai') {
      estimatedCostUsd = Number((estimatedNeurons * USD_PER_NEURON).toFixed(8));
      if (billingMode === 'standard_neurons') {
        billedCostUsd = Number((billableNeurons * USD_PER_NEURON).toFixed(8));
      } else if (billingMode === 'prepaid_gateway_credits') {
        // Reconciled against prepaid AI Gateway credit pool — do not double-charge standard Workers AI
        billedCostUsd = Number((effectiveNeurons * USD_PER_NEURON).toFixed(8));
      } else {
        billedCostUsd = 0;
      }
    } else {
      // Non-Workers AI (MiniMind or External LLM)
      const uncachedCost = (uncachedInputTokens / 1_000_000) * input.model.inputPricePerMUsd;
      const cachedCost = (cachedTokens / 1_000_000) * input.model.cachedInputPricePerMUsd;
      const outputCost = (input.outputTokens / 1_000_000) * input.model.outputPricePerMUsd;
      estimatedCostUsd = Number((uncachedCost + cachedCost + outputCost).toFixed(8));
      billedCostUsd = billingMode === 'byok_passthrough' ? 0 : estimatedCostUsd;
    }

    return {
      estimatedNeurons,
      effectiveNeurons,
      freeTierNeuronsApplied,
      billableNeurons,
      estimatedCostUsd,
      billedCostUsd,
      billingMode,
      // Ensures AI Gateway observation does not add a second charge on top of Workers AI
      aiGatewayDeduplicated: Boolean(input.aiGatewayRouted),
    };
  }
}
