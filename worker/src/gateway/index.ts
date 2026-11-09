/**
 * AgentGateway v2.0 / v3.0 Public & Internal API Router (Section 16)
 *
 * Provides authenticated gateway endpoints:
 *   POST /api/v1/inference
 *   POST /api/v1/tools/web.search
 *   POST /api/v1/tools/web.fetch
 *   POST /api/v1/mcp
 *   GET  /api/v1/models
 *   GET  /api/v1/tools
 *   GET  /api/v1/usage
 *   GET  /api/v1/usage/neurons
 *   GET  /api/v1/provider-health
 *
 * Enforces verified token identity (`IdentityVerifier`) and RBAC (`AuthorizationEnforcer`).
 * External clients cannot choose an unauthorized provider or submit an unverified tenant ID.
 */

import { Hono } from 'hono';
import { IdentityVerifier, AuthenticationError } from './middleware/identity';
import { buildTenantExecutionContext } from './middleware/tenant-context';
import { AuthorizationEnforcer, ForbiddenError } from './middleware/authorization';
import { ModelRegistry } from '../inference/model-registry';
import { ModelRouter } from '../inference/model-router';
import { WorkersAIGateway, WorkersAIBinding } from '../inference/providers/workers-ai';
import { MiniMindGateway } from '../inference/providers/minimind';
import { ExternalAIGateway } from '../inference/providers/external-ai';
import { CircuitBreakerManager, RoutingExhaustedError } from '../routing';
import { ToolRegistry } from '../tools/registry';
import { ToolValidationError } from '../tools/schemas';
import { UrlSecurityError } from '../tools/security/url-policy';
import { DeepSeekClient, DeepSeekProviderError } from '../tools/providers/deepseek-client';
import { WebSearchHandler } from '../tools/handlers/web-search';
import { WebFetchHandler } from '../tools/handlers/web-fetch';
import { ResearchCache } from '../caching/research-cache';
import { InferenceMeter } from '../billing/inference-meter';
import { ToolMeter } from '../billing/tool-meter';
import { SpendControlAdapter } from '../billing/spend-control-adapter';
import { buildMcpToolDefinitions } from '../mcp/tool-definitions';
import { McpToolDispatcher } from '../mcp/tool-dispatch';
import { CostMetricsAggregator } from '../observability/cost-metrics';
import { AuditEventLogger } from '../observability/audit-events';
import { UnifiedSecurityEngine } from '../policies/data-classification';

export interface AgentGatewayEnv {
  AI?: WorkersAIBinding;
  DB?: D1Database;
  AUDIT_STORAGE?: R2Bucket;
  BUDGET_DO?: DurableObjectNamespace;
  API_KEY: string;
  DEEPSEEK_API_KEY?: string;
  AI_GATEWAY_ID?: string;
  LOCAL_MODEL_URL?: string;
  OPENROUTER_API_KEY?: string;
  ROUTING_MODE?: string;
  WORKERS_AI_BILLING_MODE?: 'standard_neurons' | 'prepaid_gateway_credits' | 'byok_passthrough';
  WORKERS_AI_DAILY_FREE_NEURONS?: string;
  WEB_TOOLS_ENABLED?: string;
}

export interface GatewayRuntimeServices {
  identityVerifier: IdentityVerifier;
  authz: AuthorizationEnforcer;
  modelRegistry: ModelRegistry;
  circuitBreakers: CircuitBreakerManager;
  modelRouter: ModelRouter;
  toolRegistry: ToolRegistry;
  researchCache: ResearchCache;
  inferenceMeter: InferenceMeter;
  toolMeter: ToolMeter;
  spendControl?: SpendControlAdapter;
  searchHandler: WebSearchHandler;
  fetchHandler: WebFetchHandler;
  mcpDispatcher: McpToolDispatcher;
  metricsAggregator: CostMetricsAggregator;
  auditLogger: AuditEventLogger;
  securityEngine: UnifiedSecurityEngine;
}

