/**
 * Neuron-First & Adaptive Model Router (`ModelRouter.route()`)
 *
 * Implements Section 3 of the v2.0 Directive + Capability 1 of v3.0 Addendum:
 * Mandatory routing priority order:
 *   1. Existing deterministic function, when the task does not need AI.
 *   2. Workers AI lightweight model (@cf/ibm-granite/granite-4.0-h-micro, @cf/zai-org/glm-4.7-flash).
 *   3. Workers AI general model (@cf/google/gemma-4-26b-a4b, @cf/deepseek-ai/deepseek-v4.1-flash-1017).
 *   4. Workers AI advanced reasoning model (@cf/zai-org/glm-5.3).
 *   5. Existing MiniMind inference service, when a benchmark demonstrates better task-specific cost, latency, or quality.
 *   6. Approved external LLM through the existing AgentGateway (ONLY under explicit policy).
 *   7. Human approval or explicit failure if no compliant route is available.
 *
 * Integrates with existing `CircuitBreakerManager`, `evaluateQuality`, and `RoutingDecision` from `../routing`.
 */

import { ModelRequest, ModelResponse, ModelGateway, RoutingDecision, QualityEvaluation } from '../types';
import { CircuitBreakerManager, evaluateQuality, RoutingExhaustedError } from '../routing';
import { ModelRegistry, ModelCapabilityEntry, ModelTier, DataClassificationLevel } from './model-registry';
import { ModelLifecycleManager } from './model-lifecycle';
import { TaskClassifier, TaskClassification, TaskType } from './task-classifier';
import { CapabilityValidator } from './capability-validator';
import { ExternalFallbackPolicy, FallbackTriggerReason } from './fallback-policy';

export interface NeuronRoutingConfig {
  mode: 'cloudflare_first' | 'legacy';
  prefer_deterministic: boolean;
  external_llm_default: boolean;
  external_fallback_enabled: boolean;
  external_fallback_requires_policy: boolean;
  external_budget_overrun_action: 'deny' | 'alert' | 'human_approval';
  max_model_attempts: number;
  log_routing_decisions: boolean;
}

export const DEFAULT_NEURON_ROUTING_CONFIG: NeuronRoutingConfig = {
  mode: 'cloudflare_first',
  prefer_deterministic: true,
  external_llm_default: false,
  external_fallback_enabled: true,
  external_fallback_requires_policy: true,
  external_budget_overrun_action: 'deny',
  max_model_attempts: 3,
  log_routing_decisions: true,
};

export interface BenchmarkMetric {
  taskType: TaskType;
  modelId: string;
  avgQualityScore: number;
  avgLatencyMs: number;
  avgCostUsd: number;
}

export interface RouteContext {
  tenantId: string;
  agentId?: string;
  workflowId?: string;
  tenantDataClass?: DataClassificationLevel;
  tenantExternalLlmEnabled?: boolean;
  preferMiniMindOnBenchmark?: boolean;
  remainingWorkersAiNeurons?: number;
  remainingExternalBudgetUsd?: number;
  maxRequestCostUsd?: number;
  minQualityScore?: number;
  requiredRegion?: string;
  specializedExternalModelRequired?: string;
  isByokRequest?: boolean;
  byokVaultKeyPresent?: boolean;
  unifiedBillingFallbackAuthorized?: boolean;
  benchmarks?: BenchmarkMetric[];
}

export interface RoutePlan {
  priority: number;
  tier: ModelTier;
  selectedModel?: ModelCapabilityEntry;
  deterministicHandler?: string;
  task: TaskClassification;
  estimatedNeurons: number;
  estimatedCostUsd: number;
  candidates: ModelCapabilityEntry[];
  fallbackReason?: FallbackTriggerReason;
  humanApprovalRequired: boolean;
  denialReason?: string;
}

export interface ModelRouterGateways {
  workersAi?: ModelGateway;
  minimind?: ModelGateway;
  external?: ModelGateway;
}

