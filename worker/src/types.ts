/**
 * Shared types for the SCP (Spend Control Pack) Worker and Jev Router integration.
 */

// === Model Gateway Types ===

/** Request to the model gateway abstraction */
export interface ModelRequest {
  model: string;
  messages: Array<{ role: string; content: string | unknown }>;
  temperature?: number;
  max_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: unknown;
  stream?: boolean;
  // SCP metadata (not sent upstream)
  _scp?: {
    requestId: string;
    tenantId: string;
    agentId?: string;
    userId?: string;
    workflowId?: string;
    routingStrategy: RoutingStrategy;
    maxCostUsd?: number;
    allowedProviders?: string[];
    blockedModels?: string[];
    maxReasoningLevel?: ReasoningLevel;
    latencyTargetMs?: number;
    minQualityScore?: number;
  };
}

/** Response from the model gateway */
export interface ModelResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string | null; tool_calls?: unknown[] };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  // Jev/OpenRouter extended metadata
  _routing?: {
    selectedProvider?: string;
    selectedModel?: string;
    routerModel?: string;
    routerLatencyMs?: number;
  };
}

/** Gateway abstraction — all model providers implement this */
export interface ModelGateway {
  readonly name: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
  isAvailable(): Promise<boolean>;
}

// === Routing Types ===

export type RoutingStrategy = 
  | "deterministic" 
  | "jev" 
  | "local" 
  | "fallback" 
  | "human";

export type ReasoningLevel = "none" | "low" | "medium" | "high";

/** Result of SCP policy evaluation for routing */
export interface RoutingPolicyResult {
  allow: boolean;
  routingMode: RoutingStrategy;
  maxCostUsd: number;
  allowedProviders: string[];
  blockedModels: string[];
  maxReasoningLevel: ReasoningLevel;
  deterministicModel?: string;
  latencyTargetMs?: number;
  minQualityScore?: number;
  requireHumanReview: boolean;
  
  // Policy-configured fallback
  fallbackModel?: string;
  fallbackProvider?: string;
  fallbackMaxCostUsd?: number;
  fallbackReasoningLevel?: ReasoningLevel;
  
  reason?: string;
}

/** Recorded routing decision for telemetry */
export interface RoutingDecision {
  requestId: string;
  tenantId: string;
  agentId?: string;
  workflowId?: string;
  strategy: RoutingStrategy;
  routerModel?: string;
  selectedProvider?: string;
  selectedModel?: string;
  estimatedCost?: number;
  actualCost?: number;
  qualityScore?: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  retryCount: number;
  escalated: boolean;
  humanReview: boolean;
  policyAction?: string;
  circuitBreakerState?: string;
  reason?: string;
  createdAt: string;
}

// === Quality Types ===

/** Tripartite Quality Evaluation */
export interface QualityEvaluation {
  overallScore: number;           // 0.0 - 1.0 (lowest of the three)
  passed: boolean;
  
  operational: QualityDimension;  // e.g. latency, format, finish reason
  semantic: QualityDimension;     // e.g. correctness, grounding, fulfills task
  policy: QualityDimension;       // e.g. PII, allowed sources
  
  recommendation: "accept" | "retry" | "escalate" | "human_review";
}

export interface QualityDimension {
  score: number;
  passed: boolean;
  checks: QualityCheck[];
}

export interface QualityCheck {
  name: string;
  passed: boolean;
  score?: number;
  detail?: string;
}

// === Circuit Breaker Types ===

export type CircuitState = "closed" | "open" | "half_open";

/** Granular scopes for circuit breaking */
export interface CircuitBreakerKey {
  scope: "provider" | "model" | "router" | "tenant" | "workflow" | "agent" | "strategy";
  scopeId: string;
}

export interface CircuitBreakerStatus {
  state: CircuitState;
  failures: number;
  lastFailure?: string;
  openedAt?: string;
  cooldownUntil?: string;
}

// === Telemetry Types ===

/** Full telemetry record for a routing event */
export interface RoutingTelemetry {
  requestId: string;
  tenantId: string;
  agentId?: string;
  workflowId?: string;
  routingStrategy: RoutingStrategy;
  routerModel?: string;
  selectedModel?: string;
  selectedProvider?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
  actualCost?: number;
  latencyMs?: number;
  qualityScore?: number;
  retryCount: number;
  escalated: boolean;
  humanReview: boolean;
  policyAction?: string;
  circuitBreakerState?: string;
  timestamp: string;
}
