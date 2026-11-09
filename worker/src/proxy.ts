import { Hono } from "hono";
import { SCPEnv, evaluatePolicy, PolicyEvalContext, PolicyRow } from "./control";
import {
  evaluateRoutingPolicy,
  RoutingController,
  CircuitBreakerManager,
  RoutingExhaustedError,
  RoutingPolicyConfig,
} from "./routing";
import { OpenRouterGateway } from "./gateways/openrouter";
import { DeterministicGateway } from "./gateways/deterministic";
import { LocalGateway } from "./gateways/local";
import { recordRoutingDecision, SCPTracer, buildTelemetryFromDecision } from "./telemetry";
import type { ModelRequest, RoutingPolicyResult } from "./types";

export const proxyRouter = new Hono<{
  Bindings: SCPEnv & {
    BUDGET_DO: DurableObjectNamespace;
    PORTKEY_API_KEY?: string;
    PORTKEY_BASE_URL?: string;
    OPENROUTER_API_KEY?: string;
    LOCAL_MODEL_URL?: string;
  };
}>();

const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10.0 }, // per 1M tokens
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },
  "gpt-4": { input: 30.0, output: 60.0 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  "claude-opus-4-5": { input: 15.0, output: 75.0 },
  "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
  "claude-haiku-3-5": { input: 0.8, output: 4.0 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
};

function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const prices = MODEL_PRICES[model] ?? { input: 0, output: 0 };
  return (
    (inputTokens * prices.input + outputTokens * prices.output) / 1_000_000
  );
}

proxyRouter.get("/proxy/v1/health", (c) => {
  return c.json({
    status: "ok",
    gateway: c.env.PORTKEY_BASE_URL ?? "direct",
    jev_router: c.env.OPENROUTER_API_KEY ? "configured" : "not_configured",
    timestamp: new Date().toISOString(),
  });
});

