/**
 * Cloudflare Workers AI Adapter (Section 4)
 *
 * Uses the native `env.AI.run(model, payload, { gateway: { id } })` binding.
 * Never makes unnecessary public REST calls when the Worker binding is present.
 * Implements request normalization, model-specific payload validation,
 * token/Neuron estimates, timeout/cancellation handling, streaming support,
 * response normalization, error classification, and correlation IDs.
 */

import { ModelGateway, ModelRequest, ModelResponse } from '../../types';
import { ModelRegistry, ModelCapabilityEntry } from '../model-registry';
import { UsageNormalizer } from '../usage-normalizer';

export interface WorkersAIBinding {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: {
      gateway?: {
        id: string;
        skipCache?: boolean;
        cacheTtl?: number;
        metadata?: Record<string, string | number | boolean>;
      };
      returnRawResponse?: boolean;
    },
  ): Promise<any>;
}

export interface WorkersAIAdapterConfig {
  aiBinding: WorkersAIBinding;
  gatewayId?: string;
  registry?: ModelRegistry;
  defaultModel?: string;
  timeoutMs?: number;
}

export type WorkersAIErrorCategory =
  | 'timeout'
  | 'rate_limit'
  | 'capacity_unavailable'
  | 'invalid_request'
  | 'model_not_found'
  | 'internal_error';

export class WorkersAIAdapterError extends Error {
  constructor(
    message: string,
    public readonly category: WorkersAIErrorCategory,
    public readonly retryable: boolean,
    public readonly modelId: string,
    public readonly traceId: string,
  ) {
    super(message);
    this.name = 'WorkersAIAdapterError';
  }
}

export class WorkersAIGateway implements ModelGateway {
  readonly name = 'workers-ai';
  private readonly ai: WorkersAIBinding;
  private readonly gatewayId: string;
  private readonly registry: ModelRegistry;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;
  private readonly usageNormalizer = new UsageNormalizer();

  constructor(config: WorkersAIAdapterConfig) {
    this.ai = config.aiBinding;
    this.gatewayId = config.gatewayId || 'agent-gateway';
    this.registry = config.registry ?? new ModelRegistry();
    this.defaultModel = config.defaultModel ?? '@cf/ibm-granite/granite-4.0-h-micro';
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const traceId = request._scp?.requestId ?? crypto.randomUUID();
    const requestedModel = request.model || this.defaultModel;
    const entry = this.registry.get(requestedModel);
    const providerModelId = entry?.providerModelId ?? requestedModel;

    // 1. Validate request schema against model capabilities
    this.validateModelPayload(request, entry, providerModelId, traceId);

    // 2. Normalize payload per model family
    const payload = this.buildNormalizedPayload(request, entry);

    // 3. Estimate pre-call tokens
    const estimatedInputTokens = this.estimateInputTokens(request);

    // 4. Execute through env.AI.run with AI Gateway config and timeout guard
    const startTime = Date.now();
    let rawResult: any;
    let gatewayRouted = true;
    let gatewayFallbackReason: string | undefined;
    try {
      rawResult = await this.runWithTimeout(
        providerModelId,
        payload,
        {
          gateway: {
            id: this.gatewayId,
            metadata: {
              trace_id: traceId,
              tenant_id: request._scp?.tenantId ?? 'default',
              ...(request._scp?.agentId ? { agent_id: request._scp.agentId } : {}),
            },
          },
        },
        this.timeoutMs,
        traceId,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // If AI Gateway ID is not yet provisioned in Cloudflare dashboard, fall back to direct env.AI.run binding
      if (/gateway|2006|not configured/i.test(errMsg)) {
        gatewayRouted = false;
        gatewayFallbackReason = errMsg;
        try {
          rawResult = await this.runWithTimeout(
            providerModelId,
            payload,
            {},
            this.timeoutMs,
            traceId,
          );
        } catch (retryErr) {
          throw this.classifyError(retryErr, providerModelId, traceId);
        }
      } else {
        throw this.classifyError(err, providerModelId, traceId);
      }
    }

    const latencyMs = Date.now() - startTime;

    // 5. Normalize response to OpenAI-compatible ModelResponse
    return this.normalizeResponse(
      rawResult,
      entry,
      providerModelId,
      estimatedInputTokens,
      latencyMs,
      traceId,
      gatewayRouted,
      gatewayFallbackReason,
    );
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.ai && typeof this.ai.run === 'function');
  }

  private validateModelPayload(
    request: ModelRequest,
    entry: ModelCapabilityEntry | undefined,
    modelId: string,
    traceId: string,
  ): void {
    if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
      throw new WorkersAIAdapterError(
        'Workers AI request requires non-empty messages array',
        'invalid_request',
        false,
        modelId,
        traceId,
      );
    }