export function createGatewayRuntimeServices(
  env: AgentGatewayEnv,
  overrides: Partial<GatewayRuntimeServices> & { fetchImpl?: typeof fetch } = {},
): GatewayRuntimeServices {
  const modelRegistry = overrides.modelRegistry ?? new ModelRegistry();
  const circuitBreakers = overrides.circuitBreakers ?? new CircuitBreakerManager();
  const toolRegistry = overrides.toolRegistry ?? new ToolRegistry();
  const researchCache =
    overrides.researchCache ??
    new ResearchCache({
      db: env.DB,
      r2: env.AUDIT_STORAGE,
    });
  const inferenceMeter =
    overrides.inferenceMeter ??
    new InferenceMeter(
      {
        defaultBillingMode: env.WORKERS_AI_BILLING_MODE ?? 'standard_neurons',
        dailyFreeNeurons: Number(env.WORKERS_AI_DAILY_FREE_NEURONS ?? 10000),
        db: env.DB,
      },
      env.DB,
    );
  const toolMeter = overrides.toolMeter ?? new ToolMeter(env.DB);
  const spendControl =
    overrides.spendControl ??
    (env.BUDGET_DO ? new SpendControlAdapter(env.BUDGET_DO, env.DB) : undefined);

  const workersAiGateway = env.AI
    ? new WorkersAIGateway({
        aiBinding: env.AI,
        gatewayId: env.AI_GATEWAY_ID || 'agent-gateway',
        registry: modelRegistry,
      })
    : undefined;

  const minimindGateway = env.LOCAL_MODEL_URL
    ? new MiniMindGateway({
        baseUrl: env.LOCAL_MODEL_URL,
        models: ['minimind', 'nanojev', 'minimind/specialist-v1'],
      })
    : undefined;

  const externalGateway = new ExternalAIGateway({});

  const modelRouter =
    overrides.modelRouter ??
    new ModelRouter({
      registry: modelRegistry,
      circuitBreakers,
      gateways: {
        workersAi: workersAiGateway,
        minimind: minimindGateway,
        external: externalGateway,
      },
    });

  const deepseekClient = new DeepSeekClient({
    apiKey: env.DEEPSEEK_API_KEY ?? '',
    fetchImpl: overrides.fetchImpl,
  });

  const searchHandler =
    overrides.searchHandler ??
    new WebSearchHandler({
      client: deepseekClient,
      cache: researchCache,
      meter: toolMeter,
      spendControl,
    });

  const fetchHandler =
    overrides.fetchHandler ??
    new WebFetchHandler({
      client: deepseekClient,
      cache: researchCache,
      meter: toolMeter,
      spendControl,
    });

  const mcpDispatcher =
    overrides.mcpDispatcher ??
    new McpToolDispatcher({
      registry: toolRegistry,
      searchHandler,
      fetchHandler,
    });

  return {
    identityVerifier: overrides.identityVerifier ?? new IdentityVerifier(env.API_KEY, env.DB),
    authz: overrides.authz ?? new AuthorizationEnforcer(),
    modelRegistry,
    circuitBreakers,
    modelRouter,
    toolRegistry,
    researchCache,
    inferenceMeter,
    toolMeter,
    spendControl,
    searchHandler,
    fetchHandler,
    mcpDispatcher,
    metricsAggregator: overrides.metricsAggregator ?? new CostMetricsAggregator(),
    auditLogger: overrides.auditLogger ?? new AuditEventLogger(),
    securityEngine: overrides.securityEngine ?? new UnifiedSecurityEngine(),
  };
}

