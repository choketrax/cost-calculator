import {
  RoutingPolicyResult,
  RoutingStrategy,
  RoutingDecision,
  ModelRequest,
  ModelResponse,
  ModelGateway,
  QualityEvaluation,
  QualityCheck,
  CircuitBreakerKey,
  CircuitBreakerStatus,
  RoutingTelemetry,
} from './types';

// ---------------------------------------------------------------------------
// Routing Policy Evaluator (extends existing SCP policy engine)
// ---------------------------------------------------------------------------

/** Routing-specific policy config stored in scp_policies */
export interface RoutingPolicyConfig {
  routing_mode?: RoutingStrategy;
  allowed_providers?: string[];
  blocked_models?: string[];
  max_cost_usd?: number;
  max_reasoning_level?: 'none' | 'low' | 'medium' | 'high';
  deterministic_model?: string;
  latency_target_ms?: number;
  min_quality_score?: number;
  require_human_review?: boolean;
  local_eligible_task_types?: string[];
}

/**
 * Evaluate routing policy for a request.
 * This runs BEFORE any model call, determining what routing strategies are allowed.
 */
export function evaluateRoutingPolicy(
  policyConfig: RoutingPolicyConfig | null,
  remainingBudgetUsd: number,
  circuitBreakers: Map<string, CircuitBreakerStatus>,
): RoutingPolicyResult {
  const config = policyConfig ?? {};

  // Default: allow Jev routing if no explicit policy
  let routingMode: RoutingStrategy = config.routing_mode ?? 'jev';
  let maxCostUsd = config.max_cost_usd ?? 1.00;
  const allowedProviders = config.allowed_providers ?? ['openai', 'anthropic', 'google', 'deepseek', 'meta-llama'];
  const blockedModels = config.blocked_models ?? [];
  const requireHumanReview = config.require_human_review ?? false;

  // Budget-based routing adjustments
  if (remainingBudgetUsd <= 0) {
    return {
      allow: false,
      routingMode: 'human',
      maxCostUsd: 0,
      allowedProviders: [],
      blockedModels,
      maxReasoningLevel: 'none',
      requireHumanReview: true,
      reason: 'Budget exhausted',
    };
  }

  // If budget is very low, force cheaper routing
  if (remainingBudgetUsd < 0.10) {
    routingMode = 'local';
    maxCostUsd = Math.min(maxCostUsd, remainingBudgetUsd);
  } else if (remainingBudgetUsd < 1.00) {
    maxCostUsd = Math.min(maxCostUsd, remainingBudgetUsd * 0.5);
  }

  // If Jev circuit breaker is open, fall back
  const jevCircuit = circuitBreakers.get('router:jev-router');
  if (jevCircuit?.state === 'open' && routingMode === 'jev') {
    routingMode = 'fallback';
  }

  // If deterministic model is specified, force deterministic
  if (config.deterministic_model) {
    routingMode = 'deterministic';
  }

  return {
    allow: true,
    routingMode,
    maxCostUsd,
    allowedProviders,
    blockedModels,
    maxReasoningLevel: config.max_reasoning_level ?? 'medium',
    deterministicModel: config.deterministic_model,
    latencyTargetMs: config.latency_target_ms,
    minQualityScore: config.min_quality_score ?? 0.7,
    requireHumanReview,
    
    // Pass through fallback policy configuration
    fallbackModel: (config as any).fallback_model,
    fallbackProvider: (config as any).fallback_provider,
    fallbackMaxCostUsd: (config as any).fallback_max_cost_usd,
    fallbackReasoningLevel: (config as any).fallback_reasoning_level,
  };
}

// ---------------------------------------------------------------------------
// Quality Evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate response quality across three dimensions: Operational, Semantic, and Policy.
 * Returns an overall recommendation for whether to accept, retry, or escalate.
 */
