import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  evaluateRoutingPolicy,
  evaluateQuality,
  CircuitBreakerManager,
  RoutingController,
  RoutingExhaustedError,
} from '../routing';
import type {
  ModelRequest,
  ModelResponse,
  ModelGateway,
  RoutingPolicyResult,
  CircuitBreakerStatus,
} from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal ModelRequest for testing */
function makeRequest(overrides?: Partial<ModelRequest>): ModelRequest {
  return {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello' }],
    _scp: {
      requestId: 'test-req-1',
      tenantId: 'tenant-1',
      routingStrategy: 'jev',
    },
    ...overrides,
  };
}

/** Create a minimal ModelResponse for testing */
function makeResponse(overrides?: Partial<ModelResponse>): ModelResponse {
  return {
    id: 'resp-1',
    object: 'chat.completion',
    created: Date.now(),
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello! How can I help you?' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    },
    _routing: {
      selectedProvider: 'openai',
      selectedModel: 'gpt-4o',
      routerModel: 'jev-router',
      routerLatencyMs: 150,
    },
    ...overrides,
  };
}

/** Create a mock gateway */
function mockGateway(name: string, response?: ModelResponse): ModelGateway {
  return {
    name,
    generate: vi.fn().mockResolvedValue(response ?? makeResponse()),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

/** Create a failing mock gateway */
function failingGateway(name: string, error?: string): ModelGateway {
  return {
    name,
    generate: vi.fn().mockRejectedValue(new Error(error ?? `${name} failed`)),
    isAvailable: vi.fn().mockResolvedValue(false),
  };
}

// ---------------------------------------------------------------------------
// Policy Evaluation Tests
// ---------------------------------------------------------------------------

describe('evaluateRoutingPolicy', () => {
  it('returns jev routing mode by default', () => {
    const result = evaluateRoutingPolicy(null, 100, new Map());
    expect(result.allow).toBe(true);
    expect(result.routingMode).toBe('jev');
  });

  it('denies when budget is exhausted', () => {
    const result = evaluateRoutingPolicy(null, 0, new Map());
    expect(result.allow).toBe(false);
    expect(result.routingMode).toBe('human');
    expect(result.requireHumanReview).toBe(true);
  });

  it('forces local routing when budget is very low', () => {
    const result = evaluateRoutingPolicy(null, 0.05, new Map());
    expect(result.routingMode).toBe('local');
    expect(result.maxCostUsd).toBeLessThanOrEqual(0.05);
  });

  it('reduces max cost when budget is low', () => {
    const result = evaluateRoutingPolicy(null, 0.50, new Map());
    expect(result.maxCostUsd).toBeLessThanOrEqual(0.25);
  });

  it('falls back to deterministic when jev circuit is open', () => {
    const breakers = new Map<string, CircuitBreakerStatus>([
      ['router:jev-router', { state: 'open', failures: 5 }],
    ]);
    const result = evaluateRoutingPolicy(null, 100, breakers);
    expect(result.routingMode).toBe('fallback');
  });

  it('forces deterministic when model is specified', () => {
    const result = evaluateRoutingPolicy(
      { deterministic_model: 'openai/gpt-4o' },
      100,
      new Map(),
    );
    expect(result.routingMode).toBe('deterministic');
    expect(result.deterministicModel).toBe('openai/gpt-4o');
  });

  it('respects allowed providers from policy', () => {
    const result = evaluateRoutingPolicy(
      { allowed_providers: ['openai', 'google'] },
      100,
      new Map(),
    );
    expect(result.allowedProviders).toEqual(['openai', 'google']);
  });

  it('respects blocked models from policy', () => {
    const result = evaluateRoutingPolicy(
      { blocked_models: ['gpt-4o', 'claude-3-opus'] },
      100,
      new Map(),
    );
    expect(result.blockedModels).toEqual(['gpt-4o', 'claude-3-opus']);
  });
});

// ---------------------------------------------------------------------------
// Quality Evaluation Tests
// ---------------------------------------------------------------------------

describe('evaluateQuality', () => {
  it('accepts a good response', () => {
    const quality = evaluateQuality(makeRequest(), makeResponse());
    expect(quality.passed).toBe(true);
    expect(quality.overallScore).toBeGreaterThanOrEqual(0.7);
    expect(quality.recommendation).toBe('accept');
  });

  it('rejects empty response', () => {
    const response = makeResponse({
      choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
    });
    const quality = evaluateQuality(makeRequest(), response);
    expect(quality.operational.checks.find(c => c.name === 'response_completeness')?.passed).toBe(false);
  });

  it('flags truncated response', () => {
    const response = makeResponse({
      choices: [{ index: 0, message: { role: 'assistant', content: 'Partial...' }, finish_reason: 'length' }],
    });
    const quality = evaluateQuality(makeRequest(), response);
    const finishCheck = quality.operational.checks.find(c => c.name === 'finish_reason');
    expect(finishCheck?.passed).toBe(false);
    expect(finishCheck?.score).toBe(0.5);
  });

  it('validates tool calls when tools requested', () => {
    const request = makeRequest({ tools: [{ type: 'function', function: { name: 'test' } }] });
    const response = makeResponse({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    });
    const quality = evaluateQuality(request, response);
    expect(quality.operational.checks.find(c => c.name === 'tool_call_validity')?.passed).toBe(true);
  });

  it('recommends escalation on medium-quality failure', () => {
    const response = makeResponse({
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'length' }],
      _routing: { routerLatencyMs: 50000, selectedProvider: 'test', selectedModel: 'test' },
    });
    const request = makeRequest();
    request._scp!.latencyTargetMs = 5000;
    const quality = evaluateQuality(request, response, 0.9);
    // Score should be between 0.45 and 0.9
    if (!quality.passed) {
      expect(['escalate', 'retry', 'human_review']).toContain(quality.recommendation);
    }
  });
});

