import { describe, it, expect, vi } from 'vitest';
import { ModelRegistry } from '../inference/model-registry';
import { ModelRouter } from '../inference/model-router';
import { WorkersAIGateway } from '../inference/providers/workers-ai';
import { QualityVerificationEngine } from '../inference/quality-verifier';
import { ContextOptimizationEngine } from '../inference/context-optimizer';
import { StormDropExplorationEngine } from '../inference/stormdrop';
import { RoutingExhaustedError } from '../routing';
import { ModelGateway, ModelRequest, ModelResponse } from '../types';

function createMockWorkersAI(responseText = 'Processed by Workers AI'): {
  binding: { run: ReturnType<typeof vi.fn> };
  gateway: WorkersAIGateway;
} {
  const run = vi.fn().mockResolvedValue({
    response: responseText,
    usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 },
  });
  const gateway = new WorkersAIGateway({
    aiBinding: { run },
    gatewayId: 'agent-gateway',
  });
  return { binding: { run }, gateway };
}

describe('Neuron-First Inference & ModelRouter (Section 3, 4, 11, 17)', () => {
  it('1. chooses Workers AI by default via env.AI.run and passes AI Gateway id', async () => {
    const { binding, gateway } = createMockWorkersAI('Classification: billing_inquiry');
    const router = new ModelRouter({
      gateways: { workersAi: gateway },
    });

    const req: ModelRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Classify this customer support ticket into a category.' }],
    };

    const out = await router.routeAndExecute(req, { tenantId: 'tenant-a' });
    expect(out.decision.selectedProvider).toBe('workers-ai');
    expect(out.plan.tier).toBe('lightweight');
    expect(out.decision.selectedModel).toBe('@cf/ibm-granite/granite-4.0-h-micro');
    expect(binding.run).toHaveBeenCalledWith(
      '@cf/ibm-granite/granite-4.0-h-micro',
      expect.objectContaining({ messages: expect.any(Array) }),
      expect.objectContaining({
        gateway: expect.objectContaining({ id: 'agent-gateway' }),
      }),
    );
  });

  it('2. executes deterministic function without LLM invocation when appropriate', async () => {
    const { binding, gateway } = createMockWorkersAI();
    const router = new ModelRouter({
      gateways: { workersAi: gateway },
    });

    const req: ModelRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'calculate (12 + 8) * 3' }],
    };

    const out = await router.routeAndExecute(req, { tenantId: 'tenant-a' });
    expect(out.plan.priority).toBe(1);
    expect(out.plan.tier).toBe('deterministic');
    expect(out.response.choices[0].message.content).toBe('60');
    expect(out.estimatedNeurons).toBe(0);
    expect(binding.run).not.toHaveBeenCalled();
  });

  it('3. low-complexity tasks do not invoke expensive reasoning or external models', () => {
    const router = new ModelRouter();
    const plan = router.route(
      {
        model: 'auto',
        messages: [{ role: 'user', content: 'Extract JSON fields from this short receipt.' }],
      },
      { tenantId: 'tenant-a' },
    );

    expect(plan.tier).toBe('lightweight');
    expect(plan.selectedModel?.modelId).toBe('@cf/ibm-granite/granite-4.0-h-micro');
    expect(plan.selectedModel?.provider).toBe('workers-ai');
  });

  it('4. maps @cf/google/gemma-4-26b-a4b alias to live catalog ID @cf/google/gemma-4-26b-a4b-it', async () => {
    const { binding, gateway } = createMockWorkersAI('Gemma 4 response');
    const req: ModelRequest = {
      model: '@cf/google/gemma-4-26b-a4b',
      messages: [{ role: 'user', content: 'Summarize this architecture.' }],
    };
    const res = await gateway.generate(req);
    expect(res.model).toBe('@cf/google/gemma-4-26b-a4b');
    expect(binding.run).toHaveBeenCalledWith(
      '@cf/google/gemma-4-26b-a4b-it',
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('5. provider failure does NOT trigger unauthorized external fallback', async () => {
    const failingWorkersAi: ModelGateway = {
      name: 'workers-ai',
      generate: vi.fn().mockRejectedValue(new Error('503 Service Unavailable')),
      isAvailable: vi.fn().mockResolvedValue(false),
    };
    const externalSpy = vi.fn().mockResolvedValue({} as ModelResponse);
    const externalGateway: ModelGateway = {
      name: 'external-ai',
      generate: externalSpy,
      isAvailable: vi.fn().mockResolvedValue(true),
    };

    const router = new ModelRouter({
      gateways: {
        workersAi: failingWorkersAi,
        external: externalGateway,
      },
    });

    await expect(
      router.routeAndExecute(
        {
          model: 'auto',
          messages: [{ role: 'user', content: 'Summarize quarterly numbers.' }],
        },
        {
          tenantId: 'tenant-no-external',
          tenantExternalLlmEnabled: false,
        },
      ),
    ).rejects.toThrow(RoutingExhaustedError);

    expect(externalSpy).not.toHaveBeenCalled();
  });

  it('6. missing capabilities produce an explicit escalation or failure', () => {
    const registry = new ModelRegistry();
    // Require a 2,000,000-token context window that no model in the registry supports
    const router = new ModelRouter({ registry });
    const hugePrompt = 'a'.repeat(8_000_004); // > 2M estimated tokens

    const plan = router.route(
      {
        model: 'auto',
        messages: [{ role: 'user', content: hugePrompt }],
      },
      { tenantId: 'tenant-a' },
    );

    expect(plan.humanApprovalRequired).toBe(true);
    expect(plan.priority).toBe(7);
    expect(plan.candidates.length).toBe(0);
  });

  it('7. handles model retirement or unavailability cleanly by routing to active replacement/peer', () => {
    const registry = new ModelRegistry();
    const router = new ModelRouter({ registry });

    // Mark granite-4.0-h-micro as retired with replacement glm-4.7-flash
    router
      .getLifecycleManager()
      .transitionStatus(
        '@cf/ibm-granite/granite-4.0-h-micro',
        'retired',
        'Scheduled model retirement',
        '@cf/zai-org/glm-4.7-flash',
      );

    const lifecycleResolution = router
      .getLifecycleManager()
      .resolveOperationalModel('@cf/ibm-granite/granite-4.0-h-micro');
    expect(lifecycleResolution.usable).toBe(true);
    expect(lifecycleResolution.resolvedModel?.modelId).toBe('@cf/zai-org/glm-4.7-flash');
    expect(lifecycleResolution.migratedFrom).toBe('@cf/ibm-granite/granite-4.0-h-micro');

    const plan = router.route(
      {
        model: 'auto',
        messages: [{ role: 'user', content: 'Classify this short note.' }],
      },
      { tenantId: 'tenant-a' },
    );
    expect(plan.selectedModel?.modelId).toBe('@cf/zai-org/glm-4.7-flash');
  });

  it('8. places MiniMind ahead of Workers AI only when tenant policy and measured benchmark justify it', () => {
    const router = new ModelRouter();
    const plan = router.route(
      {
        model: 'auto',
        messages: [{ role: 'user', content: 'Classify this customer intent.' }],
      },
      {
        tenantId: 'tenant-mm',
        preferMiniMindOnBenchmark: true,
        benchmarks: [
          {
            taskType: 'classification',
            modelId: 'minimind/specialist-v1',
            avgQualityScore: 0.93,
            avgLatencyMs: 120,
            avgCostUsd: 0.00001,
          },
        ],
      },
    );

    expect(plan.selectedModel?.provider).toBe('minimind');
    expect(plan.tier).toBe('minimind');
  });

  it('9. v3.0 Quality Verification, Context Optimizer, and StormDrop gates work deterministically', async () => {
    const verifier = new QualityVerificationEngine();
    const badJsonEvaluation = await verifier.verify(
      {
        model: '@cf/ibm-granite/granite-4.0-h-micro',
        messages: [{ role: 'user', content: 'Return JSON' }],
        response_format: { type: 'json_object' },
      },
      {
        id: '1',
        object: 'chat.completion',
        created: 1,
        model: '@cf/ibm-granite/granite-4.0-h-micro',
        choices: [{ index: 0, message: { role: 'assistant', content: '{not-valid-json' }, finish_reason: 'stop' }],
      },
    );
    expect(badJsonEvaluation.passed).toBe(false);

    const ctxOptimizer = new ContextOptimizationEngine();
    const opt = ctxOptimizer.optimize({
      systemInstruction: 'You are a financial analyst.',
      userQuery: 'What is the revenue?',
      maxContextTokens: 500,
      chunks: [
        { id: 'c1', source: 'doc1', content: 'Q3 revenue was $12M.', relevanceScore: 0.9, isStaticPrefix: true },
        { id: 'c2', source: 'doc2', content: 'Q3 revenue was $12M.', relevanceScore: 0.85 }, // duplicate
        { id: 'c3', source: 'doc3', content: 'Irrelevant cafeteria menu.', relevanceScore: 0.2 }, // below threshold
      ],
    });
    expect(opt.deduplicatedCount).toBe(1);
    expect(opt.includedChunkIds).toEqual(['c1']);

    const stormDrop = new StormDropExplorationEngine();
    // Sensitive workload is never sampled without explicit authorization
    const sensitiveSample = stormDrop.evaluateSample({
      requestId: 'req-1',
      tenantId: 'tenant-a',
      sampleRatePct: 100,
      dataClass: 'restricted',
      risk: 'high',
      remainingExperimentBudgetUsd: 10,
      estimatedComparisonCostUsd: 0.01,
    });
    expect(sensitiveSample.sampled).toBe(false);

    // Missing quality metrics never promote a candidate policy
    const promo = stormDrop.evaluatePromotion({
      taskType: 'classification',
      candidateModelId: '@cf/zai-org/glm-4.7-flash',
      baselineModelId: '@cf/ibm-granite/granite-4.0-h-micro',
      sampleCount: 10,
      candidateQualityScore: undefined,
      baselineQualityScore: 0.85,
      candidateAvgCostUsd: 0.0001,
      baselineAvgCostUsd: 0.0002,
      candidateLatencyMs: 200,
      approvedBy: 'admin-user',
    });
    expect(promo.passedQualityGate).toBe(false);
    expect(promo.promoted).toBe(false);
  });
});