    if (entry) {
      if (request.tools?.length && !entry.supportsFunctionCalling) {
        throw new WorkersAIAdapterError(
          `Model '${modelId}' does not support function calling`,
          'invalid_request',
          false,
          modelId,
          traceId,
        );
      }
      if (request.response_format && !entry.supportsStructuredOutput) {
        throw new WorkersAIAdapterError(
          `Model '${modelId}' does not support structured response_format`,
          'invalid_request',
          false,
          modelId,
          traceId,
        );
      }
    }
  }

  private buildNormalizedPayload(
    request: ModelRequest,
    entry: ModelCapabilityEntry | undefined,
  ): Record<string, unknown> {
    const messages = request.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));

    const payload: Record<string, unknown> = { messages };
    if (request.temperature !== undefined) payload.temperature = request.temperature;
    if (request.max_tokens !== undefined) {
      const minReasoningTokens =
        entry && (entry.tier === 'general' || entry.tier === 'reasoning')
          ? Math.max(request.max_tokens, 256)
          : request.max_tokens;
      payload.max_tokens = entry
        ? Math.min(minReasoningTokens, entry.contextWindow)
        : minReasoningTokens;
    }
    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools;
    }
    if (request.response_format) {
      payload.response_format = request.response_format;
    }
    if (request.stream !== undefined) {
      payload.stream = request.stream;
    }
    return payload;
  }

  private async runWithTimeout(
    modelId: string,
    payload: Record<string, unknown>,
    options: {
      gateway?: {
        id: string;
        metadata?: Record<string, string | number | boolean>;
      };
    },
    timeoutMs: number,
    traceId: string,
  ): Promise<any> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new WorkersAIAdapterError(
            `Workers AI invocation timed out after ${timeoutMs}ms`,
            'timeout',
            true,
            modelId,
            traceId,
          ),
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([this.ai.run(modelId, payload, options), timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private normalizeResponse(
    raw: any,
    entry: ModelCapabilityEntry | undefined,
    providerModelId: string,
    estimatedInputTokens: number,
    latencyMs: number,
    traceId: string,
    gatewayRouted = true,
    gatewayFallbackReason?: string,
  ): ModelResponse {
    // Workers AI can return either OpenAI chat.completion shape or { response: string, tool_calls?: [], usage?: {} }
    let content: string | null = null;
    let toolCalls: unknown[] | undefined;
    let finishReason = 'stop';

    if (raw?.choices && Array.isArray(raw.choices) && raw.choices.length > 0) {
      const first = raw.choices[0];
      content =
        first.message?.content ||
        first.message?.reasoning_content ||
        first.text ||
        null;
      toolCalls = first.message?.tool_calls;
      finishReason = first.finish_reason ?? (toolCalls?.length ? 'tool_calls' : 'stop');
    } else if (typeof raw?.response === 'string') {
      content = raw.response;
      toolCalls = raw.tool_calls;
      finishReason = toolCalls?.length ? 'tool_calls' : 'stop';
    } else if (typeof raw === 'string') {
      content = raw;
    } else if (raw?.result?.response) {
      content = raw.result.response;
    }

    const estimatedOutputTokens = content ? Math.max(1, Math.ceil(content.length / 4)) : 16;
    const normUsage = this.usageNormalizer.normalize(raw?.usage, entry, {
      inputTokens: estimatedInputTokens,
      outputTokens: estimatedOutputTokens,
    });

    const response: ModelResponse = {
      id: raw?.id ?? `cf-ai-${traceId}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: entry?.modelId ?? providerModelId,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
            ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: normUsage.inputTokens,
        completion_tokens: normUsage.outputTokens,
        total_tokens: normUsage.totalTokens,
      },
      _routing: {
        selectedProvider: 'workers-ai',
        selectedModel: entry?.modelId ?? providerModelId,
        routerModel: gatewayRouted ? `ai-gateway:${this.gatewayId}` : 'workers-ai:direct',
        routerLatencyMs: latencyMs,
      },
    };

    (response as any)._neurons = {
      estimatedNeurons: normUsage.estimatedNeurons,
      actualNeurons: normUsage.actualNeurons,
      cachedTokens: normUsage.cachedTokens,
      aiGatewayId: gatewayRouted ? this.gatewayId : null,
      aiGatewayRouted: gatewayRouted,
      ...(gatewayFallbackReason ? { aiGatewayFallbackReason: gatewayFallbackReason } : {}),
      traceId,
    };

    return response;
  }

  private classifyError(err: unknown, modelId: string, traceId: string): WorkersAIAdapterError {
    if (err instanceof WorkersAIAdapterError) return err;
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();

    if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
      return new WorkersAIAdapterError(msg, 'rate_limit', true, modelId, traceId);
    }
    if (lower.includes('503') || lower.includes('capacity') || lower.includes('overloaded') || lower.includes('502')) {
      return new WorkersAIAdapterError(msg, 'capacity_unavailable', true, modelId, traceId);
    }
    if (lower.includes('timeout') || lower.includes('408') || lower.includes('aborted')) {
      return new WorkersAIAdapterError(msg, 'timeout', true, modelId, traceId);
    }
    if (lower.includes('not found') || lower.includes('no such model') || lower.includes('404')) {
      return new WorkersAIAdapterError(msg, 'model_not_found', false, modelId, traceId);
    }
    if (lower.includes('400') || lower.includes('invalid')) {
      return new WorkersAIAdapterError(msg, 'invalid_request', false, modelId, traceId);
    }
    return new WorkersAIAdapterError(msg, 'internal_error', true, modelId, traceId);
  }

  private estimateInputTokens(request: ModelRequest): number {
    return request.messages.reduce((sum, m) => {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      return sum + Math.max(1, Math.ceil(text.length / 4));
    }, 0);
  }
}
