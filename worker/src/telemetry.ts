import { RoutingDecision, RoutingTelemetry } from './types';

// ---------------------------------------------------------------------------
// Lightweight OTel-style Span Recording for Cloudflare Workers
// ---------------------------------------------------------------------------

/** A lightweight span representation for SCP routing telemetry */
export interface SCPSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, string | number | boolean>;
  status: 'ok' | 'error' | 'unset';
}

/** Creates a new trace ID */
function newTraceId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** Creates a new span ID */
function newSpanId(): string {
  return crypto.randomUUID().replace(/-/g, '').substring(0, 16);
}

/**
 * SCPTracer — lightweight span collector for routing telemetry.
 * Collects spans during a request lifecycle and flushes them to D1 or queue.
 */
export class SCPTracer {
  private readonly traceId: string;
  private readonly spans: SCPSpan[] = [];

  constructor(traceId?: string) {
    this.traceId = traceId ?? newTraceId();
  }

  /** Start a new span */
  startSpan(name: string, parentSpanId?: string): SCPSpan {
    const span: SCPSpan = {
      traceId: this.traceId,
      spanId: newSpanId(),
      parentSpanId,
      name,
      startTime: Date.now(),
      attributes: {},
      status: 'unset',
    };
    this.spans.push(span);
    return span;
  }

  /** End a span */
  endSpan(span: SCPSpan, status: 'ok' | 'error' = 'ok'): void {
    span.endTime = Date.now();
    span.status = status;
  }

  /** Record routing decision as span attributes */
  recordRoutingDecision(span: SCPSpan, decision: RoutingDecision): void {
    span.attributes['ai.tenant_id'] = decision.tenantId;
    if (decision.agentId) span.attributes['ai.agent_id'] = decision.agentId;
    span.attributes['ai.routing_strategy'] = decision.strategy;
    if (decision.routerModel) span.attributes['ai.router'] = decision.routerModel;
    if (decision.selectedProvider) span.attributes['ai.provider'] = decision.selectedProvider;
    if (decision.selectedModel) span.attributes['ai.model'] = decision.selectedModel;
    if (decision.actualCost !== undefined) span.attributes['ai.cost_usd'] = decision.actualCost;
    if (decision.qualityScore !== undefined) span.attributes['ai.quality_score'] = decision.qualityScore;
    span.attributes['ai.escalated'] = decision.escalated;
    span.attributes['ai.retry_count'] = decision.retryCount;
    span.attributes['ai.human_review'] = decision.humanReview;
  }

  /** Get all collected spans */
  getSpans(): ReadonlyArray<SCPSpan> {
    return this.spans;
  }

  /** Get the trace ID */
  getTraceId(): string {
    return this.traceId;
  }
}

// ---------------------------------------------------------------------------
// Telemetry Recording to D1
// ---------------------------------------------------------------------------

/**
 * Record a routing decision to the scp_routing_log table in D1.
 * This is the primary audit trail for all routing decisions.
 */
export async function recordRoutingDecision(
  db: D1Database,
  decision: RoutingDecision,
): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO scp_routing_log (
        request_id, tenant_id, agent_id, workflow_id,
        strategy, router_model, selected_provider, selected_model,
        estimated_cost_usd, actual_cost_usd,
        quality_score, latency_ms,
        input_tokens, output_tokens,
        retry_count, escalated, human_review,
        policy_action, circuit_breaker_state,
        reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      decision.requestId,
      decision.tenantId,
      decision.agentId ?? null,
      decision.workflowId ?? null,
      decision.strategy,
      decision.routerModel ?? null,
      decision.selectedProvider ?? null,
      decision.selectedModel ?? null,
      decision.estimatedCost ?? null,
      decision.actualCost ?? null,
      decision.qualityScore ?? null,
      decision.latencyMs ?? null,
      decision.inputTokens ?? null,
      decision.outputTokens ?? null,
      decision.retryCount,
      decision.escalated ? 1 : 0,
      decision.humanReview ? 1 : 0,
      decision.policyAction ?? null,
      decision.circuitBreakerState ?? null,
      decision.reason ?? null,
      decision.createdAt,
    ).run();
  } catch (err) {
    // Log but don't fail the request over telemetry
    console.error('[SCP Telemetry] Failed to record routing decision:', err);
  }
}

/**
 * Build a RoutingTelemetry record from a RoutingDecision.
 * Used for queue-based async telemetry processing.
 */
export function buildTelemetryFromDecision(decision: RoutingDecision): RoutingTelemetry {
  return {
    requestId: decision.requestId,
    tenantId: decision.tenantId,
    agentId: decision.agentId,
    workflowId: decision.workflowId,
    routingStrategy: decision.strategy,
    routerModel: decision.routerModel,
    selectedModel: decision.selectedModel,
    selectedProvider: decision.selectedProvider,
    inputTokens: decision.inputTokens,
    outputTokens: decision.outputTokens,
    estimatedCost: decision.estimatedCost,
    actualCost: decision.actualCost,
    latencyMs: decision.latencyMs,
    qualityScore: decision.qualityScore,
    retryCount: decision.retryCount,
    escalated: decision.escalated,
    humanReview: decision.humanReview,
    policyAction: decision.policyAction,
    circuitBreakerState: decision.circuitBreakerState,
    timestamp: decision.createdAt,
  };
}
