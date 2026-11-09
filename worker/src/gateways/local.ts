import { ModelGateway, ModelRequest, ModelResponse } from '../types';

/** Configuration for local/self-hosted model gateway */
export interface LocalGatewayConfig {
  baseUrl: string;         // e.g. http://localhost:8080/v1
  apiKey?: string;
  models: string[];        // available local models, e.g. ['minimind', 'nanojev']
  maxTokens?: number;      // max context window for local models
  timeoutMs?: number;      // defaults to 30000
}

/**
 * Local model gateway for self-hosted models.
 * Supports MiniMind, NanoJev, vLLM, or any OpenAI-compatible local endpoint.
 * Used when SCP policy allows and the workload qualifies for local inference.
 */
export class LocalGateway implements ModelGateway {
  readonly name = 'local';
  private readonly config: Required<LocalGatewayConfig>;
  
  constructor(config: LocalGatewayConfig) {
    this.config = {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey ?? '',
      models: config.models,
      maxTokens: config.maxTokens ?? 4096,
      timeoutMs: config.timeoutMs ?? 30000,
    };
  }
  
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const model = request.model || this.config.models[0];
    
    const body: Record<string, unknown> = {
      model,
      messages: request.messages,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.max_tokens !== undefined) {
      body.max_tokens = Math.min(request.max_tokens, this.config.maxTokens);
    }
    if (request.tools) body.tools = request.tools;
    if (request.response_format) body.response_format = request.response_format;
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
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
        throw new Error(`Local gateway returned ${response.status}: ${errorBody}`);
      }
      
      const data = await response.json() as ModelResponse;
      data._routing = {
        selectedProvider: 'local',
        selectedModel: model,
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
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(`${this.config.baseUrl}/models`, {
          method: 'GET',
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
  
  /** Check if a model is available locally */
  canHandle(model: string): boolean {
    return this.config.models.includes(model);
  }
  
  /** Check if request is within local model capabilities */
  canHandleRequest(request: ModelRequest): boolean {
    const inputTokenEstimate = request.messages.reduce((sum, m) => {
      const content = m.content;
      return sum + Math.ceil(typeof content === 'string' ? content.length / 4 : 100);
    }, 0);
    return inputTokenEstimate <= this.config.maxTokens;
  }
}
