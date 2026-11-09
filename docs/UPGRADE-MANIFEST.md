# AgentGateway Upgrade Manifest (Phase 0 Audit)

Branch: `feat/neuron-first-v2` (cut from a working tree with pre-existing uncommitted changes to
`schema.sql`, `worker/src/index.ts`, `worker/src/proxy.ts`, `wrangler.toml`; those are NOT part of this work).
Worker: `ai-cost-auditorv2`. Config: `wrangler.toml` (not jsonc).

## 1. Current architecture (verified from source)

| Concern | Existing module | Notes |
|---|---|---|
| Worker entry | `worker/src/index.ts` | Manual `pathname` dispatch; `X-API-Key` auth for `/internal/*` |
| Proxy | `worker/src/proxy.ts` | `POST /proxy/v1/chat/completions`, `GET /proxy/v1/health`; forwards to `https://api.openai.com/v1` (line ~297), optional Portkey |
| Control / SCP | `worker/src/control.ts` | `/control/v1/*`: circuit, budget, ledger, vault (BYOK) |
| Budgets | `worker/src/budget_do.ts` (`BudgetDO`) | Atomic budgets; has idempotency tests |
| Routing | `worker/src/routing.ts` | `evaluateRoutingPolicy`, `evaluateQuality`, `CircuitBreakerManager`, `RoutingController`, `RoutingExhaustedError` |
| Model gateways | `worker/src/gateways/` | `OpenRouterGateway`, `LocalGateway` (MiniMind/vLLM, `LOCAL_MODEL_URL`), `DeterministicGateway` implementing `ModelGateway` |
| Types | `worker/src/types.ts` | `ModelGateway`, `RoutingDecision`, `QualityEvaluation`, circuit types |
| Telemetry / alerts | `telemetry.ts`, `alerts.ts` | Cron `*/5 * * * *` |
| Idempotency | `idempotency.ts` | Reuse for tool/inference dedup |
| MCP | `agentgateway.yaml` | Open-source agentgateway proxy: MCP :3000 -> `mcp:8001/sse`; LLM :4000 (openai, anthropic). Runs via Docker/Render, outside Workers |

### Bindings (wrangler.toml)
`DB` (D1 `ai-cost-auditor-db`), `AUDIT_STORAGE` (R2 `ai-cost-auditor`), `BUDGET_DO`, `AUDITOR_CONTAINER`
(existing container, max 3, do not extend), `SCP_EVENTS` (queue producer+consumer), cron trigger.
**Missing:** `AI` (Workers AI), AI Gateway id var, KV/cache, research queue, rate-limit DO.

### SCP D1 tables (`schema_scp.sql`)
`scp_policies`, `scp_budget_ledger`, `scp_circuit_state`, `scp_routing_table`, `scp_approvals`,
`scp_policy_log`, `scp_usage_summary`. New tables must extend these, not replace them.

### Secrets/vars in use
`API_KEY`, `SLACK_WEBHOOK_URL`, `EMAIL_FROM`, `PORTKEY_API_KEY`, `PORTKEY_BASE_URL`,
`OPENROUTER_API_KEY`, `LOCAL_MODEL_URL`.
To add: `DEEPSEEK_API_KEY` (secret), `AI_GATEWAY_ID` (var).

## 2. Existing external-LLM consumers
- `proxy.ts` -> OpenAI direct (default path today; unchanged behavior must remain for existing clients).
- `gateways/openrouter.ts` -> OpenRouter (`typesafe/jev-router`).
- `agentgateway.yaml` -> openai/anthropic listeners on :4000 (outside Worker; bypasses Worker policy unless ExtAuthz is applied).
- Not yet audited: OpenViking repos, n8n, Paperclip, MiniMind callers (Phase 5).

## 3. Gaps vs. directive
1. No Workers AI adapter/binding, no Neuron metering.
2. No model registry (model IDs live in code/routing table).
3. No `web.search` / `web.fetch`, URL policy, research cache.
4. No MCP tool registry in the Worker (MCP target is an external SSE service).
5. Default route is external; directive requires Cloudflare-first behind a feature flag.
6. Auth is a shared `X-API-Key`; directive requires token-derived tenant. Need to inspect how tenant is resolved in `proxy.ts`/`control.ts` before building `identity.ts`.

### Security finding: tenant identity is client-asserted (existing behavior)
`proxy.ts:79-86,331` derives `tenantId` from caller-supplied `X-Customer-Id` / `X-Project-Id` headers, and
the OpenAI fallback forwards the caller's `Authorization` bearer upstream (`proxy.ts:298`). Any holder of the
shared key can claim any tenant. Policy: leave `/proxy/v1/*` behavior unchanged for compatibility, but all new
`/api/v1/*` routes and tools MUST resolve tenant from a server-verified credential (key -> tenant mapping in D1),
and must ignore `X-Customer-Id`. Migrating `/proxy/v1/*` to verified tenancy is a separate, flagged change.

## 4. Migration and rollback plan
- All new behavior behind flags in a `routing_flags` config (D1 + env default OFF): `ROUTING_MODE` (`legacy` | `cloudflare_first`), `WEB_TOOLS_ENABLED`, per-tenant overrides.
- Default stays `legacy`; existing `/proxy/v1/*` and `/control/v1/*` contracts unchanged. New routes are additive under `/api/v1/*`.
- D1 migrations are additive only (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN`), no drops.
- Rollout: single internal tenant -> canary percentage -> general. Rollback = flip flag to `legacy` (no deploy needed); code rollback = `wrangler rollback`.

## 5. Live-account checks (read-only) - RESULTS (2026-11-08)
- Auth: wrangler OAuth, account `56e8d68c2c46720b0d77df12d63da7e2` matches `wrangler.toml`.
- D1: `ai-cost-auditor-db` is the SCP DB (sibling DBs: workforce-control-plane, minimind-db, invoicehub-control-plane, mec-construction-db, underwrite-iq-staging).
- R2: `ai-cost-auditor` present. Integration candidates: `openviking-ragfs`, `minimind-specialist-factory`, `n8n-snapshots`.
- Queues: `scp-events` present (1 producer, 1 consumer). Others: `minimind-job-queue`, `telemetry-queue`, `audit-queue`. No research or DLQ queue for this Worker yet (to create).
- Last `ai-cost-auditorv2` deployment seen: 2026-10-17 (deployed state may differ from working tree).
- Workers AI catalog (`wrangler ai models`), directive candidates:

| Directive ID | Live catalog | Status |
|---|---|---|
| `@cf/ibm-granite/granite-4.0-h-micro` | present | available |
| `@cf/zai-org/glm-4.7-flash` | present | available |
| `@cf/google/gemma-4-26b-a4b` | **only as `@cf/google/gemma-4-26b-a4b-it`** | use `-it` ID |
| `@cf/deepseek-ai/deepseek-v4.1-flash-1017` | present | available |
| `@cf/zai-org/glm-5.3` | present | available |

  Catalog presence is not capability verification: function-calling, structured output, context window, and
  Neuron rates are still unverified and registry rows stay `enabled=0` until confirmed.
- NOT verified: AI Gateway existence/ID, Workers AI billing mode (standard vs prepaid credits; owner must confirm),
  `DEEPSEEK_API_KEY` availability, whether `/internal` and ExtAuthz cover the :4000 LLM listener.
