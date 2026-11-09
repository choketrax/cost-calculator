/**
 * Configurable Model Registry for Cloudflare AgentGateway v2.0 / v3.0
 *
 * Avoids hard-coding model IDs across the application.
 * Stores model capabilities, Neuron rates, USD pricing, data classification constraints,
 * tenant availability, and operational status.
 */

export type ModelTier =
  | 'deterministic'
  | 'lightweight'
  | 'general'
  | 'reasoning'
  | 'minimind'
  | 'external';

export type OperationalStatus =
  | 'active'
  | 'degraded'
  | 'deprecated'
  | 'retired'
  | 'disabled'
  | 'unverified';

export type DataClassificationLevel = 'public' | 'internal' | 'confidential' | 'restricted';

export interface ModelCapabilityEntry {
  /** Primary model ID (or canonical requested alias) */
  modelId: string;
  /** Resolved provider-side model ID (e.g., '@cf/google/gemma-4-26b-a4b-it') */
  providerModelId: string;
  /** Alias mappings (e.g., '@cf/google/gemma-4-26b-a4b' -> '-it') */
  aliases?: string[];
  provider: 'workers-ai' | 'minimind' | 'openai' | 'anthropic' | 'google' | 'deepseek' | 'openrouter';
  tier: ModelTier;
  /** Input price per 1M tokens in USD */
  inputPricePerMUsd: number;
  /** Output price per 1M tokens in USD */
  outputPricePerMUsd: number;
  /** Cached input price per 1M tokens in USD */
  cachedInputPricePerMUsd: number;
  /** Workers AI input Neurons per 1M tokens (0 for non-Workers AI) */
  inputNeuronsPerM: number;
  /** Workers AI output Neurons per 1M tokens (0 for non-Workers AI) */
  outputNeuronsPerM: number;
  contextWindow: number;
  supportsStreaming: boolean;
  supportsFunctionCalling: boolean;
  supportsStructuredOutput: boolean;
  supportsVision: boolean;
  regionConstraints: string[];
  allowedDataClasses: DataClassificationLevel[];
  /** '*' for all authorized tenants, or specific tenant IDs */
  tenantAllowlist: string[];
  operationalStatus: OperationalStatus;
  enabled: boolean;
  retirementDate?: string;
  replacementModelId?: string;
  qualityBaseline: number;
  avgLatencyMs: number;
}

/**
 * Default Workers AI & External Model Registry.
 *
 * Workers AI Neuron conversion standard: $0.011 per 1,000 Neurons ($11 per 1M Neurons).
 * Therefore, 1M Neurons = $11.00; Neurons_per_M_tokens = (Price_per_M_USD / 0.011) * 1000.
 */
