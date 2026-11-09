/**
 * `web.fetch` Tool Handler (Sections 6, 9, 10, 12)
 *
 * Orchestrates:
 * 1. Request validation (`validateWebFetchRequest`)
 * 2. Defense-in-depth URL safety validation (`UrlPolicyValidator`)
 * 3. Tenant-isolated cache lookup (`buildFetchCacheKey`)
 * 4. Atomic Spend Control Pack reservation (`web_fetch_usd`, $0.00075)
 * 5. Upstream DeepSeek Fetch invocation (`POST https://api.deepseek.com/v1/tools/fetch`)
 * 6. Untrusted Markdown content sanitization (`PromptInjectionGuard`)
 * 7. Settlement or release of atomic reservation + `ToolMeter` recording
 */

import { validateWebFetchRequest, WebFetchResult } from '../schemas';
import { DeepSeekClient } from '../providers/deepseek-client';
import { UrlPolicyValidator } from '../security/url-policy';
import { PromptInjectionGuard } from '../security/prompt-injection';
import { ContentPolicyEnforcer } from '../security/content-policy';
import { ResearchCache } from '../../caching/research-cache';
import { buildFetchCacheKey } from '../../caching/cache-keys';
import { ToolMeter, DEEPSEEK_COST_PER_SUCCESS_USD } from '../../billing/tool-meter';
import { SpendControlAdapter, ReservationHandle } from '../../billing/spend-control-adapter';

export interface WebFetchHandlerContext {
  requestId: string;
  tenantId: string;
  agentId?: string;
  workflowId?: string;
  accessPolicy?: string;
}

export class WebFetchHandler {
  private readonly urlPolicy: UrlPolicyValidator;
  private readonly injectionGuard: PromptInjectionGuard;
  private readonly contentPolicy: ContentPolicyEnforcer;

  constructor(
    private readonly deps: {
      client: DeepSeekClient;
      cache: ResearchCache;
      meter: ToolMeter;
      spendControl?: SpendControlAdapter;
      urlPolicy?: UrlPolicyValidator;
      maxContentChars?: number;
    },
  ) {
    this.urlPolicy = deps.urlPolicy ?? new UrlPolicyValidator();
    this.injectionGuard = new PromptInjectionGuard(deps.maxContentChars ?? 65536);
    this.contentPolicy = new ContentPolicyEnforcer();
  }

  async execute(rawRequest: unknown, ctx: WebFetchHandlerContext): Promise<WebFetchResult> {
    const startTime = Date.now();
    const validated = validateWebFetchRequest(rawRequest);

    // Defense-in-depth URL validation BEFORE cache or upstream call
    const normalizedUrl = this.urlPolicy.validateAndNormalize(validated.url);

    const cacheKey = await buildFetchCacheKey({
      tenantId: ctx.tenantId,
      provider: 'deepseek',
      normalizedUrl,
      accessPolicy: ctx.accessPolicy,
    });

    if (!validated.force_refresh) {
      const cachedEntry = await this.deps.cache.get<WebFetchResult>(cacheKey, ctx.tenantId);
      if (cachedEntry) {
        const hitResult: WebFetchResult = {
          ...cachedEntry.payload,
          cached: true,
        };
        await this.deps.meter.recordToolCall({
          requestId: ctx.requestId,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          workflowId: ctx.workflowId,
          toolName: 'web.fetch',
          provider: 'deepseek',
          cacheHit: true,
          httpStatus: 200,
          hasNonEmptyResult: hitResult.content.length > 0,
          executionTimeMs: Date.now() - startTime,
          r2ArtifactKey: cachedEntry.r2ObjectKey,
        });
        return hitResult;
      }
    }

    // Atomic budget reservation before billable upstream call
    let reservation: ReservationHandle | undefined;
    if (this.deps.spendControl) {
      reservation = await this.deps.spendControl.reserve({
        tenantId: ctx.tenantId,
        category: 'web_fetch_usd',
        amount: DEEPSEEK_COST_PER_SUCCESS_USD,
        requestId: ctx.requestId,
      });
      if (!reservation.ok) {
        throw new Error(`Budget reservation denied for web.fetch: ${reservation.reason ?? 'budget_exceeded'}`);
      }
    }

    try {
      const upstream = await this.deps.client.fetchUrl(normalizedUrl);
      const sanitized = this.injectionGuard.sanitizeUntrustedContent(upstream.content, normalizedUrl);
      const docPolicy = this.contentPolicy.evaluateFetchedDocument(normalizedUrl, sanitized.sanitizedText);
      const retrievedAt = new Date().toISOString();

      const result: WebFetchResult = {
        provider: 'deepseek',
        url: normalizedUrl,
        title: this.injectionGuard.sanitizeUntrustedContent(upstream.title, normalizedUrl).sanitizedText,
        content: sanitized.sanitizedText,
        content_type: 'text/markdown',
        retrieved_at: retrievedAt,
        cached: false,
      };

      const hasNonEmptyResult = result.content.trim().length > 0;
      let r2Key: string | undefined;

      if (docPolicy.cacheable && hasNonEmptyResult) {
        const stored = await this.deps.cache.put({
          cacheKey,
          tenantId: ctx.tenantId,
          toolName: 'web.fetch',
          provider: 'deepseek',
          normalizedTarget: normalizedUrl,
          freshnessClass: docPolicy.freshnessClass,
          payload: result,
        });
        r2Key = stored.r2ObjectKey;
      }

      const meterOut = await this.deps.meter.recordToolCall({
        requestId: ctx.requestId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        workflowId: ctx.workflowId,
        toolName: 'web.fetch',
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

      return result;
    } catch (err: any) {
      if (this.deps.spendControl && reservation) {
        await this.deps.spendControl.release(reservation, ctx.tenantId);
      }
      await this.deps.meter.recordToolCall({
        requestId: ctx.requestId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        workflowId: ctx.workflowId,
        toolName: 'web.fetch',
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
