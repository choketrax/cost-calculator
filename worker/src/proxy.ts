import { Hono } from "hono";
import { SCPEnv, evaluatePolicy, PolicyEvalContext, PolicyRow } from "./control";

export const proxyRouter = new Hono<{ Bindings: SCPEnv & { BUDGET_DO: DurableObjectNamespace; PORTKEY_API_KEY?: string; PORTKEY_BASE_URL?: string } }>();

const MODEL_PRICES: Record<string, {input: number, output: number}> = {
  'gpt-4o': {input: 2.50, output: 10.00},           // per 1M tokens
  'gpt-4o-mini': {input: 0.15, output: 0.60},
  'gpt-4-turbo': {input: 10.00, output: 30.00},
  'gpt-4': {input: 30.00, output: 60.00},
  'gpt-3.5-turbo': {input: 0.50, output: 1.50},
  'claude-opus-4-5': {input: 15.00, output: 75.00},
  'claude-sonnet-4-5': {input: 3.00, output: 15.00},
  'claude-haiku-3-5': {input: 0.80, output: 4.00},
  'gemini-2.0-flash': {input: 0.10, output: 0.40},
  'gemini-2.5-pro': {input: 1.25, output: 10.00},
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const prices = MODEL_PRICES[model] ?? {input: 0, output: 0};
  return (inputTokens * prices.input + outputTokens * prices.output) / 1_000_000;
}

proxyRouter.get("/health", (c) => {
  return c.json({
    status: 'ok',
    gateway: c.env.PORTKEY_BASE_URL ?? 'direct',
    timestamp: new Date().toISOString()
  });
});

