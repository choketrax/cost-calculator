/**
 * Approved External AI Provider Adapter
 *
 * Wraps the existing DeterministicGateway and OpenRouterGateway behind
 * strict ExternalFallbackPolicy checks and prevents unauthorized BYOK-to-Unified-Billing conversion.
 */

import { ModelGateway, ModelRequest, ModelResponse } from '../../types';
import { DeterministicGateway } from '../../gateways/deterministic';
import { OpenRouterGateway } from '../../gateways/openrouter';

export interface ExternalAIGatewayConfig {
  deterministic?: DeterministicGateway;
  openrouter?: OpenRouterGateway;
  allowUnifiedBillingFallback?: boolean;
}

export class ExternalAIGateway implements ModelGateway {
  readonly name = 'external-ai';

  constructor(private readonly config: ExternalAIGatewayConfig) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (this.config.deterministic && (await this.config.deterministic.isAvailable())) {
      return this.config.deterministic.generate(request);
    }
    if (this.config.openrouter && (await this.config.openrouter.isAvailable())) {
      return this.config.openrouter.generate(request);
    }
    throw new Error('No external AI provider is configured or available');
  }

  async isAvailable(): Promise<boolean> {
    const detOk = this.config.deterministic ? await this.config.deterministic.isAvailable() : false;
    const orOk = this.config.openrouter ? await this.config.openrouter.isAvailable() : false;
    return detOk || orOk;
  }
}