export function evaluateQuality(
  request: ModelRequest,
  response: ModelResponse,
  minScore: number = 0.7,
): QualityEvaluation {
  // 1. Operational Quality (Completeness, latency, cost, formats)
  const operationalChecks: QualityCheck[] = [];

  const hasContent = response.choices?.length > 0 &&
    response.choices.some(c => c.message?.content || c.message?.tool_calls?.length);
  operationalChecks.push({
    name: 'response_completeness',
    passed: hasContent,
    score: hasContent ? 1.0 : 0.0,
    detail: hasContent ? 'Response contains content' : 'Empty or missing response',
  });

  const finishReason = response.choices?.[0]?.finish_reason;
  const goodFinish = finishReason === 'stop' || finishReason === 'tool_calls';
  operationalChecks.push({
    name: 'finish_reason',
    passed: goodFinish,
    score: goodFinish ? 1.0 : finishReason === 'length' ? 0.5 : 0.0,
    detail: `finish_reason: ${finishReason}`,
  });

  if (request.tools?.length) {
    const toolCalls = response.choices?.[0]?.message?.tool_calls;
    const hasTools = Array.isArray(toolCalls) && toolCalls.length > 0;
    operationalChecks.push({
      name: 'tool_call_validity',
      passed: hasTools || finishReason === 'stop',
      score: hasTools ? 1.0 : finishReason === 'stop' ? 0.7 : 0.0,
      detail: hasTools ? `${toolCalls!.length} tool calls made` : 'No tool calls',
    });
  }

  if (response._routing?.routerLatencyMs) {
    const latency = response._routing.routerLatencyMs;
    const latencyTarget = request._scp?.latencyTargetMs ?? 30000;
    const latencyOk = latency < latencyTarget;
    operationalChecks.push({
      name: 'latency',
      passed: latencyOk,
      score: latencyOk ? 1.0 : Math.max(0, 1.0 - (latency - latencyTarget) / latencyTarget),
      detail: `${latency}ms (target: ${latencyTarget}ms)`,
    });
  }

  if (response.usage && request._scp?.maxCostUsd) {
    const estimatedCost = (response.usage.total_tokens / 1_000_000) * 5; // rough average
    const costOk = estimatedCost <= request._scp.maxCostUsd;
    operationalChecks.push({
      name: 'cost',
      passed: costOk,
      score: costOk ? 1.0 : 0.3,
      detail: `Estimated ~$${estimatedCost.toFixed(4)} (max: $${request._scp.maxCostUsd})`,
    });
  }

  const operationalScore = operationalChecks.length > 0
    ? operationalChecks.reduce((sum, c) => sum + (c.score ?? (c.passed ? 1 : 0)), 0) / operationalChecks.length
    : 1.0;

  // 2. Semantic Quality (Stubbed for future expansion)
  const semanticChecks: QualityCheck[] = [];
  const semanticScore = 1.0;

  // 3. Policy Quality (Stubbed for future expansion)
  const policyChecks: QualityCheck[] = [];
  const policyScore = 1.0;

  // Combine scores
  const overallScore = Math.min(operationalScore, semanticScore, policyScore);
  const passed = overallScore >= minScore;

  let recommendation: QualityEvaluation['recommendation'];
  if (passed) {
    recommendation = 'accept';
  } else if (overallScore >= minScore * 0.5) {
    recommendation = 'escalate'; // try a stronger model
  } else if (overallScore > 0) {
    recommendation = 'retry';
  } else {
    recommendation = 'human_review';
  }

  return {
    overallScore,
    passed,
    operational: { score: operationalScore, passed: operationalScore >= minScore, checks: operationalChecks },
    semantic: { score: semanticScore, passed: semanticScore >= minScore, checks: semanticChecks },
    policy: { score: policyScore, passed: policyScore >= minScore, checks: policyChecks },
    recommendation,
  };
}

// ---------------------------------------------------------------------------
// Circuit Breaker Manager
// ---------------------------------------------------------------------------

const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000; // 1 minute

/**
 * In-memory circuit breaker state.
 * In production this is backed by the BudgetDO or D1 scp_circuit_state table.
 * This provides the hot-path check during request routing.
 */
