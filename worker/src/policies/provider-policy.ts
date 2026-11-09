/**
 * Provider Allowlist Policy Engine
 *
 * Enforces an allowlisted provider chain rather than unrestricted model discovery.
 * Restricts eligible inference providers to Workers AI by default.
 */

export const DEFAULT_ALLOWED_INFERENCE_PROVIDERS = ['workers-ai', 'minimind'] as const;

export class ProviderPolicyEngine {
  isProviderAllowed(
    provider: string,
    options: {
      tenantExternalLlmEnabled?: boolean;
      explicitAllowedProviders?: string[];
    } = {},
  ): boolean {
    if (provider === 'workers-ai' || provider === 'minimind' || provider === 'deterministic-local') {
      if (options.explicitAllowedProviders && options.explicitAllowedProviders.length > 0) {
        return options.explicitAllowedProviders.includes(provider);
      }
      return true;
    }

    // External providers (openai, anthropic, google, openrouter) require explicit tenant enablement
    if (!options.tenantExternalLlmEnabled) {
      return false;
    }

    if (options.explicitAllowedProviders && options.explicitAllowedProviders.length > 0) {
      return options.explicitAllowedProviders.includes(provider);
    }

    return false;
  }
}