export class ModelRouter {
  private readonly registry: ModelRegistry;
  private readonly lifecycle: ModelLifecycleManager;
  private readonly classifier: TaskClassifier;
  private readonly validator: CapabilityValidator;
  private readonly fallbackPolicy: ExternalFallbackPolicy;
  private readonly circuitBreakers: CircuitBreakerManager;
  private readonly config: NeuronRoutingConfig;
  private readonly gateways: ModelRouterGateways;

  constructor(options: {
    registry?: ModelRegistry;
    circuitBreakers?: CircuitBreakerManager;
    config?: Partial<NeuronRoutingConfig>;
    gateways?: ModelRouterGateways;
  } = {}) {
    this.registry = options.registry ?? new ModelRegistry();
    this.lifecycle = new ModelLifecycleManager(this.registry);
    this.classifier = new TaskClassifier();
    this.validator = new CapabilityValidator();
    this.fallbackPolicy = new ExternalFallbackPolicy();
    this.circuitBreakers = options.circuitBreakers ?? new CircuitBreakerManager();
    this.config = { ...DEFAULT_NEURON_ROUTING_CONFIG, ...(options.config ?? {}) };
    this.gateways = options.gateways ?? {};
  }

  getRegistry(): ModelRegistry {
    return this.registry;
  }

  getLifecycleManager(): ModelLifecycleManager {
    return this.lifecycle;
  }

  getConfig(): NeuronRoutingConfig {
    return this.config;
  }

