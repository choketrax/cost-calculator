import { Hono } from "hono";

// Spend Control Pack — Control Authority
// The Worker is the financial decision-maker. Portkey (or any other gateway)
// is an execution adapter called AFTER the policy decision, not the reverse.
// Architecture: Application → /proxy/v1/* (this Worker) → Portkey → Provider

export interface BaseEnv {
  AUDITOR_CONTAINER: DurableObjectNamespace;
  DB: D1Database;
  AUDIT_STORAGE: R2Bucket;
  API_KEY: string;
  APP_ENV: string;
}

export interface SCPEnv extends BaseEnv {
  SCP_EVENTS: Queue;
  SLACK_WEBHOOK_URL?: string;
  EMAIL_FROM?: string;
  PORTKEY_API_KEY?: string;
}

export interface PolicyRow {
  policy_id: string;
  enforcement_mode: string;
  rules_config: string;
}

export interface PolicyEvalContext {
  policy: PolicyRow | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  retryCount: number;
  toolFailureCount: number;
  customerId?: string;
  projectId?: string;
  agentId?: string;
  userId?: string;
  requestHourUtc: number;
  requestHash?: string;
  // Ledger data
  periodSpentUsd: number;
  dailySpentUsd: number;
  rolling7dAvg: number;
  baseline30d: number;
  consecutiveFailures: number;
  successRate: number;
  cacheHitRate: number;
  recentHashes: string[];
  userTodayUsd: number;
  userAvgUsd: number;
  revenueUsd: number;
  costUsd: number;
  reviewMinutes: number;
}

export interface PolicyEvalResult {
  action: "allow" | "alert" | "route" | "pause";
  modelOverride?: string;
  ruleId?: string;
  triggeredRules: string[];
  reason: string;
  enforcementMode: "observe" | "enforce";
}

type ActionPriority = "allow" | "alert" | "route" | "pause";
const ACTION_WEIGHTS: Record<ActionPriority, number> = {
  allow: 0,
  alert: 1,
  route: 2,
  pause: 3,
};

export const controlRouter = new Hono<{ Bindings: SCPEnv }>();