export class CircuitBreakerManager {
  private breakers = new Map<string, { failures: number; state: 'closed' | 'open' | 'half_open'; openedAt?: number }>;

  getKey(key: CircuitBreakerKey): string {
    return `${key.scope}:${key.scopeId}`;
  }

  getStatus(key: CircuitBreakerKey): CircuitBreakerStatus {
    const k = this.getKey(key);
    const breaker = this.breakers.get(k);
    if (!breaker) {
      return { state: 'closed', failures: 0 };
    }

    // Check if cooldown has elapsed
    if (breaker.state === 'open' && breaker.openedAt) {
      if (Date.now() - breaker.openedAt > CIRCUIT_COOLDOWN_MS) {
        breaker.state = 'half_open';
      }
    }

    return {
      state: breaker.state,
      failures: breaker.failures,
      openedAt: breaker.openedAt ? new Date(breaker.openedAt).toISOString() : undefined,
    };
  }

  recordSuccess(key: CircuitBreakerKey): void {
    const k = this.getKey(key);
    const breaker = this.breakers.get(k);
    if (breaker) {
      breaker.failures = 0;
      breaker.state = 'closed';
      breaker.openedAt = undefined;
    }
  }

  recordFailure(key: CircuitBreakerKey): CircuitBreakerStatus {
    const k = this.getKey(key);
    let breaker = this.breakers.get(k);
    if (!breaker) {
      breaker = { failures: 0, state: 'closed' };
      this.breakers.set(k, breaker);
    }

    breaker.failures++;

    if (breaker.failures >= CIRCUIT_FAILURE_THRESHOLD) {
      breaker.state = 'open';
      breaker.openedAt = Date.now();
    }

    return this.getStatus(key);
  }

  isOpen(key: CircuitBreakerKey): boolean {
    return this.getStatus(key).state === 'open';
  }

  /** Load circuit breaker states from D1 */
  async loadFromD1(db: D1Database): Promise<void> {
    try {
      const result = await db.prepare(
        `SELECT scope, scope_id, state, consecutive_failures, open_at FROM scp_circuit_state WHERE state != 'closed'`
      ).all();

      for (const row of result.results) {
        const key = `${row.scope}:${row.scope_id}`;
        this.breakers.set(key, {
          failures: row.consecutive_failures as number,
          state: row.state as 'closed' | 'open' | 'half_open',
          openedAt: row.open_at ? new Date(row.open_at as string).getTime() : undefined,
        });
      }
    } catch {
      // Fail open — if we can't read circuit state, allow requests
    }
  }
}

// ---------------------------------------------------------------------------
// Routing Controller
// ---------------------------------------------------------------------------

export interface RoutingControllerConfig {
  gateways: {
    jev?: ModelGateway;              // OpenRouter Jev Router
    deterministic?: ModelGateway;     // Direct provider routing
    local?: ModelGateway;            // Local/self-hosted models
  };
  circuitBreakers: CircuitBreakerManager;
  maxEscalations: number;            // max retries via escalation (default 2)
}

/**
 * Central routing controller.
 * Implements the SCP routing cascade with Jev Router integration.
 *
 * Flow: SCP policy → budget check → local? → Jev Router → execute → quality check → escalate?
 */
export class RoutingController {
  private readonly config: RoutingControllerConfig;

  constructor(config: RoutingControllerConfig) {
    this.config = {
      ...config,
      maxEscalations: config.maxEscalations ?? 2,
    };
  }