export const DEFAULT_MODEL_REGISTRY: ReadonlyArray<ModelCapabilityEntry> = [
  // 1. Workers AI Lightweight tier (Synced against live Cloudflare catalog 2026-11-08)
  {
    modelId: '@cf/ibm-granite/granite-4.0-h-micro',
    providerModelId: '@cf/ibm-granite/granite-4.0-h-micro',
    provider: 'workers-ai',
    tier: 'lightweight',
    inputPricePerMUsd: 0.035,
    outputPricePerMUsd: 0.11,
    cachedInputPricePerMUsd: 0.0175,
    inputNeuronsPerM: 3182,
    outputNeuronsPerM: 10000,
    contextWindow: 131000,
    supportsStreaming: true,
    supportsFunctionCalling: true,
    supportsStructuredOutput: true,
    supportsVision: false,
    regionConstraints: ['global'],
    allowedDataClasses: ['public', 'internal', 'confidential'],
    tenantAllowlist: ['*'],
    operationalStatus: 'active',
    enabled: true,
    qualityBaseline: 0.78,
    avgLatencyMs: 210,
  },
  {
    modelId: '@cf/zai-org/glm-4.7-flash',
    providerModelId: '@cf/zai-org/glm-4.7-flash',
    provider: 'workers-ai',
    tier: 'lightweight',
    inputPricePerMUsd: 0.0605,
    outputPricePerMUsd: 0.40,
    cachedInputPricePerMUsd: 0.03025,
    inputNeuronsPerM: 5500,
    outputNeuronsPerM: 36364,
    contextWindow: 131072,
    supportsStreaming: true,
    supportsFunctionCalling: true,
    supportsStructuredOutput: true,
    supportsVision: false,
    regionConstraints: ['global'],
    allowedDataClasses: ['public', 'internal', 'confidential'],
    tenantAllowlist: ['*'],
    operationalStatus: 'active',
    enabled: true,
    qualityBaseline: 0.82,
    avgLatencyMs: 280,
  },

  // 2. Workers AI General tier (Synced against live Cloudflare catalog 2026-11-08)
  {
    modelId: '@cf/google/gemma-4-26b-a4b',
    providerModelId: '@cf/google/gemma-4-26b-a4b-it',
    aliases: ['@cf/google/gemma-4-26b-a4b-it'],
    provider: 'workers-ai',
    tier: 'general',
    inputPricePerMUsd: 0.10,
    outputPricePerMUsd: 0.30,
    cachedInputPricePerMUsd: 0.05,
    inputNeuronsPerM: 9091,
    outputNeuronsPerM: 27273,
    contextWindow: 256000,
    supportsStreaming: true,
    supportsFunctionCalling: true,
    supportsStructuredOutput: true,
    supportsVision: true,
    regionConstraints: ['global'],
    allowedDataClasses: ['public', 'internal', 'confidential'],
    tenantAllowlist: ['*'],
    operationalStatus: 'active',
    enabled: true,
    qualityBaseline: 0.88,
    avgLatencyMs: 490,
  },
  {
    modelId: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    providerModelId: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    provider: 'workers-ai',
    tier: 'general',
    inputPricePerMUsd: 0.30,
    outputPricePerMUsd: 1.20,
    cachedInputPricePerMUsd: 0.006,
    inputNeuronsPerM: 27273,
    outputNeuronsPerM: 109091,
    contextWindow: 1048576,
    supportsStreaming: true,
    supportsFunctionCalling: true,
    supportsStructuredOutput: true,
    supportsVision: true,
    regionConstraints: ['global'],
    allowedDataClasses: ['public', 'internal', 'confidential'],
    tenantAllowlist: ['*'],
    operationalStatus: 'active',
    enabled: true,
    qualityBaseline: 0.90,
    avgLatencyMs: 420,
  },

  // 3. Workers AI Advanced Reasoning tier (Synced against live Cloudflare catalog 2026-11-08)
  {
    modelId: '@cf/zai-org/glm-5.3',
    providerModelId: '@cf/zai-org/glm-5.3',
    provider: 'workers-ai',
    tier: 'reasoning',
    inputPricePerMUsd: 1.40,
    outputPricePerMUsd: 4.40,
    cachedInputPricePerMUsd: 0.26,
    inputNeuronsPerM: 127273,
    outputNeuronsPerM: 400000,
    contextWindow: 1048576,
    supportsStreaming: true,
    supportsFunctionCalling: true,
    supportsStructuredOutput: true,
    supportsVision: false,
    regionConstraints: ['global'],
    allowedDataClasses: ['public', 'internal', 'confidential'],
    tenantAllowlist: ['*'],
    operationalStatus: 'active',
    enabled: true,
    qualityBaseline: 0.94,
    avgLatencyMs: 950,
  },

  // 4. MiniMind internal inference service
  {
    modelId: 'minimind/specialist-v1',
    providerModelId: 'minimind',
    aliases: ['minimind', 'nanojev'],
    provider: 'minimind',
    tier: 'minimind',
    inputPricePerMUsd: 0.02,
    outputPricePerMUsd: 0.05,
    cachedInputPricePerMUsd: 0.01,
    inputNeuronsPerM: 0,
    outputNeuronsPerM: 0,
    contextWindow: 32768,
    supportsStreaming: true,
    supportsFunctionCalling: true,
    supportsStructuredOutput: true,
    supportsVision: false,
    regionConstraints: ['global'],
    allowedDataClasses: ['public', 'internal', 'confidential', 'restricted'],
    tenantAllowlist: ['*'],
    operationalStatus: 'active',
    enabled: true,
    qualityBaseline: 0.85,
    avgLatencyMs: 180,
  },

  // 5. External LLM registry — DISABLED by default unless policy-authorized
  {
    modelId: 'openai/gpt-4o',
    providerModelId: 'gpt-4o',
    aliases: ['gpt-4o'],
    provider: 'openai',
    tier: 'external',
    inputPricePerMUsd: 2.50,
    outputPricePerMUsd: 10.00,
    cachedInputPricePerMUsd: 1.25,
    inputNeuronsPerM: 0,
    outputNeuronsPerM: 0,
    contextWindow: 128000,
    supportsStreaming: true,
    supportsFunctionCalling: true,
    supportsStructuredOutput: true,
    supportsVision: true,
    regionConstraints: ['us', 'eu'],
    allowedDataClasses: ['public', 'internal'],
    tenantAllowlist: [],
    operationalStatus: 'disabled',
    enabled: false,
    qualityBaseline: 0.95,
    avgLatencyMs: 850,
  },
  {
    modelId: 'anthropic/claude-3-5-sonnet',
    providerModelId: 'claude-3-5-sonnet-latest',
    aliases: ['claude-3-5-sonnet'],
    provider: 'anthropic',
    tier: 'external',
    inputPricePerMUsd: 3.00,
    outputPricePerMUsd: 15.00,
    cachedInputPricePerMUsd: 0.30,
    inputNeuronsPerM: 0,
    outputNeuronsPerM: 0,
    contextWindow: 200000,
    supportsStreaming: true,
    supportsFunctionCalling: true,
    supportsStructuredOutput: true,
    supportsVision: true,
    regionConstraints: ['us', 'eu'],
    allowedDataClasses: ['public', 'internal'],
    tenantAllowlist: [],
    operationalStatus: 'disabled',
    enabled: false,
    qualityBaseline: 0.96,
    avgLatencyMs: 920,
  },
];

