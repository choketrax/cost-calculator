import { ModelGateway, ModelRequest, ModelResponse } from '../types';

/** Configuration for deterministic (direct provider) gateway */
export interface DeterministicGatewayConfig {
  /** Provider base URLs, keyed by provider name */
  providers: Record<string, { baseUrl: string; apiKey: string }>;
  timeoutMs?: number;
}

/**
 * Deterministic gateway — routes to a specific provider/model.
 * Used when SCP policy explicitly requires a particular model
 * (e.g., customer contract requires GPT-family models only).
 * Also serves as fallback when Jev Router is unavailable.
 */
export class DeterministicGateway implements ModelGateway {
  readonly name = 'deterministic';
  private readonly providers: Record<string, { baseUrl: string; apiKey: string }>;
  private readonly timeoutMs: number;
  
  constructor(config: DeterministicGatewayConfig) {
    this.providers = config.providers;
    this.timeoutMs = config.timeoutMs ?? 60000;
  }
  
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const { provider, modelId } = this.parseModel(request.model);
    const providerConfig = this.providers[provider];
    
    if (!providerConfig) {
      throw new Error(`Provider '${provider}' not configured in deterministic gateway. Available: ${Object.keys(this.providers).join(', ')}`);
    }
    
    const body: Record<string, unknown> = {
      model: modelId,
      messages: request.messages,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.tools) body.tools = request.tools;
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;
    if (request.response_format) body.response_format = request.response_format;
    if (request.stream !== undefined) body.stream = request.stream;
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    
    try {
      const startTime = Date.now();
      const response = await fetch(`${providerConfig.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${providerConfig.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startTime;
      
      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'Unknown error');
        throw new Error(`Provider '${provider}' returned ${response.status}: ${errorBody}`);
      }
      
      const data = await response.json() as ModelResponse;
      data._routing = {
        selectedProvider: provider,
        selectedModel: modelId,
        routerLatencyMs: latencyMs,
      };
      
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }
  
  async isAvailable(): Promise<boolean> {
    return Object.keys(this.providers).length > 0;
  }
  
  /**
   * Parse a model string into provider + model ID.
   * Supports formats: 'openai/gpt-4o', 'gpt-4o' (defaults to openai)
   */
  private parseModel(model: string): { provider: string; modelId: string } {
    const slashIndex = model.indexOf('/');
    if (slashIndex > 0) {
      return {
        provider: model.substring(0, slashIndex),
        modelId: model.substring(slashIndex + 1),
      };
    }
    // Default provider mapping for common models
    if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) return { provider: 'openai', modelId: model };
    if (model.startsWith('claude-')) return { provider: 'anthropic', modelId: model };
    if (model.startsWith('gemini-')) return { provider: 'google', modelId: model };
    if (model.startsWith('deepseek-')) return { provider: 'deepseek', modelId: model };
    // Default to openai
    return { provider: 'openai', modelId: model };
  }
}