  /**
   * Route and execute a model request through the SCP-governed pipeline.
   * Returns the response plus routing telemetry.
   */
  async routeAndExecute(
    request: ModelRequest,
    policy: RoutingPolicyResult,
  ): Promise<{ response: ModelResponse; decision: RoutingDecision; quality: QualityEvaluation }> {
    const startTime = Date.now();
    const requestId = request._scp?.requestId ?? crypto.randomUUID();
    const tenantId = request._scp?.tenantId ?? 'unknown';
    let retryCount = 0;
    let escalated = false;
    let lastError: Error | undefined;
    let currentStrategy = policy.routingMode;

    // Routing cascade
    while (retryCount <= this.config.maxEscalations) {
      try {
        // 1. Select gateway based on strategy
        const gateway = this.selectGateway(currentStrategy, policy);
        if (!gateway) {
          // No gateway available — try fallback
          if (currentStrategy !== 'fallback' && currentStrategy !== 'deterministic') {
            currentStrategy = 'fallback';
            continue;
          }
          throw new Error(`No gateway available for strategy '${currentStrategy}'`);
        }

        // 2. Prepare the request with SCP constraints
        const constrainedRequest = this.applyConstraints(request, policy, currentStrategy);

        // 3. Execute the model call
        const response = await gateway.generate(constrainedRequest);

        // 4. Quality evaluation
        const quality = evaluateQuality(
          constrainedRequest,
          response,
          policy.minQualityScore ?? 0.7,
        );

        const latencyMs = Date.now() - startTime;

        // 5. Build routing decision record
        const decision: RoutingDecision = {
          requestId,
          tenantId,
          agentId: request._scp?.agentId,
          workflowId: request._scp?.workflowId,
          strategy: currentStrategy,
          routerModel: response._routing?.routerModel,
          selectedProvider: response._routing?.selectedProvider,
          selectedModel: response._routing?.selectedModel,
          estimatedCost: request._scp?.maxCostUsd,
          actualCost: this.calculateCost(response),
          qualityScore: quality.overallScore,
          latencyMs,
          inputTokens: response.usage?.prompt_tokens,
          outputTokens: response.usage?.completion_tokens,
          retryCount,
          escalated,
          humanReview: policy.requireHumanReview,
          policyAction: policy.allow ? 'allow' : 'reject',
          reason: quality.passed
            ? `${currentStrategy} routing succeeded`
            : `Quality: ${quality.recommendation}`,
          createdAt: new Date().toISOString(),
        };

        // 6. Record circuit breaker success (multi-level)
        this.config.circuitBreakers.recordSuccess({ scope: 'strategy', scopeId: currentStrategy });
        if (response._routing?.routerModel) {
          this.config.circuitBreakers.recordSuccess({ scope: 'router', scopeId: response._routing.routerModel });
        }
        if (response._routing?.selectedProvider) {
          this.config.circuitBreakers.recordSuccess({ scope: 'provider', scopeId: response._routing.selectedProvider });
        }
        if (response._routing?.selectedModel) {
          this.config.circuitBreakers.recordSuccess({ scope: 'model', scopeId: response._routing.selectedModel });
        }

        // 7. Quality-based escalation
        if (!quality.passed && retryCount < this.config.maxEscalations) {
          if (quality.recommendation === 'escalate') {
            currentStrategy = this.escalateStrategy(currentStrategy);
            escalated = true;
            retryCount++;
            continue;
          } else if (quality.recommendation === 'human_review') {
            decision.humanReview = true;
            decision.strategy = 'human';
            return { response, decision, quality };
          }
        }

        return { response, decision, quality };

      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Record circuit breaker failure for the active strategy
        this.config.circuitBreakers.recordFailure({ scope: 'strategy', scopeId: currentStrategy });
        
        // If we know which provider/model failed, trip those too, but we might not have a response
        // In a real system, the Gateway could throw a specific error with provider/model details

        // Try next strategy in fallback chain
        const nextStrategy = this.getNextFallback(currentStrategy);
        if (nextStrategy && retryCount < this.config.maxEscalations) {
          currentStrategy = nextStrategy;
          escalated = true;
          retryCount++;
          continue;
        }

        break;
      }
    }

    // All strategies exhausted — return error as human review
    const decision: RoutingDecision = {
      requestId,
      tenantId,
      agentId: request._scp?.agentId,
      workflowId: request._scp?.workflowId,
      strategy: 'human',
      retryCount,
      escalated: true,
      humanReview: true,
      policyAction: 'escalate',
      reason: `All routing strategies exhausted: ${lastError?.message}`,
      createdAt: new Date().toISOString(),
    };

    throw new RoutingExhaustedError(
      `Routing exhausted after ${retryCount} attempts: ${lastError?.message}`,
      decision,
    );
  }