export class ModelRegistry {
  private entries = new Map<string, ModelCapabilityEntry>();
  private aliasMap = new Map<string, string>();

  constructor(initialEntries: ReadonlyArray<ModelCapabilityEntry> = DEFAULT_MODEL_REGISTRY) {
    for (const entry of initialEntries) {
      this.register({ ...entry });
    }
  }

  register(entry: ModelCapabilityEntry): void {
    this.entries.set(entry.modelId, entry);
    this.aliasMap.set(entry.modelId, entry.modelId);
    this.aliasMap.set(entry.providerModelId, entry.modelId);
    if (entry.aliases) {
      for (const alias of entry.aliases) {
        this.aliasMap.set(alias, entry.modelId);
      }
    }
  }

  get(modelIdOrAlias: string): ModelCapabilityEntry | undefined {
    const canonical = this.aliasMap.get(modelIdOrAlias) ?? modelIdOrAlias;
    return this.entries.get(canonical);
  }

  listAll(): ModelCapabilityEntry[] {
    return Array.from(this.entries.values());
  }

  listEligible(options: {
    tier?: ModelTier;
    provider?: ModelCapabilityEntry['provider'];
    tenantId?: string;
    includeExternal?: boolean;
  } = {}): ModelCapabilityEntry[] {
    return this.listAll().filter((m) => {
      if (!m.enabled || m.operationalStatus !== 'active') return false;
      if (m.retirementDate && new Date(m.retirementDate).getTime() <= Date.now()) {
        return false;
      }
      if (!options.includeExternal && m.tier === 'external') return false;
      if (options.tier && m.tier !== options.tier) return false;
      if (options.provider && m.provider !== options.provider) return false;
      if (options.tenantId) {
        const allowed =
          m.tenantAllowlist.includes('*') || m.tenantAllowlist.includes(options.tenantId);
        if (!allowed) return false;
      }
      return true;
    });
  }

  /**
   * Update model rate, operational status, or enablement dynamically.
   */
  updateModel(
    modelIdOrAlias: string,
    patch: Partial<Omit<ModelCapabilityEntry, 'modelId'>>,
  ): ModelCapabilityEntry {
    const existing = this.get(modelIdOrAlias);
    if (!existing) {
      throw new Error(`Model '${modelIdOrAlias}' not found in registry`);
    }
    const updated: ModelCapabilityEntry = {
      ...existing,
      ...patch,
    };
    this.register(updated);
    return updated;
  }

  /**
   * Synchronize overrides from D1 `scp_model_registry` table if available.
   */
  async syncFromD1(db: D1Database): Promise<void> {
    try {
      const res = await db
        .prepare(`SELECT * FROM scp_model_registry`)
        .all();
      for (const row of res.results as any[]) {
        const existing = this.get(row.model_id);
        this.register({
          modelId: row.model_id,
          providerModelId: row.canonical_alias || row.model_id,
          provider: row.provider,
          tier: row.tier,
          inputPricePerMUsd: Number(row.input_price_per_m_usd),
          outputPricePerMUsd: Number(row.output_price_per_m_usd),
          cachedInputPricePerMUsd: Number(row.cached_input_price_per_m ?? 0),
          inputNeuronsPerM: Number(row.input_neurons_per_m),
          outputNeuronsPerM: Number(row.output_neurons_per_m),
          contextWindow: Number(row.context_window),
          supportsStreaming: Boolean(row.supports_streaming),
          supportsFunctionCalling: Boolean(row.supports_function_calling),
          supportsStructuredOutput: Boolean(row.supports_structured_output),
          supportsVision: Boolean(row.supports_vision),
          regionConstraints: JSON.parse(row.region_constraints || '["global"]'),
          allowedDataClasses: JSON.parse(row.allowed_data_classes || '["public","internal"]'),
          tenantAllowlist: JSON.parse(row.tenant_allowlist || '["*"]'),
          operationalStatus: row.operational_status,
          enabled: Boolean(row.enabled),
          retirementDate: row.retirement_date ?? undefined,
          replacementModelId: row.replacement_model_id ?? undefined,
          qualityBaseline: Number(row.quality_baseline ?? existing?.qualityBaseline ?? 0.8),
          avgLatencyMs: Number(row.avg_latency_ms ?? existing?.avgLatencyMs ?? 500),
        });
      }
    } catch {
      // Table may not be migrated yet in legacy environments — keep in-memory defaults
    }
  }
}
