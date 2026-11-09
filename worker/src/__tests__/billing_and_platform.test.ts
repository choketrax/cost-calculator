import { env } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { ModelRegistry } from '../inference/model-registry';
import { ModelLifecycleManager } from '../inference/model-lifecycle';
import { NeuronPricingCalculator, USD_PER_NEURON } from '../billing/neuron-pricing';
import { InferenceMeter } from '../billing/inference-meter';
import { ToolMeter, DEEPSEEK_COST_PER_SUCCESS_USD } from '../billing/tool-meter';
import { SpendControlAdapter } from '../billing/spend-control-adapter';
import { BillingReconciliationEngine } from '../billing/reconciliation';
import { PaperclipAgentIntegration } from '../integrations/paperclip';
import { N8nGatewayIntegration } from '../integrations/n8n';
import { OpenVikingIntegration } from '../integrations/openviking';
import { MiniMindWorkforceIntegration } from '../integrations/minimind-workforce';
import { ToolRegistry } from '../tools/registry';
import { McpToolDispatcher } from '../mcp/tool-dispatch';
import { WebSearchHandler } from '../tools/handlers/web-search';
import { WebFetchHandler } from '../tools/handlers/web-fetch';
import { DeepSeekClient } from '../tools/providers/deepseek-client';
import { ResearchCache } from '../caching/research-cache';
import { ModelRouter } from '../inference/model-router';
import { WorkersAIGateway } from '../inference/providers/workers-ai';
import { createAgentGatewayApp, createGatewayRuntimeServices } from '../gateway';
import { VerifiedTenantIdentity } from '../gateway/middleware/identity';

function makeTenantIdentity(tenantId: string): VerifiedTenantIdentity {
  return {
    authenticated: true,
    tenantId,
    tenantName: `Tenant ${tenantId}`,
    roles: ['agent'],
    permissions: [
      'inference.invoke',
      'tools.web.search',
      'tools.web.fetch',
      'models.read',
      'tools.read',
      'usage.read',
      'health.read',
    ],
    allowedDataClass: 'internal',
    externalLlmEnabled: false,
    preferMiniMind: false,
  };
}