export function createAgentGatewayApp(customServices?: GatewayRuntimeServices) {
  const app = new Hono<{ Bindings: AgentGatewayEnv }>();
  let cachedServices: GatewayRuntimeServices | undefined = customServices;

  const getServices = (env: AgentGatewayEnv): GatewayRuntimeServices => {
    if (!cachedServices) {
      cachedServices = createGatewayRuntimeServices(env);
    }
    return cachedServices;
  };

  // Error boundary
  app.onError((err, c) => {
    if (err instanceof AuthenticationError) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, 401);
    }
    if (err instanceof ForbiddenError) {
      return c.json(
        { error: { code: 'FORBIDDEN', message: err.message, required_permission: err.requiredPermission } },
        403,
      );
    }
    if (err instanceof ToolValidationError) {
      return c.json({ error: { code: err.code, message: err.message } }, 400);
    }
    if (err instanceof UrlSecurityError) {
      return c.json({ error: { code: err.code, message: err.message } }, 422);
    }
    if (err instanceof DeepSeekProviderError) {
      const status = (err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 502) as any;
      return c.json({ error: { code: err.errorCode, message: err.message } }, status);
    }
    if (err instanceof RoutingExhaustedError) {
      return c.json(
        {
          error: {
            code: 'NO_COMPLIANT_ROUTE',
            message: err.message,
            decision: err.decision,
          },
        },
        503,
      );
    }
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: err.message || 'Internal error' } },
      500,
    );
  });

  // POST /api/v1/inference
  app.post('/api/v1/inference', async (c) => {
    const services = getServices(c.env);
    const identity = await services.identityVerifier.verifyRequest(c.req.raw);
    services.authz.requirePermission(identity, 'inference.invoke');
    const tenantCtx = buildTenantExecutionContext(identity, c.req.raw);

    const body = await c.req.json();
    // Never trust client-supplied tenant_id or unauthorized provider override
    delete body.tenant_id;
    delete body.tenantId;

    // Reject explicit unauthorized external provider requests
    if (typeof body.model === 'string') {
      const regEntry = services.modelRegistry.get(body.model);
      if (regEntry && regEntry.tier === 'external' && !identity.externalLlmEnabled) {
        services.auditLogger.log({
          eventType: 'external_fallback_denied',
          tenantId: tenantCtx.tenantId,
          requestId: tenantCtx.requestId,
          summary: `Denied direct external model request '${body.model}' for tenant '${tenantCtx.tenantId}'`,
        });
        return c.json(
          {
            error: {
              code: 'EXTERNAL_PROVIDER_FORBIDDEN',
              message: `External model '${body.model}' is not authorized by tenant policy`,
            },
          },
          403,
        );
      }
    }

    const result = await services.modelRouter.routeAndExecute(
      {
        model: body.model ?? 'auto',
        messages: body.messages ?? [],
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        tools: body.tools,
        tool_choice: body.tool_choice,
        response_format: body.response_format,
        stream: body.stream,
        _scp: {
          requestId: tenantCtx.requestId,
          tenantId: tenantCtx.tenantId,
          agentId: tenantCtx.agentId,
          workflowId: tenantCtx.workflowId,
          routingStrategy: 'deterministic',
        },
      },
      {
        tenantId: tenantCtx.tenantId,
        agentId: tenantCtx.agentId,
        workflowId: tenantCtx.workflowId,
        tenantDataClass: identity.allowedDataClass,
        tenantExternalLlmEnabled: identity.externalLlmEnabled,
        preferMiniMindOnBenchmark: identity.preferMiniMind,
      },
    );

    const isDeterministic =
      result.plan.priority === 1 || result.decision.selectedProvider === 'deterministic-local';
    const modelEntry = isDeterministic
      ? ({
          modelId: result.decision.selectedModel ?? 'deterministic/local',
          providerModelId: result.decision.selectedModel ?? 'deterministic/local',
          provider: 'deterministic-local' as any,
          tier: 'deterministic',
          inputPricePerMUsd: 0,
          outputPricePerMUsd: 0,
          cachedInputPricePerMUsd: 0,
          inputNeuronsPerM: 0,
          outputNeuronsPerM: 0,
          contextWindow: 131072,
          supportsStreaming: false,
          supportsFunctionCalling: false,
          supportsStructuredOutput: true,
          supportsVision: false,
          regionConstraints: ['global'],
          allowedDataClasses: ['public', 'internal', 'confidential', 'restricted'],
          tenantAllowlist: ['*'],
          operationalStatus: 'active',
          enabled: true,
          qualityBaseline: 1.0,
          avgLatencyMs: 1,
        } as const)
      : (result.plan.selectedModel ??
        services.modelRegistry.get(result.decision.selectedModel ?? '') ??
        services.modelRegistry.listAll()[0]);

    const metered = await services.inferenceMeter.recordInference({
      requestId: tenantCtx.requestId,
      tenantId: tenantCtx.tenantId,
      workflowId: tenantCtx.workflowId,
      agentId: tenantCtx.agentId,
      model: modelEntry as any,
      fallbackReason: result.plan.fallbackReason,
      inputTokens: isDeterministic ? 0 : (result.response.usage?.prompt_tokens ?? 0),
      outputTokens: isDeterministic ? 0 : (result.response.usage?.completion_tokens ?? 0),
      reportedActualNeurons: isDeterministic ? 0 : result.actualNeurons,
      aiGatewayRouted: modelEntry.provider === 'workers-ai',
      latencyMs: result.decision.latencyMs ?? 0,
      status: 'success',
    });

    return c.json({
      ...result.response,
      _governance: {
        tenantId: tenantCtx.tenantId,
        requestId: tenantCtx.requestId,
        routePriority: result.plan.priority,
        tier: result.plan.tier,
        selectedProvider: result.decision.selectedProvider,
        selectedModel: result.decision.selectedModel,
        estimatedNeurons: metered.record.estimatedNeurons,
        billableNeurons: metered.record.billableNeurons,
        costUsd: metered.record.actualCostUsd,
        qualityScore: result.quality.overallScore,
      },
    });
  });

  // POST /api/v1/tools/web.search
  app.post('/api/v1/tools/web.search', async (c) => {
    if (c.env.WEB_TOOLS_ENABLED === 'false') {
      return c.json(
        { error: { code: 'FEATURE_DISABLED', message: 'Web research tools are disabled by feature flag' } },
        503,
      );
    }
    const services = getServices(c.env);
    const identity = await services.identityVerifier.verifyRequest(c.req.raw);
    services.authz.requirePermission(identity, 'tools.web.search');
    const tenantCtx = buildTenantExecutionContext(identity, c.req.raw);

    const body = await c.req.json();
    const result = await services.searchHandler.execute(body, {
      requestId: tenantCtx.requestId,
      tenantId: tenantCtx.tenantId,
      agentId: tenantCtx.agentId,
      workflowId: tenantCtx.workflowId,
    });

    return c.json(result);
  });

  // POST /api/v1/tools/web.fetch
  app.post('/api/v1/tools/web.fetch', async (c) => {
    if (c.env.WEB_TOOLS_ENABLED === 'false') {
      return c.json(
        { error: { code: 'FEATURE_DISABLED', message: 'Web research tools are disabled by feature flag' } },
        503,
      );
    }
    const services = getServices(c.env);
    const identity = await services.identityVerifier.verifyRequest(c.req.raw);
    services.authz.requirePermission(identity, 'tools.web.fetch');
    const tenantCtx = buildTenantExecutionContext(identity, c.req.raw);

    const body = await c.req.json();
    const result = await services.fetchHandler.execute(body, {
      requestId: tenantCtx.requestId,
      tenantId: tenantCtx.tenantId,
      agentId: tenantCtx.agentId,
      workflowId: tenantCtx.workflowId,
    });

    return c.json(result);
  });

  // POST /api/v1/mcp (JSON-RPC MCP transport for tools/list and tools/call)
  app.post('/api/v1/mcp', async (c) => {
    const services = getServices(c.env);
    const identity = await services.identityVerifier.verifyRequest(c.req.raw);
    const rpc = await c.req.json();

    if (rpc.method === 'tools/list') {
      return c.json({
        jsonrpc: '2.0',
        id: rpc.id ?? null,
        result: {
          tools: buildMcpToolDefinitions(services.toolRegistry, identity.tenantId),
        },
      });
    }

    if (rpc.method === 'tools/call') {
      if (c.env.WEB_TOOLS_ENABLED === 'false') {
        return c.json(
          {
            jsonrpc: '2.0',
            id: rpc.id ?? null,
            error: { code: -32003, message: 'Web research tools are disabled by feature flag' },
          },
          503,
        );
      }
      const callResult = await services.mcpDispatcher.dispatch(
        {
          name: rpc.params?.name,
          arguments: rpc.params?.arguments,
          requestId: c.req.header('X-Request-Id') ?? undefined,
        },
        identity,
      );
      return c.json({
        jsonrpc: '2.0',
        id: rpc.id ?? null,
        result: callResult,
      });
    }

    return c.json(
      {
        jsonrpc: '2.0',
        id: rpc.id ?? null,
        error: { code: -32601, message: `Unsupported MCP method '${rpc.method}'` },
      },
      400,
    );
  });

  // GET /api/v1/models
  app.get('/api/v1/models', async (c) => {
    const services = getServices(c.env);
    const identity = await services.identityVerifier.verifyRequest(c.req.raw);
    const models = services.modelRegistry.listEligible({
      tenantId: identity.tenantId,
      includeExternal: identity.externalLlmEnabled,
    });
    return c.json({
      tenant_id: identity.tenantId,
      default_provider: 'workers-ai',
      models,
    });
  });

  // GET /api/v1/tools
  app.get('/api/v1/tools', async (c) => {
    const services = getServices(c.env);
    const identity = await services.identityVerifier.verifyRequest(c.req.raw);
    return c.json({
      tenant_id: identity.tenantId,
      tools: services.toolRegistry.listForTenant(identity.tenantId),
      mcp_tools: buildMcpToolDefinitions(services.toolRegistry, identity.tenantId),
    });
  });

  // GET /api/v1/usage
  app.get('/api/v1/usage', async (c) => {
    const services = getServices(c.env);
    const identity = await services.identityVerifier.verifyRequest(c.req.raw);
    const [inferenceRecords, toolRecords] = await Promise.all([
      services.inferenceMeter.listRecordsAsync(identity.tenantId),
      services.toolMeter.listRecordsAsync(identity.tenantId),
    ]);
    const snapshot = services.metricsAggregator.buildTenantSnapshot({
      tenantId: identity.tenantId,
      inferenceRecords,
      toolRecords,
    });
    return c.json(snapshot);
  });

  // GET /api/v1/usage/neurons
  app.get('/api/v1/usage/neurons', async (c) => {
    const services = getServices(c.env);
    const identity = await services.identityVerifier.verifyRequest(c.req.raw);
    const [records, accountRemaining] = await Promise.all([
      services.inferenceMeter.listRecordsAsync(identity.tenantId),
      services.inferenceMeter.getAccountDailyFreeRemainingAsync(),
    ]);
    const totalEstimatedNeurons = records.reduce((s, r) => s + r.estimatedNeurons, 0);
    const totalBillableNeurons = records.reduce((s, r) => s + r.billableNeurons, 0);
    const totalFreeTierNeurons = records.reduce((s, r) => s + r.freeTierNeurons, 0);
    return c.json({
      tenant_id: identity.tenantId,
      billing_mode: c.env.WORKERS_AI_BILLING_MODE ?? 'standard_neurons',
      daily_free_remaining_neurons: accountRemaining,
      total_estimated_neurons: Number(totalEstimatedNeurons.toFixed(4)),
      total_free_tier_neurons: Number(totalFreeTierNeurons.toFixed(4)),
      total_billable_neurons: Number(totalBillableNeurons.toFixed(4)),
      records,
    });
  });

  // GET /api/v1/provider-health
  app.get('/api/v1/provider-health', async (c) => {
    const services = getServices(c.env);
    await services.identityVerifier.verifyRequest(c.req.raw);
    const providers = ['workers-ai', 'minimind', 'deepseek', 'openai', 'anthropic'];
    const statuses = providers.map((p) => ({
      provider: p,
      circuit: services.circuitBreakers.getStatus({ scope: 'provider', scopeId: p }),
    }));
    return c.json({
      ai_gateway_id: c.env.AI_GATEWAY_ID || 'agent-gateway',
      workers_ai_bound: Boolean(c.env.AI),
      deepseek_configured: Boolean(c.env.DEEPSEEK_API_KEY),
      providers: statuses,
    });
  });

  return app;
}