const rules = [
  (ctx: PolicyEvalContext): { id: string; action: ActionPriority } | null => {
    // 1. MONTHLY_BUDGET_EXCEEDED
    const budget = 1000;
    const blockPct = 100;
    return ctx.periodSpentUsd >= budget * (blockPct / 100)
      ? { id: "MONTHLY_BUDGET_EXCEEDED", action: "pause" }
      : null;
  },
  (ctx: PolicyEvalContext): { id: string; action: ActionPriority } | null => {
    // 2. MONTHLY_BUDGET_WARNING
    const budget = 1000;
    const warnPct = 75;
    return ctx.periodSpentUsd >= budget * (warnPct / 100)
      ? { id: "MONTHLY_BUDGET_WARNING", action: "alert" }
      : null;
  },
  (ctx: PolicyEvalContext): { id: string; action: ActionPriority } | null =>
    ctx.dailySpentUsd > ctx.rolling7dAvg * 3.0 && ctx.dailySpentUsd > 10
      ? { id: "DAILY_SPIKE", action: "alert" }
      : null,
  (ctx: PolicyEvalContext): { id: string; action: ActionPriority } | null =>
    // 4. COST_PER_TASK_INCREASED
    false ? { id: "COST_PER_TASK_INCREASED", action: "alert" } : null,
  (ctx: PolicyEvalContext): { id: string; action: ActionPriority } | null =>
    ctx.inputTokens > 32000
      ? { id: "EXCESSIVE_CONTEXT", action: "alert" }
      : null,
  (ctx: PolicyEvalContext): { id: string; action: ActionPriority } | null =>
    ctx.retryCount > 3 ? { id: "TOO_MANY_RETRIES", action: "route" } : null,
  (ctx: PolicyEvalContext): { id: string; action: ActionPriority } | null =>
    ctx.toolFailureCount >= 3
      ? { id: "REPEATED_TOOL_FAILURES", action: "pause" }
      : null,
  (ctx: PolicyEvalContext): { id: string; action: ActionPriority } | null => {
    const isExpensive = ctx.model.includes("gpt-4") || ctx.model.includes("claude-3-opus");
    const isSimple = ctx.outputTokens < 500 && ctx.inputTokens < 2000;
    return isExpensive && isSimple
      ? { id: "EXPENSIVE_MODEL_SIMPLE_TASK", action: "route" }
      : null;
  },
  (ctx: PolicyEvalContext): { id: string; action: ActionPriority } | null =>
    !ctx.customerId && !ctx.projectId
      ? { id: "MISSING_ATTRIBUTION", action: "alert" }
      : null,
  (ctx: PolicyEvalContext): { id: string; action: ActionPriority } | null =>
    ctx.successRate < 0.9 ? { id: "LOW_SUCCESS_RATE", action: "alert" } : null,
  (ctx: PolicyEvalContext): { id: string; action: ActionPriority } | null =>
    ctx.revenueUsd < ctx.costUsd && ctx.revenueUsd > 0
      ? { id: "NEGATIVE_CLIENT_MARGIN", action: "alert" }
      : null,
  (ctx: PolicyEvalContext): { id: string; action: ActionPriority } | null =>
    ctx.userTodayUsd > ctx.userAvgUsd * 5 && ctx.userTodayUsd > 5
      ? { id: "UNUSUAL_USER_CONSUMPTION", action: "alert" }
      : null,
  (ctx: PolicyEvalContext): { id: string; action: ActionPriority } | null =>
    ctx.cacheHitRate < 0.5 && ctx.inputTokens > 5000
      ? { id: "LOW_CACHE_HIT_RATE", action: "alert" }
      : null,
  (ctx: PolicyEvalContext): { id: string; action: ActionPriority } | null =>
    ctx.requestHash && ctx.recentHashes.includes(ctx.requestHash)
      ? { id: "DUPLICATE_REQUEST", action: "route" }
      : null,
  (ctx: PolicyEvalContext): { id: string; action: ActionPriority } | null =>
    ctx.reviewMinutes > 60
      ? { id: "EXCESSIVE_HUMAN_REVIEW", action: "alert" }
      : null,
  (ctx: PolicyEvalContext): { id: string; action: ActionPriority } | null =>
    null,
];

export function evaluatePolicy(ctx: PolicyEvalContext): PolicyEvalResult {
  const enforcementMode =
    (ctx.policy?.enforcement_mode as "observe" | "enforce") || "enforce";
  const triggeredRules: string[] = [];
  let maxAction: ActionPriority = "allow";
  let primaryRuleId: string | undefined;

  for (const rule of rules) {
    const result = rule(ctx);
    if (result) {
      triggeredRules.push(result.id);
      if (ACTION_WEIGHTS[result.action] > ACTION_WEIGHTS[maxAction]) {
        maxAction = result.action;
        primaryRuleId = result.id;
      }
    }
  }

  if (
    enforcementMode === "observe" &&
    ACTION_WEIGHTS[maxAction] > ACTION_WEIGHTS["alert"]
  ) {
    maxAction = "alert";
  }

  const modelOverride = maxAction === "route" ? "gpt-3.5-turbo" : undefined;

  return {
    action: maxAction,
    modelOverride,
    ruleId: primaryRuleId,
    triggeredRules,
    reason: `Evaluated ${triggeredRules.length} rules, primary rule: ${primaryRuleId || "none"}`,
    enforcementMode,
  };
}

controlRouter.get("/circuit/:scope/:scope_id", async (c) => {
  const { scope, scope_id } = c.req.param();
  const state = await c.env.DB.prepare(
    `
    SELECT state, open_reason, open_at, consecutive_failures, requires_approval 
    FROM scp_circuit_state 
    WHERE scope = ? AND scope_id = ?
  `,
  )
    .bind(scope, scope_id)
    .first();

  if (!state) {
    return c.json({
      scope,
      scope_id,
      state: "closed",
      consecutive_failures: 0,
      requires_approval: false,
    });
  }

  return c.json({
    scope,
    scope_id,
    ...state,
  });
});