describe('Billing, Spend Control Pack & Multi-Tenant Platform Suite (Sections 10, 13, 16, 17)', () => {
  it('1. calculates Workers AI Neurons, daily free allowance deduction, cached-token pricing, and rate updates', () => {
    const registry = new ModelRegistry();
    const lifecycle = new ModelLifecycleManager(registry);
    const calc = new NeuronPricingCalculator('standard_neurons');

    const deepseekFlash = registry.get('@cf/deepseek-ai/deepseek-v4.1-flash-1017')!;
    // 100k input tokens (20k cached), 50k output tokens
    const res1 = calc.calculate({
      model: deepseekFlash,
      inputTokens: 100_000,
      outputTokens: 50_000,
      cachedTokens: 20_000,
      remainingDailyFreeNeurons: 1000,
      aiGatewayRouted: true,
    });

    // Effective input tokens = 80k + 0.5*20k = 90k
    const expectedNeurons =
      (90_000 / 1_000_000) * deepseekFlash.inputNeuronsPerM +
      (50_000 / 1_000_000) * deepseekFlash.outputNeuronsPerM;
    expect(res1.estimatedNeurons).toBeCloseTo(expectedNeurons, 2);
    expect(res1.freeTierNeuronsApplied).toBe(1000);
    expect(res1.billableNeurons).toBeCloseTo(expectedNeurons - 1000, 2);
    expect(res1.billedCostUsd).toBeCloseTo((expectedNeurons - 1000) * USD_PER_NEURON, 6);
    expect(res1.aiGatewayDeduplicated).toBe(true);

    // Model-specific dynamic rate update
    lifecycle.updatePricing('@cf/deepseek-ai/deepseek-v4.1-flash-1017', {
      inputNeuronsPerM: 20000,
      outputNeuronsPerM: 40000,
    });
    const updatedModel = registry.get('@cf/deepseek-ai/deepseek-v4.1-flash-1017')!;
    const res2 = calc.calculate({
      model: updatedModel,
      inputTokens: 100_000,
      outputTokens: 50_000,
      remainingDailyFreeNeurons: 0,
    });
    expect(res2.estimatedNeurons).toBeCloseTo(4000, 2);
  });

  it('2. prevents duplicate billing when routed through AI Gateway and reconciles prepaid credits cleanly', async () => {
    const registry = new ModelRegistry();
    const model = registry.get('@cf/ibm-granite/granite-4.0-h-micro')!;
    const meter = new InferenceMeter({ dailyFreeNeurons: 0 });

    const first = await meter.recordInference({
      requestId: 'req-dedup-1',
      idempotencyKey: 'idem-dedup-1',
      tenantId: 'tenant-1',
      model,
      inputTokens: 50_000,
      outputTokens: 20_000,
      aiGatewayRouted: true,
      latencyMs: 120,
      status: 'success',
    });

    // Duplicate callback (e.g. from AI Gateway log hook with same idempotencyKey)
    const duplicate = await meter.recordInference({
      requestId: 'req-dedup-1',
      idempotencyKey: 'idem-dedup-1',
      tenantId: 'tenant-1',
      model,
      inputTokens: 50_000,
      outputTokens: 20_000,
      aiGatewayRouted: true,
      latencyMs: 120,
      status: 'success',
    });

    expect(first.idempotent).toBe(false);
    expect(duplicate.idempotent).toBe(true);
    expect(meter.listRecords('tenant-1')).toHaveLength(1);

    // Reconcile discrepancy & prepaid AI Gateway credits
    const reconciler = new BillingReconciliationEngine();
    const recEntry = await reconciler.reconcile({
      requestId: 'req-dedup-1',
      tenantId: 'tenant-1',
      category: 'workers_ai_neurons',
      provider: 'workers-ai',
      estimatedUnits: 350,
      providerActualUnits: 410,
      estimatedCostUsd: 0.00385,
      providerActualUsd: 0.00451,
      billingMode: 'prepaid_gateway_credits',
    });
    expect(recEntry.status).toBe('discrepancy_flagged');
    expect(recEntry.notes).toContain('prepaid AI Gateway credits');
  });

  it('3. enforces atomic concurrent category reservations and tenant quota isolation via BudgetDO', async () => {
    const adapter = new SpendControlAdapter(env.BUDGET_DO);

    // Configure $0.0030 web_search_usd budget for tenant-a (allows exactly 4 DeepSeek searches at $0.00075)
    await adapter.configureCategoryBudget({
      tenantId: 'tenant-conc-a',
      category: 'web_search_usd',
      budgetAmount: 0.003,
      period: '2026-11',
    });

    // Configure $0.0150 web_search_usd budget for tenant-b (isolated from tenant-a)
    await adapter.configureCategoryBudget({
      tenantId: 'tenant-conc-b',
      category: 'web_search_usd',
      budgetAmount: 0.015,
      period: '2026-11',
    });

    // Fire 10 concurrent reservations for tenant-a at $0.00075 each
    const concurrentCalls = Array.from({ length: 10 }, (_, idx) =>
      adapter.reserve({
        tenantId: 'tenant-conc-a',
        category: 'web_search_usd',
        amount: DEEPSEEK_COST_PER_SUCCESS_USD,
        requestId: `search-conc-${idx}`,
        period: '2026-11',
      }),
    );

    const results = await Promise.all(concurrentCalls);
    const allowed = results.filter((r) => r.ok);
    const denied = results.filter((r) => !r.ok);

    expect(allowed.length).toBe(4);
    expect(denied.length).toBe(6);

    // Tenant B's budget is completely unaffected by Tenant A exhaustion
    const tenantBRes = await adapter.reserve({
      tenantId: 'tenant-conc-b',
      category: 'web_search_usd',
      amount: DEEPSEEK_COST_PER_SUCCESS_USD,
      requestId: 'search-b-1',
      period: '2026-11',
    });
    expect(tenantBRes.ok).toBe(true);
  });

  it('4. integrates n8n, Paperclip MCP discovery, OpenViking research, MiniMind training data, and isolates Tenant A vs Tenant B', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/tools/search')) {
        return new Response(
          JSON.stringify({
            results: [
              {
                title: 'Cloudflare Zero Trust Architecture',
                url: 'https://developers.cloudflare.com/cloudflare-one/',
                snippet: 'Zero Trust network access and gateway policy guide.',
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          title: 'Cloudflare One Docs',
          content: '# Cloudflare One\n\nDetailed documentation body.',
        }),
        { status: 200 },
      );
    });

    const aiRunMock = vi.fn().mockResolvedValue({
      response: 'Synthesized Workers AI answer with provenance.',
      usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
    });

    const registry = new ToolRegistry();
    const cache = new ResearchCache();
    const toolMeter = new ToolMeter();
    const dsClient = new DeepSeekClient({ apiKey: 'mock-ds-key', fetchImpl: fetchMock as any });
    const searchHandler = new WebSearchHandler({ client: dsClient, cache, meter: toolMeter });
    const fetchHandler = new WebFetchHandler({ client: dsClient, cache, meter: toolMeter });
    const dispatcher = new McpToolDispatcher({ registry, searchHandler, fetchHandler });
    const modelRouter = new ModelRouter({
      gateways: {
        workersAi: new WorkersAIGateway({
          aiBinding: { run: aiRunMock },
          gatewayId: 'agent-gateway',
        }),
      },
    });

    const tenantA = makeTenantIdentity('tenant-alpha');
    const tenantB = makeTenantIdentity('tenant-beta');

    // Paperclip discovers both MCP tools (`web_search` and `web_fetch`)
    const paperclip = new PaperclipAgentIntegration({ registry, dispatcher });
    const discovered = paperclip.discoverMcpTools();
    expect(discovered.map((t) => t.name)).toEqual(['web_search', 'web_fetch']);

    // n8n invokes Search and Fetch
    const n8n = new N8nGatewayIntegration({ toolDispatcher: dispatcher, modelRouter });
    const n8nSearch = await n8n.invokeWebSearch(tenantA, { query: 'Cloudflare Zero Trust' });
    expect(n8nSearch.isError).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Tenant B searching the exact same query MUST NOT hit Tenant A's cache entry
    const tenantBSearch = await paperclip.callMcpTool(
      'web_search',
      { query: 'Cloudflare Zero Trust' },
      tenantB,
    );
    expect((tenantBSearch.structuredContent as any).cached).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // OpenViking consumes research artifacts & isolates Tenant A's artifact from Tenant B
    const openViking = new OpenVikingIntegration({ toolDispatcher: dispatcher, modelRouter });
    const artifactA = await openViking.executeResearchQuestion({
      question: 'Cloudflare Zero Trust',
      identity: tenantA,
      requiresLiveFreshness: true,
    });
    expect(artifactA.citations).toContain('https://developers.cloudflare.com/cloudflare-one/');
    expect(openViking.getArtifactForTenant(artifactA.artifactId, tenantA)).not.toBeNull();
    expect(openViking.getArtifactForTenant(artifactA.artifactId, tenantB)).toBeNull();

    // MiniMind synthetic-data generation works through shared tools without initiating GPU training
    const minimind = new MiniMindWorkforceIntegration({ toolDispatcher: dispatcher, modelRouter });
    const example = await minimind.generateSyntheticExample({
      topic: 'Cloudflare Zero Trust',
      identity: tenantA,
      retrieveWebReferences: true,
    });
    expect(example.gpuTrainingInitiated).toBe(false);
    expect(example.citations.length).toBeGreaterThan(0);
    expect(example.qualityScore).toBeGreaterThanOrEqual(0.7);
  });

  it('5. exposes authenticated /api/v1/* endpoints and preserves backward-compatible routes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [{ title: 'CF', url: 'https://cloudflare.com', snippet: 'Edge network' }],
        }),
        { status: 200 },
      ),
    );
    const aiRunMock = vi.fn().mockResolvedValue({
      response: 'Workers AI gateway output',
      usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
    });

    const gatewayEnv = {
      API_KEY: 'secret-master-token',
      DEEPSEEK_API_KEY: 'mock-ds-key',
      AI_GATEWAY_ID: 'agent-gateway',
      AI: { run: aiRunMock },
    };

    const services = createGatewayRuntimeServices(gatewayEnv, { fetchImpl: fetchMock as any });
    const app = createAgentGatewayApp(services);

    // Unauthenticated call returns 401
    const unauthRes = await app.fetch(
      new Request('http://localhost/api/v1/models'),
      gatewayEnv,
    );
    expect(unauthRes.status).toBe(401);

    // Authenticated GET /api/v1/models
    const modelsRes = await app.fetch(
      new Request('http://localhost/api/v1/models', {
        headers: { Authorization: 'Bearer secret-master-token' },
      }),
      gatewayEnv,
    );
    expect(modelsRes.status).toBe(200);
    const modelsJson = (await modelsRes.json()) as any;
    expect(modelsJson.default_provider).toBe('workers-ai');

    // Authenticated POST /api/v1/inference
    const infRes = await app.fetch(
      new Request('http://localhost/api/v1/inference', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-master-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Classify this short ticket.' }],
        }),
      }),
      gatewayEnv,
    );
    expect(infRes.status).toBe(200);
    const infJson = (await infRes.json()) as any;
    expect(infJson._governance.selectedProvider).toBe('workers-ai');

    // Authenticated POST /api/v1/tools/web.search
    const searchRes = await app.fetch(
      new Request('http://localhost/api/v1/tools/web.search', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-master-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: 'cloudflare workers' }),
      }),
      gatewayEnv,
    );
    expect(searchRes.status).toBe(200);

    // Authenticated GET /api/v1/usage & /api/v1/usage/neurons & /api/v1/provider-health
    const usageRes = await app.fetch(
      new Request('http://localhost/api/v1/usage', {
        headers: { Authorization: 'Bearer secret-master-token' },
      }),
      gatewayEnv,
    );
    expect(usageRes.status).toBe(200);
    const usageJson = (await usageRes.json()) as any;
    expect(usageJson.totalInferenceRequests).toBe(1);
    expect(usageJson.totalSearchRequests).toBe(1);

    const neuronsRes = await app.fetch(
      new Request('http://localhost/api/v1/usage/neurons', {
        headers: { Authorization: 'Bearer secret-master-token' },
      }),
      gatewayEnv,
    );
    expect(neuronsRes.status).toBe(200);

    const healthRes = await app.fetch(
      new Request('http://localhost/api/v1/provider-health', {
        headers: { Authorization: 'Bearer secret-master-token' },
      }),
      gatewayEnv,
    );
    expect(healthRes.status).toBe(200);
  });
});
