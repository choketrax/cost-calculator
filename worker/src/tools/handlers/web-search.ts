/**
 * `web.search` Tool Handler (Sections 5, 9, 10, 12)
 *
 * Orchestrates:
 * 1. Input validation (`validateWebSearchRequest`)
 * 2. Content policy & cache key generation (`buildSearchCacheKey`)
 * 3. Tenant-isolated cache lookup (returns immediately on hit without upstream request or billing)
 * 4. Atomic Spend Control Pack reservation (`web_search_usd`, $0.00075)
 * 5. Upstream DeepSeek Search invocation (`POST https://api.deepseek.com/v1/tools/search`)
 * 6. Untrusted web content sanitization (`PromptInjectionGuard`)
 * 7. Settlement or release of atomic reservation + `ToolMeter` recording
 */

import { validateWebSearchRequest, WebSearchResult, SearchResult } from '../schemas';
import { DeepSeekClient } from '../providers/deepseek-client';
import { PromptInjectionGuard } from '../security/prompt-injection';
import { ContentPolicyEnforcer } from '../security/content-policy';
import { ResearchCache } from '../../caching/research-cache';
import { buildSearchCacheKey } from '../../caching/cache-keys';
import { ToolMeter, DEEPSEEK_COST_PER_SUCCESS_USD } from '../../billing/tool-meter';
import { SpendControlAdapter, ReservationHandle } from '../../billing/spend-control-adapter';

export interface WebSearchHandlerContext {
  requestId: string;
  tenantId: string;
  agentId?: string;
  workflowId?: string;
  policyVersion?: string;
  localizationAllowed?: boolean;
  localizationCode?: string;
}

export class WebSearchHandler {
  private readonly injectionGuard: PromptInjectionGuard;
  private readonly contentPolicy: ContentPolicyEnforcer;

  constructor(
    private readonly deps: {
      client: DeepSeekClient;
      cache: ResearchCache;
      meter: ToolMeter;
      spendControl?: SpendControlAdapter;
      maxCharsPerResult?: number;
    },
  ) {
    this.injectionGuard = new PromptInjectionGuard(deps.maxCharsPerResult ?? 8192);
    this.contentPolicy = new ContentPolicyEnforcer();
  }

  async execute(rawRequest: unknown, ctx: WebSearchHandlerContext): Promise<WebSearchResult> {
    const startTime = Date.now();
    const validated = validateWebSearchRequest(rawRequest);
    const policyEval = this.contentPolicy.evaluateSearchQuery(validated.query);

    const cacheKey = await buildSearchCacheKey({
      tenantId: ctx.tenantId,
      provider: 'deepseek',
      query: validated.query,
      count: validated.count,
      needContent: validated.need_content,
      localization: ctx.localizationAllowed ? ctx.localizationCode : undefined,
      policyVersion: ctx.policyVersion,
    });

    // 1. Check tenant-scoped cache unless force_refresh is requested
    if (!validated.force_refresh && policyEval.cacheable) {
      const cachedEntry = await this.deps.cache.get<WebSearchResult>(cacheKey, ctx.tenantId);
      if (cachedEntry) {
        const hitResult: WebSearchResult = {
          ...cachedEntry.payload,
          cached: true,
        };
        await this.deps.meter.recordToolCall({
          requestId: ctx.requestId,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          workflowId: ctx.workflowId,
          toolName: 'web.search',
          provider: 'deepseek',
          cacheHit: true,
          httpStatus: 200,
          hasNonEmptyResult: hitResult.results.length > 0,
          executionTimeMs: Date.now() - startTime,
          r2ArtifactKey: cachedEntry.r2ObjectKey,
        });
        return hitResult;
      }
    }

    // 2. Atomic budget reservation before billable upstream call
    let reservation: ReservationHandle | undefined;
    if (this.deps.spendControl) {
      reservation = await this.deps.spendControl.reserve({
        tenantId: ctx.tenantId,
        category: 'web_search_usd',
        amount: DEEPSEEK_COST_PER_SUCCESS_USD,
        requestId: ctx.requestId,
      });
      if (!reservation.ok) {
        throw new Error(`Budget reservation denied for web.search: ${reservation.reason ?? 'budget_exceeded'}`);
      }
    }

    try {
      const upstream = await this.deps.client.search({
        query: validated.query,
        count: validated.count,
        ori_question: validated.ori_question,
        need_content: validated.need_content,
      });

      // Sanitize every untrusted search result snippet/summary/content
      const sanitizedResults: SearchResult[] = upstream.results.map((r) => {
        const snippetSan = this.injectionGuard.sanitizeUntrustedContent(r.snippet, r.url);
        const summarySan = r.summary
          ? this.injectionGuard.sanitizeUntrustedContent(r.summary, r.url)
          : undefined;
        const contentSan = r.content
          ? this.injectionGuard.sanitizeUntrustedContent(r.content, r.url)
          : undefined;
        return {
          ...r,
          snippet: snippetSan.sanitizedText,
          ...(summarySan ? { summary: summarySan.sanitizedText } : {}),
          ...(contentSan ? { content: contentSan.sanitizedText } : {}),
        };
      });

      const citations = sanitizedResults.map((r) => r.url);
      const responsePayload: WebSearchResult = {
        provider: 'deepseek',
        results: sanitizedResults,
        cached: false,
        citations,
      };

      const hasNonEmptyResult = sanitizedResults.length > 0;
      let r2Key: string | undefined;
      if (policyEval.cacheable && hasNonEmptyResult) {
        const stored = await this.deps.cache.put({
          cacheKey,
          tenantId: ctx.tenantId,
          toolName: 'web.search',
          provider: 'deepseek',
          normalizedTarget: validated.query.toLowerCase(),
          freshnessClass: policyEval.freshnessClass,
          payload: responsePayload,
        });
        r2Key = stored.r2ObjectKey;
      }

      const meterOut = await this.deps.meter.recordToolCall({
        requestId: ctx.requestId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        workflowId: ctx.workflowId,
        toolName: 'web.search',
        provider: 'deepseek',
        cacheHit: false,
        httpStatus: upstream.status,
        hasNonEmptyResult,
        executionTimeMs: Date.now() - startTime,
        r2ArtifactKey: r2Key,
      });

      if (this.deps.spendControl && reservation) {
        if (meterOut.record.billableSuccess) {
          await this.deps.spendControl.settle(reservation, ctx.tenantId, meterOut.record.costUsd);
        } else {
          await this.deps.spendControl.release(reservation, ctx.tenantId);
        }
      }

      return responsePayload;
    } catch (err: any) {
      if (this.deps.spendControl && reservation) {
        await this.deps.spendControl.release(reservation, ctx.tenantId);
      }
      await this.deps.meter.recordToolCall({
        requestId: ctx.requestId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        workflowId: ctx.workflowId,
        toolName: 'web.search',
        provider: 'deepseek',
        cacheHit: false,
        httpStatus: err?.statusCode ?? 500,
        hasNonEmptyResult: false,
        executionTimeMs: Date.now() - startTime,
        errorCode: err?.errorCode ?? 'UPSTREAM_ERROR',
      });
      throw err;
    }
  }
}
