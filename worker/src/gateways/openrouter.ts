import { ModelGateway, ModelRequest, ModelResponse } from '../types';

/** Configuration for the OpenRouter gateway */
export interface OpenRouterConfig {
  apiKey: string;
  baseUrl?: string;        // defaults to https://openrouter.ai/api/v1
  siteUrl?: string;        // X-Title / HTTP-Referer for OpenRouter rankings
  siteName?: string;
  defaultModel?: string;   // defaults to 'typesafe/jev-router'
  timeoutMs?: number;      // defaults to 60000
}

/**
 * OpenRouter gateway adapter.
 * 
 * Handles communication with OpenRouter API, supporting both:
 * - Jev Router (model: "typesafe/jev-router") for intelligent model selection
 * - Direct model routing (any OpenRouter-supported model)
 * 
 * This gateway is called AFTER SCP policy evaluation.
 * SCP decides what Jev Router is allowed to do.
 * Jev Router decides which eligible model should handle the task.
 */
export class OpenRouterGateway implements ModelGateway {
  readonly name = 'openrouter';
  private readonly config: Required<OpenRouterConfig>;
  
  constructor(config: OpenRouterConfig) {
    this.config = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://openrouter.ai/api/v1',
      siteUrl: config.siteUrl ?? '',
      siteName: config.siteName ?? 'SCP',
      defaultModel: config.defaultModel ?? 'typesafe/jev-router',
      timeoutMs: config.timeoutMs ?? 60000,
    };
  }
  
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const model = request.model || this.config.defaultModel;
    
    // Build the OpenRouter request body (OpenAI-compatible)
    const body: Record<string, unknown> = {
      model,
      messages: request.messages,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.tools) body.tools = request.tools;
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;
    if (request.response_format) body.response_format = request.response_format;
    if (request.stream !== undefined) body.stream = request.stream;
    
    // If SCP provides routing constraints, pass them as provider preferences
    // OpenRouter supports route filtering via the 'route' parameter
    if (request._scp) {
      const transforms: Record<string, unknown> = {};
      if (request._scp.allowedProviders?.length) {
        // OpenRouter provider routing - use provider field
        transforms.provider = { 
          order: request._scp.allowedProviders,
          allow_fallbacks: true 
        };
      }
      if (Object.keys(transforms).length > 0) {
        body.transforms = transforms;
      }
    }
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
    };
    if (this.config.siteUrl) {
      headers['HTTP-Referer'] = this.config.siteUrl;
    }
    if (this.config.siteName) {
      headers['X-Title'] = this.config.siteName;
    }
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    
    try {
      const startTime = Date.now();
      
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      
      const latencyMs = Date.now() - startTime;
      
      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'Unknown error');
        throw new OpenRouterError(
          `OpenRouter returned ${response.status}: ${errorBody}`,
          response.status,
          errorBody,
        );
      }
      
      const data = await response.json() as ModelResponse;
      
      // Extract Jev Router routing metadata if available
      // OpenRouter may include the actual selected model in the response
      const selectedModel = data.model;
      data._routing = {
        selectedProvider: this.extractProvider(selectedModel),
        selectedModel: selectedModel,
        routerModel: model === 'typesafe/jev-router' ? 'jev-router' : undefined,
        routerLatencyMs: latencyMs,
      };
      
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }
  
  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(`${this.config.baseUrl}/models`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
          signal: controller.signal,
        });
        return response.ok;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return false;
    }
  }
  
  /** Extract provider name from a model ID (e.g., 'openai/gpt-4o' -> 'openai') */
  private extractProvider(modelId: string): string | undefined {
    const slashIndex = modelId.indexOf('/');
    return slashIndex > 0 ? modelId.substring(0, slashIndex) : undefined;
  }
}

/** Custom error class for OpenRouter failures */
export class OpenRouterError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}