  /**
   * Compute the ordered route plan (`ModelRouter.route()`) without side effects.
   */
  route(request: ModelRequest, ctx: RouteContext): RoutePlan {
    const task = this.classifier.classify(request, {
      preferDeterministic: this.config.prefer_deterministic,
      tenantDataClass: ctx.tenantDataClass,
    });

    // Priority 1: Deterministic function when the task does not need AI
    if (task.canRunDeterministically && task.deterministicHandlerName) {
      return {
        priority: 1,
        tier: 'deterministic',
        deterministicHandler: task.deterministicHandlerName,
        task,
        estimatedNeurons: 0,
        estimatedCostUsd: 0,
        candidates: [],
        humanApprovalRequired: false,
      };
    }

    // Check if an explicit requested model is retired/migrated
    if (request.model && !request.model.startsWith('gpt-') && request.model !== 'auto') {
      const lifecycleCheck = this.lifecycle.resolveOperationalModel(request.model);
      if (!lifecycleCheck.usable && !lifecycleCheck.resolvedModel) {
        // Explicit requested model is retired with no replacement — evaluate tier candidates instead
      }
    }

    // Build ordered Workers AI & MiniMind candidate chain based on task complexity
    const desiredTiers = this.selectTierOrder(task, ctx);
    const compatibleCandidates: ModelCapabilityEntry[] = [];

    for (const tier of desiredTiers) {
      const modelsInTier = this.registry.listAll().filter((m) => m.tier === tier);
      // Sort within tier by lowest cost, then highest quality baseline
      modelsInTier.sort((a, b) => {
        const costA = this.estimateCostUsd(a, task.estimatedInputTokens, task.estimatedOutputTokens);
        const costB = this.estimateCostUsd(b, task.estimatedInputTokens, task.estimatedOutputTokens);
        if (Math.abs(costA - costB) > 0.000001) return costA - costB;
        return b.qualityBaseline - a.qualityBaseline;
      });

      for (const candidate of modelsInTier) {
        // Check circuit breaker for provider & model
        if (
          this.circuitBreakers.isOpen({ scope: 'provider', scopeId: candidate.provider }) ||
          this.circuitBreakers.isOpen({ scope: 'model', scopeId: candidate.modelId })
        ) {
          continue;
        }

        const validation = this.validator.validate(candidate, task, {
          tenantId: ctx.tenantId,
          requiredRegion: ctx.requiredRegion,
        });
        if (!validation.compatible) continue;

        const estNeurons = this.estimateNeurons(candidate, task.estimatedInputTokens, task.estimatedOutputTokens);
        const estCost = this.estimateCostUsd(candidate, task.estimatedInputTokens, task.estimatedOutputTokens);

        // Enforce Neuron budget if provided
        if (
          candidate.provider === 'workers-ai' &&
          ctx.remainingWorkersAiNeurons !== undefined &&
          ctx.remainingWorkersAiNeurons < estNeurons
        ) {
          continue;
        }

        // Enforce max request cost ceiling if provided
        if (ctx.maxRequestCostUsd !== undefined && estCost > ctx.maxRequestCostUsd) {
          continue;
        }

        compatibleCandidates.push(candidate);
      }
    }

    // Check if specialized workflow explicitly requires an external provider
    if (ctx.specializedExternalModelRequired) {
      const extModel = this.registry.get(ctx.specializedExternalModelRequired);
      if (extModel) {
        const estCost = this.estimateCostUsd(extModel, task.estimatedInputTokens, task.estimatedOutputTokens);
        const fbDecision = this.fallbackPolicy.evaluate({
          candidateModel: extModel,
          tenantId: ctx.tenantId,
          tenantExternalLlmEnabled: Boolean(ctx.tenantExternalLlmEnabled),
          policyExternalFallbackEnabled: this.config.external_fallback_enabled,
          policyRequiresExplicitAuthorization: this.config.external_fallback_requires_policy,
          dataClass: task.dataClass,
          remainingExternalBudgetUsd: ctx.remainingExternalBudgetUsd ?? 0,
          estimatedRequestCostUsd: estCost,
          maxRequestCeilingUsd: ctx.maxRequestCostUsd ?? 1.0,
          triggerReason: 'specialized_workflow_requirement',
          isByokRequest: ctx.isByokRequest,
          byokVaultKeyPresent: ctx.byokVaultKeyPresent,
          unifiedBillingFallbackAuthorized: ctx.unifiedBillingFallbackAuthorized,
        });
        if (fbDecision.allowed) {
          return {
            priority: 6,
            tier: 'external',
            selectedModel: extModel,
            task,
            estimatedNeurons: 0,
            estimatedCostUsd: estCost,
            candidates: [extModel],
            fallbackReason: 'specialized_workflow_requirement',
            humanApprovalRequired: false,
          };
        }
        return {
          priority: 7,
          tier: 'external',
          task,
          estimatedNeurons: 0,
          estimatedCostUsd: 0,
          candidates: [],
          humanApprovalRequired: true,
          denialReason: fbDecision.reason,
        };
      }
    }

    if (compatibleCandidates.length > 0) {
      const primary = compatibleCandidates[0];
      const priorityMap: Record<ModelTier, number> = {
        deterministic: 1,
        lightweight: 2,
        general: 3,
        reasoning: 4,
        minimind: 5,
        external: 6,
      };
      return {
        priority: priorityMap[primary.tier],
        tier: primary.tier,
        selectedModel: primary,
        task,
        estimatedNeurons: this.estimateNeurons(primary, task.estimatedInputTokens, task.estimatedOutputTokens),
        estimatedCostUsd: this.estimateCostUsd(primary, task.estimatedInputTokens, task.estimatedOutputTokens),
        candidates: compatibleCandidates,
        humanApprovalRequired: false,
      };
    }

    // No internal (Workers AI / MiniMind) candidate succeeded — evaluate external fallback (Priority 6)
    const externalCandidates = this.registry.listAll().filter((m) => m.tier === 'external');
    for (const ext of externalCandidates) {
      const validation = this.validator.validate(ext, task, {
        tenantId: ctx.tenantId,
        requiredRegion: ctx.requiredRegion,
      });
      if (!validation.compatible) continue;

      const estCost = this.estimateCostUsd(ext, task.estimatedInputTokens, task.estimatedOutputTokens);
      const triggerReason: FallbackTriggerReason =
        ctx.remainingWorkersAiNeurons !== undefined && ctx.remainingWorkersAiNeurons <= 0
          ? 'budget_or_security_check_failed'
          : 'missing_workers_ai_capability';

      const fb = this.fallbackPolicy.evaluate({
        candidateModel: ext,
        tenantId: ctx.tenantId,
        tenantExternalLlmEnabled: Boolean(ctx.tenantExternalLlmEnabled),
        policyExternalFallbackEnabled: this.config.external_fallback_enabled,
        policyRequiresExplicitAuthorization: this.config.external_fallback_requires_policy,
        dataClass: task.dataClass,
        remainingExternalBudgetUsd: ctx.remainingExternalBudgetUsd ?? 0,
        estimatedRequestCostUsd: estCost,
        maxRequestCeilingUsd: ctx.maxRequestCostUsd ?? 1.0,
        triggerReason,
        isByokRequest: ctx.isByokRequest,
        byokVaultKeyPresent: ctx.byokVaultKeyPresent,
        unifiedBillingFallbackAuthorized: ctx.unifiedBillingFallbackAuthorized,
      });

      if (fb.allowed) {
        return {
          priority: 6,
          tier: 'external',
          selectedModel: ext,
          task,
          estimatedNeurons: 0,
          estimatedCostUsd: estCost,
          candidates: [ext],
          fallbackReason: triggerReason,
          humanApprovalRequired: false,
        };
      }
    }

    // Priority 7: Human approval or explicit failure
    return {
      priority: 7,
      tier: 'external',
      task,
      estimatedNeurons: 0,
      estimatedCostUsd: 0,
      candidates: [],
      humanApprovalRequired: true,
      denialReason: 'No compliant Workers AI, MiniMind, or authorized external route available for request',
    };
  }