controlRouter.post("/circuit/:scope/:scope_id/reset", async (c) => {
  const { scope, scope_id } = c.req.param();
  const body = await c.req.json().catch(() => ({}));

  const state = await c.env.DB.prepare(
    `SELECT requires_approval FROM scp_circuit_state WHERE scope = ? AND scope_id = ?`,
  )
    .bind(scope, scope_id)
    .first();

  if (state?.requires_approval && !body.approval_id) {
    return c.json(
      { error: "approval_id required to reset this circuit breaker" },
      403,
    );
  }

  await c.env.DB.prepare(
    `UPDATE scp_circuit_state SET state = 'closed', consecutive_failures = 0, open_reason = NULL, open_at = NULL WHERE scope = ? AND scope_id = ?`,
  )
    .bind(scope, scope_id)
    .run();

  return c.json({ success: true, message: "Circuit breaker reset to closed" });
});

controlRouter.get("/budget/:scope/:scope_id", async (c) => {
  const { scope, scope_id } = c.req.param();
  const period = new Date().toISOString().substring(0, 7);

  const budget = await c.env.DB.prepare(
    `SELECT budget_usd, spent_usd, warning_threshold_pct, block_threshold_pct 
     FROM scp_budget_ledger 
     WHERE scope = ? AND scope_id = ? AND period = ?`,
  )
    .bind(scope, scope_id, period)
    .first();

  if (!budget) {
    return c.json({ error: "Budget not found" }, 404);
  }

  const budgetUsd = budget.budget_usd as number;
  const spentUsd = budget.spent_usd as number;
  const consumptionPct = budgetUsd > 0 ? (spentUsd / budgetUsd) * 100 : 0;

  let status = "ok";
  if (consumptionPct >= (budget.block_threshold_pct as number))
    status = "exceeded";
  else if (consumptionPct >= 90) status = "critical";
  else if (consumptionPct >= (budget.warning_threshold_pct as number))
    status = "warning";

  return c.json({
    scope,
    scope_id,
    period,
    budget_usd: budgetUsd,
    spent_usd: spentUsd,
    consumption_pct: consumptionPct,
    warning_threshold_pct: budget.warning_threshold_pct,
    block_threshold_pct: budget.block_threshold_pct,
    status,
  });
});

controlRouter.post("/ledger", async (c) => {
  const env = c.env;
  const body = await c.req.json();
  const { cost_usd, customer_id, project_id, agent_id, action_taken, quality_score } = body;

  const scope = agent_id ? "agent" : project_id ? "project" : customer_id ? "customer" : "global";
  const scope_id = agent_id || project_id || customer_id || "global";
  const period = new Date().toISOString().substring(0, 7);

  await env.DB.prepare(
    `
    INSERT INTO scp_budget_ledger (scope, scope_id, period, spent_usd, budget_usd, warning_threshold_pct, block_threshold_pct)
    VALUES (?, ?, ?, ?, 1000, 75, 100)
    ON CONFLICT(scope, scope_id, period) DO UPDATE SET spent_usd = spent_usd + ?
  `,
  )
    .bind(scope, scope_id, period, cost_usd, cost_usd)
    .run();

  if (action_taken === "pause" || (quality_score !== undefined && quality_score < 0.5)) {
    await env.DB.prepare(
      `
      INSERT INTO scp_circuit_state (scope, scope_id, state, consecutive_failures, requires_approval)
      VALUES (?, ?, 'closed', 1, false)
      ON CONFLICT(scope, scope_id) DO UPDATE SET consecutive_failures = consecutive_failures + 1
    `,
    )
      .bind(scope, scope_id)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE scp_circuit_state SET consecutive_failures = 0 WHERE scope = ? AND scope_id = ?`,
    )
      .bind(scope, scope_id)
      .run();
  }

  return c.json({ success: true });
});
