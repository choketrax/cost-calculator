/**
 * Usage Normalizer
 *
 * Normalizes disparate provider usage payloads (Workers AI, OpenAI/OpenRouter, MiniMind)
 * into a unified token and Neuron accounting structure.
 */

import { ModelCapabilityEntry } from './model-registry';

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  estimatedNeurons: number;
  actualNeurons?: number;
}

export class UsageNormalizer {
  normalize(
    rawUsage: any,
    modelEntry: ModelCapabilityEntry | undefined,
    fallbackEstimate: { inputTokens: number; outputTokens: number },
  ): NormalizedUsage {
    const inputTokens =
      Number(rawUsage?.prompt_tokens ?? rawUsage?.input_tokens ?? fallbackEstimate.inputTokens) || 0;
    const outputTokens =
      Number(rawUsage?.completion_tokens ?? rawUsage?.output_tokens ?? fallbackEstimate.outputTokens) || 0;
    const cachedTokens =
      Number(
        rawUsage?.prompt_tokens_details?.cached_tokens ??
          rawUsage?.cached_tokens ??
          0,
      ) || 0;
    const totalTokens = Number(rawUsage?.total_tokens) || inputTokens + outputTokens;

    let estimatedNeurons = 0;
    if (modelEntry && modelEntry.provider === 'workers-ai') {
      const billableUncachedInput = Math.max(0, inputTokens - cachedTokens);
      const cachedInputWeight = cachedTokens * 0.5;
      estimatedNeurons =
        ((billableUncachedInput + cachedInputWeight) / 1_000_000) * modelEntry.inputNeuronsPerM +
        (outputTokens / 1_000_000) * modelEntry.outputNeuronsPerM;
    }

    const actualNeurons =
      typeof rawUsage?.neurons === 'number'
        ? rawUsage.neurons
        : typeof rawUsage?.cf_neurons === 'number'
          ? rawUsage.cf_neurons
          : undefined;

    return {
      inputTokens,
      outputTokens,
      cachedTokens,
      totalTokens,
      estimatedNeurons: Number(estimatedNeurons.toFixed(4)),
      actualNeurons,
    };
  }
}