  /** Select the appropriate gateway for the current strategy */
  private selectGateway(
    strategy: RoutingStrategy,
    policy: RoutingPolicyResult,
  ): ModelGateway | null {
    switch (strategy) {
      case 'jev':
        // Check Jev circuit breaker
        if (this.config.circuitBreakers.isOpen({ scope: 'strategy', scopeId: 'jev' }) ||
            this.config.circuitBreakers.isOpen({ scope: 'router', scopeId: 'jev-router' })) {
          return null;
        }
        return this.config.gateways.jev ?? null;

      case 'deterministic':
      case 'fallback':
        return this.config.gateways.deterministic ?? null;

      case 'local':
        return this.config.gateways.local ?? null;

      case 'human':
        return null; // Human review doesn't use a gateway

      default:
        return this.config.gateways.jev ?? this.config.gateways.deterministic ?? null;
    }
  }

  /** Apply SCP constraints to the request before sending to gateway */
  private applyConstraints(
    request: ModelRequest,
    policy: RoutingPolicyResult,
    strategy: RoutingStrategy,
  ): ModelRequest {
    const constrained = { ...request };

    // For Jev routing, set model to jev-router
    if (strategy === 'jev') {
      constrained.model = 'typesafe/jev-router';
    }

    // For deterministic routing, use the specified model
    if (strategy === 'deterministic' && policy.deterministicModel) {
      constrained.model = policy.deterministicModel;
    }

    // For fallback routing, use the policy-configured fallback model
    if (strategy === 'fallback') {
      if (!policy.fallbackModel) {
        throw new Error("No fallback model defined in policy");
      }
      constrained.model = policy.fallbackModel;
    }

    // Attach SCP metadata for gateway to use
    constrained._scp = {
      ...constrained._scp!,
      requestId: constrained._scp?.requestId ?? crypto.randomUUID(),
      tenantId: constrained._scp?.tenantId ?? 'unknown',
      routingStrategy: strategy,
      maxCostUsd: strategy === 'fallback' && policy.fallbackMaxCostUsd ? policy.fallbackMaxCostUsd : policy.maxCostUsd,
      allowedProviders: strategy === 'fallback' && policy.fallbackProvider ? [policy.fallbackProvider] : policy.allowedProviders,
      blockedModels: policy.blockedModels,
      maxReasoningLevel: strategy === 'fallback' && policy.fallbackReasoningLevel ? policy.fallbackReasoningLevel : policy.maxReasoningLevel,
    };

    return constrained;
  }

  /** Get the next fallback strategy when current strategy fails */
  private getNextFallback(current: RoutingStrategy): RoutingStrategy | null {
    const fallbackChain: RoutingStrategy[] = ['jev', 'deterministic', 'local', 'human'];
    const currentIndex = fallbackChain.indexOf(current);
    if (currentIndex >= 0 && currentIndex < fallbackChain.length - 1) {
      return fallbackChain[currentIndex + 1];
    }
    return null;
  }

  /** Escalate to a stronger model strategy */
  private escalateStrategy(current: RoutingStrategy): RoutingStrategy {
    // local → jev → deterministic → human
    switch (current) {
      case 'local': return 'jev';
      case 'jev': return 'deterministic';
      case 'deterministic': return 'human';
      case 'fallback': return 'deterministic';
      default: return 'human';
    }
  }

  /** Calculate cost from response usage */
  private calculateCost(response: ModelResponse): number | undefined {
    if (!response.usage) return undefined;
    // Rough cost estimate — in production, use the pricing table
    const costPerMToken = 5.0; // average $/1M tokens
    return (response.usage.total_tokens / 1_000_000) * costPerMToken;
  }
}

/** Error thrown when all routing strategies are exhausted */
export class RoutingExhaustedError extends Error {
  constructor(
    message: string,
    public readonly decision: RoutingDecision,
  ) {
    super(message);
    this.name = 'RoutingExhaustedError';
  }
}