  /**
   * Execute a request using the Neuron-first route plan, bounded attempts,
   * quality verification, and safe escalation rules.
   */
  async routeAndExecute(
    request: ModelRequest,
    ctx: RouteContext,
  ): Promise<{
    response: ModelResponse;
    decision: RoutingDecision;
    quality: QualityEvaluation;
    plan: RoutePlan;
    estimatedNeurons: number;
    actualNeurons?: number;
  }> {
    const startTime = Date.now();
    const requestId = request._scp?.requestId ?? crypto.randomUUID();
    const plan = this.route(request, ctx);

    // Priority 1: Execute deterministic handler without LLM invocation
    if (plan.priority === 1 && plan.deterministicHandler) {
      const response = this.classifier.executeDeterministic(request, plan.deterministicHandler);
      const quality = evaluateQuality(request, response, ctx.minQualityScore ?? 0.7);
      const decision: RoutingDecision = {
        requestId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        workflowId: ctx.workflowId,
        strategy: 'deterministic',
        selectedProvider: 'deterministic-local',
        selectedModel: response.model,
        estimatedCost: 0,
        actualCost: 0,
        qualityScore: quality.overallScore,
        latencyMs: Date.now() - startTime,
        inputTokens: 0,
        outputTokens: 0,
        retryCount: 0,
        escalated: false,
        humanReview: false,
        policyAction: 'allow',
        reason: `Deterministic function '${plan.deterministicHandler}' executed without LLM`,
        createdAt: new Date().toISOString(),
      };
      return { response, decision, quality, plan, estimatedNeurons: 0, actualNeurons: 0 };
    }

    if (plan.humanApprovalRequired || plan.candidates.length === 0) {
      const decision: RoutingDecision = {
        requestId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        workflowId: ctx.workflowId,
        strategy: 'human',
        retryCount: 0,
        escalated: false,
        humanReview: true,
        policyAction: 'reject',
        reason: plan.denialReason ?? 'No eligible model candidate',
        createdAt: new Date().toISOString(),
      };
      throw new RoutingExhaustedError(decision.reason!, decision);
    }

    const maxAttempts = Math.min(this.config.max_model_attempts, plan.candidates.length);
    let lastError: Error | undefined;
    let attempts = 0;

    for (let i = 0; i < maxAttempts; i++) {
      const candidate = plan.candidates[i];
      attempts++;
      const gateway = this.resolveGatewayForCandidate(candidate);
      if (!gateway) {
        lastError = new Error(`Gateway for provider '${candidate.provider}' is not configured`);
        continue;
      }

      try {
        const candidateReq: ModelRequest = {
          ...request,
          model: candidate.modelId,
          _scp: {
            requestId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            workflowId: ctx.workflowId,
            routingStrategy: candidate.provider === 'minimind' ? 'local' : 'deterministic',
            maxCostUsd: ctx.maxRequestCostUsd,
            minQualityScore: ctx.minQualityScore,
          },
        };

        const response = await gateway.generate(candidateReq);
        const quality = evaluateQuality(candidateReq, response, ctx.minQualityScore ?? 0.7);
        const estNeurons = this.estimateNeurons(
          candidate,
          response.usage?.prompt_tokens ?? plan.task.estimatedInputTokens,
          response.usage?.completion_tokens ?? plan.task.estimatedOutputTokens,
        );
        const actualCost = this.estimateCostUsd(
          candidate,
          response.usage?.prompt_tokens ?? plan.task.estimatedInputTokens,
          response.usage?.completion_tokens ?? plan.task.estimatedOutputTokens,
        );

        this.circuitBreakers.recordSuccess({ scope: 'provider', scopeId: candidate.provider });
        this.circuitBreakers.recordSuccess({ scope: 'model', scopeId: candidate.modelId });

        // If quality failed and another Workers AI candidate exists in our chain, escalate within Workers AI
        if (!quality.passed && i < maxAttempts - 1) {
          continue;
        }

        const decision: RoutingDecision = {
          requestId,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          workflowId: ctx.workflowId,
          strategy: candidate.provider === 'minimind' ? 'local' : 'deterministic',
          routerModel: response._routing?.routerModel ?? 'neuron-first-router',
          selectedProvider: candidate.provider,
          selectedModel: candidate.modelId,
          estimatedCost: plan.estimatedCostUsd,
          actualCost,
          qualityScore: quality.overallScore,
          latencyMs: Date.now() - startTime,
          inputTokens: response.usage?.prompt_tokens,
          outputTokens: response.usage?.completion_tokens,
          retryCount: i,
          escalated: i > 0,
          humanReview: !quality.passed,
          policyAction: 'allow',
          reason:
            i === 0
              ? `Routed to ${candidate.tier} (${candidate.modelId})`
              : `Escalated to ${candidate.tier} (${candidate.modelId}) after ${i} attempt(s)`,
          createdAt: new Date().toISOString(),
        };

        const actualNeurons = (response as any)._neurons?.actualNeurons;
        return {
          response,
          decision,
          quality,
          plan,
          estimatedNeurons: estNeurons,
          actualNeurons,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.circuitBreakers.recordFailure({ scope: 'provider', scopeId: candidate.provider });
        this.circuitBreakers.recordFailure({ scope: 'model', scopeId: candidate.modelId });
      }
    }

    // All internal attempts failed — check if external fallback is policy-authorized
    if (this.config.external_fallback_enabled && ctx.tenantExternalLlmEnabled && this.gateways.external) {
      const extCandidates = this.registry.listAll().filter((m) => m.tier === 'external' && m.enabled);
      for (const ext of extCandidates) {
        const estCost = this.estimateCostUsd(ext, plan.task.estimatedInputTokens, plan.task.estimatedOutputTokens);
        const fb = this.fallbackPolicy.evaluate({
          candidateModel: ext,
          tenantId: ctx.tenantId,
          tenantExternalLlmEnabled: true,
          policyExternalFallbackEnabled: this.config.external_fallback_enabled,
          policyRequiresExplicitAuthorization: this.config.external_fallback_requires_policy,
          dataClass: plan.task.dataClass,
          remainingExternalBudgetUsd: ctx.remainingExternalBudgetUsd ?? 0,
          estimatedRequestCostUsd: estCost,
          maxRequestCeilingUsd: ctx.maxRequestCostUsd ?? 1.0,
          triggerReason: 'workers_ai_unavailable_or_capacity',
          isByokRequest: ctx.isByokRequest,
          byokVaultKeyPresent: ctx.byokVaultKeyPresent,
          unifiedBillingFallbackAuthorized: ctx.unifiedBillingFallbackAuthorized,
        });

        if (fb.allowed) {
          const response = await this.gateways.external.generate({
            ...request,
            model: ext.modelId,
          });
          const quality = evaluateQuality(request, response, ctx.minQualityScore ?? 0.7);
          const decision: RoutingDecision = {
            requestId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            workflowId: ctx.workflowId,
            strategy: 'fallback',
            selectedProvider: ext.provider,
            selectedModel: ext.modelId,
            estimatedCost: estCost,
            actualCost: estCost,
            qualityScore: quality.overallScore,
            latencyMs: Date.now() - startTime,
            inputTokens: response.usage?.prompt_tokens,
            outputTokens: response.usage?.completion_tokens,
            retryCount: attempts,
            escalated: true,
            humanReview: false,
            policyAction: 'allow',
            reason: fb.reason,
            createdAt: new Date().toISOString(),
          };
          return {
            response,
            decision,
            quality,
            plan,
            estimatedNeurons: 0,
          };
        }
      }
    }

    const failedDecision: RoutingDecision = {
      requestId,
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      workflowId: ctx.workflowId,
      strategy: 'human',
      retryCount: attempts,
      escalated: attempts > 1,
      humanReview: true,
      policyAction: 'escalate',
      reason: `All authorized routes failed without unauthorized external fallback: ${lastError?.message ?? 'unknown'}`,
      createdAt: new Date().toISOString(),
    };
    throw new RoutingExhaustedError(failedDecision.reason!, failedDecision);
  }

  private selectTierOrder(task: TaskClassification, ctx: RouteContext): ModelTier[] {
    // Check if MiniMind has a benchmark demonstrating better cost/latency/quality for this taskType
    const miniMindAhead = this.shouldPlaceMiniMindAhead(task.taskType, ctx);

    let tiers: ModelTier[];
    switch (task.complexity) {
      case 'trivial':
      case 'low':
        tiers = ['lightweight', 'general', 'reasoning'];
        break;
      case 'medium':
        tiers = ['general', 'reasoning', 'lightweight'];
        break;
      case 'high':
        tiers = ['reasoning', 'general'];
        break;
    }

    if (miniMindAhead) {
      return ['minimind', ...tiers];
    }
    return [...tiers, 'minimind'];
  }

  private shouldPlaceMiniMindAhead(taskType: TaskType, ctx: RouteContext): boolean {
    if (!ctx.preferMiniMindOnBenchmark || !ctx.benchmarks || ctx.benchmarks.length === 0) {
      return false;
    }
    const mmBench = ctx.benchmarks.find(
      (b) => b.taskType === taskType && (b.modelId.startsWith('minimind') || b.modelId === 'nanojev'),
    );
    if (!mmBench) return false;
    const minQuality = ctx.minQualityScore ?? 0.8;
    return mmBench.avgQualityScore >= minQuality;
  }

  private resolveGatewayForCandidate(candidate: ModelCapabilityEntry): ModelGateway | undefined {
    if (candidate.provider === 'workers-ai') return this.gateways.workersAi;
    if (candidate.provider === 'minimind') return this.gateways.minimind;
    return this.gateways.external;
  }

  estimateNeurons(model: ModelCapabilityEntry, inputTokens: number, outputTokens: number): number {
    if (model.provider !== 'workers-ai') return 0;
    const neurons =
      (inputTokens / 1_000_000) * model.inputNeuronsPerM +
      (outputTokens / 1_000_000) * model.outputNeuronsPerM;
    return Number(neurons.toFixed(4));
  }

  estimateCostUsd(model: ModelCapabilityEntry, inputTokens: number, outputTokens: number): number {
    const usd =
      (inputTokens / 1_000_000) * model.inputPricePerMUsd +
      (outputTokens / 1_000_000) * model.outputPricePerMUsd;
    return Number(usd.toFixed(8));
  }
}