proxyRouter.post("/proxy/v1/chat/completions", async (c) => {
  const env = c.env;
  const tracer = new SCPTracer();
  const rootSpan = tracer.startSpan("scp.request");

  // Stable identity for this request — client must send same ID on retry
  const requestId =
    c.req.header("X-Request-Id") ?? crypto.randomUUID();

  // 1. Parse body and clone
  const bodyText = await c.req.text();
  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch (e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const originalModel = body.model || "gpt-3.5-turbo";

  // 2. Extract attribution
  const customer_id = c.req.header("X-Customer-Id");
  const project_id = c.req.header("X-Project-Id");
  const agent_id = c.req.header("X-Agent-Id");
  const user_id = c.req.header("X-User-Id");
  const task_episode_id = c.req.header("X-Episode-Id");
  const request_hash = c.req.header("X-Request-Hash");
  const enforcement_mode = c.req.header("X-Enforcement-Mode") || "observe";
  const workflow_id = c.req.header("X-Workflow-Id");

  // 3. Estimate token count
  let input_tokens = 0;
  if (body.messages && Array.isArray(body.messages)) {
    input_tokens = body.messages.reduce((sum: number, m: any) => {
      const content = m.content || "";
      return (
        sum +
        Math.ceil(typeof content === "string" ? content.length / 4 : 100)
      );
    }, 0);
  }
  const output_tokens = 0; // unknown pre-call

  // 4. Load policy from D1
  const policySpan = tracer.startSpan("scp.policy_check", rootSpan.spanId);
  let policy: PolicyRow | null = null;
  let routingPolicyConfig: RoutingPolicyConfig | null = null;
  try {
    const row = await env.DB.prepare(
      `
      SELECT policy_id, enforcement_mode, rules_config,
             routing_mode, allowed_providers, blocked_models,
             max_cost_per_request_usd, max_reasoning_level,
             deterministic_model, latency_target_ms,
             min_quality_score, require_human_review
      FROM scp_policies 
      WHERE scope_id IN (?, ?, ?) OR scope = 'global'
      ORDER BY CASE scope 
        WHEN 'agent' THEN 1 
        WHEN 'project' THEN 2 
        WHEN 'customer' THEN 3 
        ELSE 4 END 
      LIMIT 1
    `,
    )
      .bind(agent_id || "", project_id || "", customer_id || "")
      .first();

    if (row) {
      policy = {
        policy_id: row.policy_id as string,
        enforcement_mode: row.enforcement_mode as string,
        rules_config: row.rules_config as string,
      };
      // Parse routing-specific policy fields
      routingPolicyConfig = {
        routing_mode: (row.routing_mode as string) || undefined,
        allowed_providers: row.allowed_providers
          ? JSON.parse(row.allowed_providers as string)
          : undefined,
        blocked_models: row.blocked_models
          ? JSON.parse(row.blocked_models as string)
          : undefined,
        max_cost_usd: (row.max_cost_per_request_usd as number) || undefined,
        max_reasoning_level: (row.max_reasoning_level as string) || undefined,
        deterministic_model: (row.deterministic_model as string) || undefined,
        latency_target_ms: (row.latency_target_ms as number) || undefined,
        min_quality_score: (row.min_quality_score as number) || undefined,
        require_human_review: !!(row.require_human_review as number),
      } as RoutingPolicyConfig;
    }
  } catch (e) {
    // default allow
  }
  tracer.endSpan(policySpan);

  // 5. Budget check via BudgetDO
  const budgetSpan = tracer.startSpan("scp.budget_reserve", rootSpan.spanId);
  const scopeKey = policy
    ? `${policy.policy_id || "default"}`
    : "global:default";

  // Budget DO integration (currently stubbed — uncomment when DO is wired)
  let budgetAvailable = 1000;
  /*
  const doId = env.BUDGET_DO.idFromName(scopeKey);
  const budgetDO = env.BUDGET_DO.get(doId);
  const budgetStatusRes = await budgetDO.fetch(new Request("http://do/status", { method: "POST" }));
  if (budgetStatusRes.ok) {
    const st = await budgetStatusRes.json();
    budgetAvailable = st.state.available_usd;
  }
  */
  tracer.endSpan(budgetSpan);

  if (budgetAvailable <= 0) {
    return c.json(
      {
        error: {
          code: "policy_pause",
          message: "Request paused by spend control policy",
          rule_id: "MONTHLY_BUDGET_EXCEEDED",
          approval_required: true,
        },
      },
      402,
    );
  }

  // 6. Run SCP 16 policy rules
  const evalCtx: PolicyEvalContext = {
    policy,
    model: originalModel,
    inputTokens: input_tokens,
    outputTokens: output_tokens,
    retryCount: 0,
    toolFailureCount: 0,
    customerId: customer_id,
    projectId: project_id,
    agentId: agent_id,
    userId: user_id,
    requestHourUtc: new Date().getUTCHours(),
    requestHash: request_hash,
    periodSpentUsd: 100, // TODO: read from ledger
    dailySpentUsd: 10,
    rolling7dAvg: 8,
    baseline30d: 5,
    consecutiveFailures: 0,
    successRate: 0.95,
    cacheHitRate: 0,
    recentHashes: [],
    userTodayUsd: 1,
    userAvgUsd: 1,
    revenueUsd: 10,
    costUsd: 2,
    reviewMinutes: 0,
  };

  const decision = evaluatePolicy(evalCtx);

  // 7. Branch on SCP policy action
  if (decision.action === "pause") {
    return c.json(
      {
        error: {
          code: "policy_pause",
          message: "Request paused by spend control policy",
          rule_id: decision.ruleId,
          policy_id: policy?.policy_id,
          approval_required: true,
        },
      },
      402,
    );
  }

  // Apply model override from existing SCP rules (e.g., EXPENSIVE_MODEL_SIMPLE_TASK)
  if (decision.action === "route" && decision.modelOverride) {
    body.model = decision.modelOverride;
  }

  // =========================================================================
  // 8. ROUTING DECISION — Jev Router Integration
  // =========================================================================
  const routingSpan = tracer.startSpan("scp.routing", rootSpan.spanId);

  // Initialize circuit breakers
  const circuitBreakers = new CircuitBreakerManager();
  await circuitBreakers.loadFromD1(env.DB);

  // Evaluate routing policy (extends SCP policy with routing-specific controls)
  const routingPolicy: RoutingPolicyResult = evaluateRoutingPolicy(
    routingPolicyConfig,
    budgetAvailable,
    new Map(), // Circuit breaker statuses loaded above
  );

  // If routing policy denies, return immediately
  if (!routingPolicy.allow) {
    tracer.endSpan(routingSpan, "error");
    return c.json(
      {
        error: {
          code: "routing_denied",
          message: routingPolicy.reason || "Routing denied by policy",
          require_human_review: routingPolicy.requireHumanReview,
        },
      },
      402,
    );
  }

  // Build gateways based on available configuration
  const gateways: Record<string, any> = {};

  // Jev Router via OpenRouter
  if (env.OPENROUTER_API_KEY) {
    gateways.jev = new OpenRouterGateway({
      apiKey: env.OPENROUTER_API_KEY,
      siteName: "SCP",
      defaultModel: "typesafe/jev-router",
    });
  }

  // Deterministic gateway via Portkey or direct
  if (env.PORTKEY_API_KEY || env.PORTKEY_BASE_URL) {
    const providers: Record<string, { baseUrl: string; apiKey: string }> = {};
    // Use Portkey as the provider endpoint
    const baseUrl = env.PORTKEY_BASE_URL || "https://api.portkey.ai/v1";
    providers["portkey"] = {
      baseUrl,
      apiKey: env.PORTKEY_API_KEY || "",
    };
    gateways.deterministic = new DeterministicGateway({ providers });
  } else {
    // Direct to OpenAI as fallback deterministic route
    gateways.deterministic = new DeterministicGateway({
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: c.req.header("Authorization")?.replace("Bearer ", "") || "",
        },
      },
    });
  }

  // Local model gateway
  if (env.LOCAL_MODEL_URL) {
    gateways.local = new LocalGateway({
      baseUrl: env.LOCAL_MODEL_URL,
      models: ["minimind", "nanojev"],
    });
  }

  // Initialize routing controller
  const controller = new RoutingController({
    gateways,
    circuitBreakers,
    maxEscalations: 2,
  });

  // Build the model request with SCP metadata
  const modelRequest: ModelRequest = {
    model: body.model || originalModel,
    messages: body.messages,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    tools: body.tools,
    tool_choice: body.tool_choice,
    response_format: body.response_format,
    stream: body.stream,
    _scp: {
      requestId,
      tenantId: customer_id || project_id || "default",
      agentId: agent_id,
      userId: user_id,
      workflowId: workflow_id,
      routingStrategy: routingPolicy.routingMode,
      maxCostUsd: routingPolicy.maxCostUsd,
      allowedProviders: routingPolicy.allowedProviders,
      blockedModels: routingPolicy.blockedModels,
      maxReasoningLevel: routingPolicy.maxReasoningLevel,
      latencyTargetMs: routingPolicy.latencyTargetMs,
      minQualityScore: routingPolicy.minQualityScore,
    },
  };

  try {
    // 9. Execute through routing controller (cascade with quality checks)
    const routingResult = await controller.routeAndExecute(
      modelRequest,
      routingPolicy,
    );

    tracer.endSpan(routingSpan);

    // 10. Record routing decision and telemetry
    tracer.recordRoutingDecision(rootSpan, routingResult.decision);

    // Calculate actual cost from response
    const actual_cost = routingResult.response.usage
      ? estimateCost(
          routingResult.response.model || body.model,
          routingResult.response.usage.prompt_tokens,
          routingResult.response.usage.completion_tokens,
        )
      : estimateCost(body.model, input_tokens, 500);

    // Update decision with actual cost
    routingResult.decision.actualCost = actual_cost;

    // Record to D1 (async, don't block response)
    c.executionCtx.waitUntil(
      recordRoutingDecision(env.DB, routingResult.decision),
    );

    // Emit SCP event for queue processing
    c.executionCtx.waitUntil(
      env.SCP_EVENTS.send({
        event_id: `${requestId}:proxy_completion`,
        request_id: requestId,
        type: "proxy_completion",
        customer_id,
        project_id,
        agent_id,
        user_id,
        task_episode_id,
        request_hash,
        model: routingResult.decision.selectedModel || body.model,
        action: decision.action,
        model_override: decision.modelOverride,
        rule_id: decision.ruleId,
        triggered_rules: decision.triggeredRules,
        input_tokens: routingResult.response.usage?.prompt_tokens ?? input_tokens,
        output_tokens: routingResult.response.usage?.completion_tokens ?? 0,
        cost_usd: actual_cost,
        routing_strategy: routingResult.decision.strategy,
        router_model: routingResult.decision.routerModel,
        selected_provider: routingResult.decision.selectedProvider,
        selected_model: routingResult.decision.selectedModel,
        quality_score: routingResult.quality.overallScore,
        escalated: routingResult.decision.escalated,
        latency_ms: routingResult.decision.latencyMs,
        timestamp: new Date().toISOString(),
      }).catch((err) => console.error(err)),
    );

    tracer.endSpan(rootSpan);

    // 11. Build response with routing metadata headers
    const responseBody = JSON.stringify({
      ...routingResult.response,
      // Strip internal routing metadata from client response
      _routing: undefined,
    });

    const responseHeaders = new Headers();
    responseHeaders.set("Content-Type", "application/json");
    responseHeaders.set("X-Request-Id", requestId);
    responseHeaders.set(
      "X-Routing-Strategy",
      routingResult.decision.strategy,
    );
    if (routingResult.decision.selectedModel) {
      responseHeaders.set(
        "X-Selected-Model",
        routingResult.decision.selectedModel,
      );
    }
    if (routingResult.decision.selectedProvider) {
      responseHeaders.set(
        "X-Selected-Provider",
        routingResult.decision.selectedProvider,
      );
    }
    responseHeaders.set(
      "X-Quality-Score",
      routingResult.quality.overallScore.toFixed(2),
    );

    return new Response(responseBody, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (err) {
    tracer.endSpan(routingSpan, "error");
    tracer.endSpan(rootSpan, "error");

    if (err instanceof RoutingExhaustedError) {
      // All routing strategies exhausted — record and return
      c.executionCtx.waitUntil(
        recordRoutingDecision(env.DB, err.decision),
      );

      c.executionCtx.waitUntil(
        env.SCP_EVENTS.send({
          event_id: `${requestId}:routing_exhausted`,
          request_id: requestId,
          type: "routing_exhausted",
          customer_id,
          project_id,
          agent_id,
          routing_strategy: "human",
          reason: err.message,
          timestamp: new Date().toISOString(),
        }).catch((e) => console.error(e)),
      );

      return c.json(
        {
          error: {
            code: "routing_exhausted",
            message:
              "All routing strategies exhausted. Request requires human review.",
            request_id: requestId,
            decision: {
              strategy: err.decision.strategy,
              retryCount: err.decision.retryCount,
              escalated: err.decision.escalated,
            },
          },
        },
        503,
      );
    }

    // Generic upstream error
    c.executionCtx.waitUntil(
      env.SCP_EVENTS.send({
        event_id: `${requestId}:proxy_error`,
        request_id: requestId,
        type: "proxy_error",
        customer_id,
        project_id,
        agent_id,
        error_message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }).catch((e) => console.error(e)),
    );

    return c.json({ error: "Upstream request failed" }, 502);
  }
});