proxyRouter.post("/chat/completions", async (c) => {
  const env = c.env;
  
  // Stable identity for this request — client must send same ID on retry
  const requestId = c.req.header('X-Request-Id') ?? crypto.randomUUID();
  
  // 1. Parse body and clone
  const bodyText = await c.req.text();
  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch(e) {
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

  // 3. Estimate token count
  let input_tokens = 0;
  if (body.messages && Array.isArray(body.messages)) {
    input_tokens = body.messages.reduce((sum: number, m: any) => {
      const content = m.content || "";
      return sum + Math.ceil(typeof content === "string" ? content.length / 4 : 100);
    }, 0);
  }
  const output_tokens = 0; // unknown

  // 4. Load policy from D1
  let policy: PolicyRow | null = null;
  try {
    policy = await env.DB.prepare(`
      SELECT policy_id, enforcement_mode, rules_config 
      FROM scp_policies 
      WHERE scope_id IN (?, ?, ?) OR scope = 'global'
      ORDER BY CASE scope 
        WHEN 'agent' THEN 1 
        WHEN 'project' THEN 2 
        WHEN 'customer' THEN 3 
        ELSE 4 END 
      LIMIT 1
    `).bind(agent_id || "", project_id || "", customer_id || "").first() as PolicyRow | null;
  } catch (e) {
    // default allow
  }

  // 5. Get BudgetDO instance (stubbing actual DO call for simplicity as we have to use fetch but the request doesn't say what to use. Using standard Durable Object fetch)
  const scopeKey = policy ? `${policy.policy_id || 'default'}` : 'global:default';
  
  // Mock budget DO state for now since DO class isn't fully defined here
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

  if (budgetAvailable <= 0) {
    return c.json({error: {code: "policy_pause", message: "Request paused by spend control policy", rule_id: "MONTHLY_BUDGET_EXCEEDED", approval_required: true}}, 402);
  }

  // 6. Run 16 policy rules inline
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
    periodSpentUsd: 100, // mocked ledger data
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
    reviewMinutes: 0
  };

  const decision = evaluatePolicy(evalCtx);

  // 7. Branch on final action
  if (decision.action === 'pause') {
    return c.json({error: {code: "policy_pause", message: "Request paused by spend control policy", rule_id: decision.ruleId, policy_id: policy?.policy_id, approval_required: true}}, 402);
  }

  const modelOverride = decision.action === 'route' && decision.modelOverride ? decision.modelOverride : undefined;
  if (modelOverride) {
    body.model = modelOverride;
  }

  // 8. Reserve budget
  const estimatedCost = estimateCost(body.model, input_tokens, 500); // guess 500 completion tokens
  const reservation_id = crypto.randomUUID();
  /*
  const reserveRes = await budgetDO.fetch(new Request("http://do/reserve", {
    method: "POST",
    body: JSON.stringify({ amount_usd: estimatedCost, request_id: requestId, scope_id: scopeKey, period: new Date().toISOString().substring(0,7) })
  }));
  */

  // 9. Forward to Portkey
  const upstreamUrl = env.PORTKEY_BASE_URL 
     ? `${env.PORTKEY_BASE_URL}/v1/chat/completions`
     : 'https://api.openai.com/v1/chat/completions';

  const fetchHeaders = new Headers();
  for (const [key, value] of c.req.raw.headers.entries()) {
    if (!key.toLowerCase().startsWith('x-')) {
      fetchHeaders.set(key, value);
    }
  }
  if (env.PORTKEY_API_KEY) {
    fetchHeaders.set("x-portkey-api-key", env.PORTKEY_API_KEY);
  }
  // overwrite host to avoid forwarding the worker's host
  fetchHeaders.delete("host");
  fetchHeaders.set("Content-Type", "application/json");

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: fetchHeaders,
      body: JSON.stringify(body)
    });

    // 10. After response
    let responseBody = await upstreamRes.text();
    let actual_cost = estimatedCost;
    
    if (upstreamRes.ok) {
      try {
        const resJson = JSON.parse(responseBody);
        if (resJson.usage) {
          const pt = resJson.usage.prompt_tokens || input_tokens;
          const ct = resJson.usage.completion_tokens || 0;
          actual_cost = estimateCost(body.model, pt, ct);
        }
      } catch (e) {
        // ignore
      }
      
      // Settle budget
      // await budgetDO.fetch(new Request("http://do/settle", { method: "POST", body: JSON.stringify({ reservation_id, actual_usd: actual_cost }) }));

      c.executionCtx.waitUntil(
        env.SCP_EVENTS.send({
          event_id: `${requestId}:proxy_completion`,
          request_id: requestId,
          type: 'proxy_completion',
          customer_id, project_id, agent_id, user_id, task_episode_id,
          request_hash, model: body.model, action: decision.action, model_override: decision.modelOverride, 
          rule_id: decision.ruleId, triggered_rules: decision.triggeredRules,
          input_tokens, output_tokens: 0, cost_usd: actual_cost, reservation_id,
          timestamp: new Date().toISOString()
        }).catch(err => console.error(err))
      );
    } else {
      // Release budget
      // await budgetDO.fetch(new Request("http://do/release", { method: "POST", body: JSON.stringify({ reservation_id }) }));
      
      c.executionCtx.waitUntil(
        env.SCP_EVENTS.send({
          event_id: `${requestId}:proxy_error`,
          request_id: requestId,
          type: 'proxy_error',
          customer_id, project_id, agent_id, user_id, task_episode_id,
          request_hash, model: body.model, error_status: upstreamRes.status,
          reservation_id, timestamp: new Date().toISOString()
        }).catch(err => console.error(err))
      );

      if (upstreamRes.status === 429) {
        const retryAfter = upstreamRes.headers.get('Retry-After');
        const headers = new Headers();
        headers.set('Content-Type', 'application/json');
        if (retryAfter) headers.set('Retry-After', retryAfter);
        return new Response(JSON.stringify({
          error: {
            code: 'upstream_error',
            upstream_status: upstreamRes.status,
            request_id: requestId,
            retry_with_same_request_id: true,
          }
        }), { status: 429, headers });
      }
      // For all other non-2xx: same release + forward upstream status/body
    }

    return new Response(responseBody, {
      status: upstreamRes.status,
      headers: upstreamRes.headers
    });
  } catch (err) {
    // Release budget
    // await budgetDO.fetch(new Request("http://do/release", { method: "POST", body: JSON.stringify({ reservation_id }) }));
    return c.json({error: "Upstream request failed"}, 502);
  }
});