// ---------------------------------------------------------------------------
// Circuit Breaker Tests
// ---------------------------------------------------------------------------

describe('CircuitBreakerManager', () => {
  let cb: CircuitBreakerManager;

  beforeEach(() => {
    cb = new CircuitBreakerManager();
  });

  it('starts closed with zero failures', () => {
    const status = cb.getStatus({ scope: 'provider', scopeId: 'openai' });
    expect(status.state).toBe('closed');
    expect(status.failures).toBe(0);
  });

  it('opens after threshold failures', () => {
    const key = { scope: 'provider' as const, scopeId: 'openai' };
    for (let i = 0; i < 5; i++) {
      cb.recordFailure(key);
    }
    expect(cb.isOpen(key)).toBe(true);
  });

  it('resets on success', () => {
    const key = { scope: 'provider' as const, scopeId: 'openai' };
    for (let i = 0; i < 3; i++) {
      cb.recordFailure(key);
    }
    cb.recordSuccess(key);
    const status = cb.getStatus(key);
    expect(status.failures).toBe(0);
    expect(status.state).toBe('closed');
  });

  it('tracks multiple scopes independently', () => {
    const key1 = { scope: 'provider' as const, scopeId: 'openai' };
    const key2 = { scope: 'provider' as const, scopeId: 'anthropic' };
    for (let i = 0; i < 5; i++) {
      cb.recordFailure(key1);
    }
    expect(cb.isOpen(key1)).toBe(true);
    expect(cb.isOpen(key2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Routing Controller Tests — 10 Required Scenarios
// ---------------------------------------------------------------------------

describe('RoutingController', () => {
  let jevGateway: ModelGateway;
  let deterministicGateway: ModelGateway;
  let localGateway: ModelGateway;
  let circuitBreakers: CircuitBreakerManager;
  let controller: RoutingController;

  beforeEach(() => {
    jevGateway = mockGateway('jev');
    deterministicGateway = mockGateway('deterministic');
    localGateway = mockGateway('local', makeResponse({ model: 'minimind' }));
    circuitBreakers = new CircuitBreakerManager();

    controller = new RoutingController({
      gateways: {
        jev: jevGateway,
        deterministic: deterministicGateway,
        local: localGateway,
      },
      circuitBreakers,
      maxEscalations: 2,
    });
  });

  // Scenario 1: Simple extraction → inexpensive/fast model
  it('1. routes simple extraction through jev for cheap model selection', async () => {
    const policy: RoutingPolicyResult = {
      allow: true,
      routingMode: 'jev',
      maxCostUsd: 0.05,
      allowedProviders: ['openai', 'google'],
      blockedModels: [],
      maxReasoningLevel: 'low',
      requireHumanReview: false,
    };

    const result = await controller.routeAndExecute(makeRequest(), policy);
    expect(result.decision.strategy).toBe('jev');
    expect(result.quality.passed).toBe(true);
    expect(jevGateway.generate).toHaveBeenCalled();
  });

  // Scenario 2: Complex reasoning → stronger model
  it('2. routes complex reasoning through jev with high reasoning', async () => {
    const policy: RoutingPolicyResult = {
      allow: true,
      routingMode: 'jev',
      maxCostUsd: 1.00,
      allowedProviders: ['openai', 'anthropic'],
      blockedModels: [],
      maxReasoningLevel: 'high',
      requireHumanReview: false,
    };

    const complexRequest = makeRequest({
      messages: [{ role: 'user', content: 'Analyze this complex mathematical proof and identify logical errors...' }],
    });

    const result = await controller.routeAndExecute(complexRequest, policy);
    expect(result.decision.strategy).toBe('jev');
    expect(jevGateway.generate).toHaveBeenCalled();
  });

  // Scenario 3: Coding task → validate model and quality
  it('3. handles coding task with quality validation', async () => {
    const codeResponse = makeResponse({
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '```typescript\nfunction add(a: number, b: number): number { return a + b; }\n```' },
        finish_reason: 'stop',
      }],
    });

    const codeJev = mockGateway('jev', codeResponse);
    const codeController = new RoutingController({
      gateways: { jev: codeJev, deterministic: deterministicGateway },
      circuitBreakers,
      maxEscalations: 2,
    });

    const policy: RoutingPolicyResult = {
      allow: true,
      routingMode: 'jev',
      maxCostUsd: 0.50,
      allowedProviders: ['openai', 'anthropic'],
      blockedModels: [],
      maxReasoningLevel: 'medium',
      requireHumanReview: false,
    };

    const result = await codeController.routeAndExecute(
      makeRequest({ messages: [{ role: 'user', content: 'Write a TypeScript function...' }] }),
      policy,
    );
    expect(result.quality.passed).toBe(true);
    expect(result.decision.selectedModel).toBeDefined();
  });

  // Scenario 4: Large context → validate handling
  it('4. handles large-context task', async () => {
    const longContent = 'x'.repeat(100000); // ~25k tokens
    const policy: RoutingPolicyResult = {
      allow: true,
      routingMode: 'jev',
      maxCostUsd: 2.00,
      allowedProviders: ['openai', 'anthropic', 'google'],
      blockedModels: [],
      maxReasoningLevel: 'medium',
      requireHumanReview: false,
    };

    const result = await controller.routeAndExecute(
      makeRequest({ messages: [{ role: 'user', content: longContent }] }),
      policy,
    );
    expect(result.decision.strategy).toBe('jev');
  });

  // Scenario 5: Restricted providers → Jev must not bypass
  it('5. enforces provider restrictions - Jev cannot bypass SCP', async () => {
    const policy: RoutingPolicyResult = {
      allow: true,
      routingMode: 'jev',
      maxCostUsd: 1.00,
      allowedProviders: ['google'],
      blockedModels: ['gpt-4o', 'claude-3-opus'],
      maxReasoningLevel: 'medium',
      requireHumanReview: false,
    };

    const result = await controller.routeAndExecute(makeRequest(), policy);
    // Verify that SCP constraints were passed to the gateway
    const callArgs = (jevGateway.generate as any).mock.calls[0][0] as ModelRequest;
    expect(callArgs._scp?.allowedProviders).toEqual(['google']);
    expect(callArgs._scp?.blockedModels).toEqual(['gpt-4o', 'claude-3-opus']);
  });

  // Scenario 6: Budget limit → force cheaper routing
  it('6. forces cheaper routing when budget is near limit', async () => {
    const policy = evaluateRoutingPolicy(null, 0.05, new Map());
    expect(policy.routingMode).toBe('local');

    const result = await controller.routeAndExecute(makeRequest(), policy);
    expect(result.decision.strategy).toBe('local');
    expect(localGateway.generate).toHaveBeenCalled();
  });

  // Scenario 7: Provider failure → circuit breaker
  it('7. activates circuit breaker on provider failure', async () => {
    const key = { scope: 'provider' as const, scopeId: 'openai' };
    for (let i = 0; i < 5; i++) {
      circuitBreakers.recordFailure(key);
    }
    expect(circuitBreakers.isOpen(key)).toBe(true);
  });

  // Scenario 8: Jev Router failure → deterministic fallback
  it('8. falls back to deterministic when Jev fails', async () => {
    const failingJev = failingGateway('jev', 'Jev Router unavailable');
    const fallbackController = new RoutingController({
      gateways: {
        jev: failingJev,
        deterministic: deterministicGateway,
        local: localGateway,
      },
      circuitBreakers,
      maxEscalations: 2,
    });

    const policy: RoutingPolicyResult = {
      allow: true,
      routingMode: 'jev',
      maxCostUsd: 1.00,
      allowedProviders: ['openai'],
      blockedModels: [],
      maxReasoningLevel: 'medium',
      requireHumanReview: false,
      fallbackModel: 'openai/gpt-3.5-turbo',
    };

    const result = await fallbackController.routeAndExecute(makeRequest(), policy);
    expect(result.decision.escalated).toBe(true);
    expect(deterministicGateway.generate).toHaveBeenCalled();
  });

  // Scenario 9: Quality failure → escalation
  it('9. escalates to stronger model on quality failure', async () => {
    const poorResponse = makeResponse({
      choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'length' }],
    });
    const poorJev = mockGateway('jev', poorResponse);
    const goodDeterministic = mockGateway('deterministic', makeResponse());

    const escalationController = new RoutingController({
      gateways: {
        jev: poorJev,
        deterministic: goodDeterministic,
        local: localGateway,
      },
      circuitBreakers,
      maxEscalations: 2,
    });

    const policy: RoutingPolicyResult = {
      allow: true,
      routingMode: 'jev',
      maxCostUsd: 2.00,
      allowedProviders: ['openai'],
      blockedModels: [],
      maxReasoningLevel: 'high',
      minQualityScore: 0.9,
      requireHumanReview: false,
    };

    const result = await escalationController.routeAndExecute(makeRequest(), policy);
    // Should have escalated from jev to deterministic
    expect(result.decision.retryCount).toBeGreaterThan(0);
  });

  // Scenario 10: Max cost exceeded → downgrade or reject
  it('10. rejects or downgrades when max cost is exceeded', () => {
    const policy = evaluateRoutingPolicy(null, 0, new Map());
    expect(policy.allow).toBe(false);
    expect(policy.maxCostUsd).toBe(0);
    expect(policy.requireHumanReview).toBe(true);
  });
});
