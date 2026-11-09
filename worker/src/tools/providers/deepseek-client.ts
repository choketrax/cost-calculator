/**
 * DeepSeek Search & Fetch Client (Sections 5, 6, 14)
 *
 * Upstream endpoints:
 *   POST https://api.deepseek.com/v1/tools/search
 *   POST https://api.deepseek.com/v1/tools/fetch
 *
 * Authentication: DeepSeek bearer API key from `env.DEEPSEEK_API_KEY` (never hardcoded).
 * Implements:
 * - Bounded retries with exponential backoff + jitter for transient errors (408, 429, 502, 503, 504)
 * - No retries for 401/403 authentication errors, 402 insufficient balance, or 400 invalid requests
 * - Strict outgoing payload filtering (never forwards client IP or unrecognized fields unless authorized)
 * - Per-domain Fetch throttling
 */

import { SearchResult } from '../schemas';

export interface DeepSeekClientConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  fetchImpl?: typeof fetch;
}

export class DeepSeekProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryable: boolean,
    public readonly errorCode:
      | 'AUTH_ERROR'
      | 'INSUFFICIENT_BALANCE'
      | 'RATE_LIMITED'
      | 'INVALID_REQUEST'
      | 'UPSTREAM_TIMEOUT'
      | 'UPSTREAM_5XX'
      | 'MISSING_API_KEY',
  ) {
    super(message);
    this.name = 'DeepSeekProviderError';
  }
}

export class DeepSeekClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly domainLastFetchMs = new Map<string, number>();

  constructor(config: DeepSeekClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '');
    this.timeoutMs = config.timeoutMs ?? 15000;
    this.maxRetries = config.maxRetries ?? 2;
    this.baseBackoffMs = config.baseBackoffMs ?? 50;
    this.fetchFn = config.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async search(params: {
    query: string;
    count: number;
    ori_question?: string;
    need_content: boolean;
  }): Promise<{ status: number; results: SearchResult[]; attempts: number }> {
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new DeepSeekProviderError(
        'DEEPSEEK_API_KEY secret is not configured',
        503,
        false,
        'MISSING_API_KEY',
      );
    }

    // Build clean upstream payload (never forward arbitrary user fields or client IP)
    const upstreamPayload: Record<string, unknown> = {
      query: params.query,
      count: params.count,
      need_content: params.need_content,
    };
    if (params.ori_question) {
      upstreamPayload.ori_question = params.ori_question;
    }

    const { status, data, attempts } = await this.postWithBoundedRetry(
      `${this.baseUrl}/v1/tools/search`,
      upstreamPayload,
    );

    const rawList: any[] = Array.isArray(data?.results)
      ? data.results
      : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.web_pages)
          ? data.web_pages
          : [];

    const results: SearchResult[] = rawList
      .filter((item) => item && typeof item.url === 'string' && item.url.trim().length > 0)
      .slice(0, params.count)
      .map((item) => ({
        title: String(item.title ?? item.name ?? 'Untitled'),
        url: String(item.url),
        snippet: String(item.snippet ?? item.description ?? item.summary ?? ''),
        ...(item.summary ? { summary: String(item.summary) } : {}),
        ...(params.need_content && item.content ? { content: String(item.content) } : {}),
        ...(item.published_at || item.date_published || item.publish_time
          ? { published_at: String(item.published_at ?? item.date_published ?? item.publish_time) }
          : {}),
        ...(typeof item.authority === 'number' ? { authority: item.authority } : {}),
        ...(typeof item.relevance_score === 'number' || typeof item.score === 'number'
          ? { relevance_score: Number(item.relevance_score ?? item.score) }
          : {}),
      }));

    return { status, results, attempts };
  }

  async fetchUrl(
    url: string,
    minDomainIntervalMs: number = 0,
  ): Promise<{ status: number; title: string; content: string; attempts: number }> {
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new DeepSeekProviderError(
        'DEEPSEEK_API_KEY secret is not configured',
        503,
        false,
        'MISSING_API_KEY',
      );
    }

    // Per-domain Fetch throttling check
    const hostname = new URL(url).hostname.toLowerCase();
    const now = Date.now();
    const lastTs = this.domainLastFetchMs.get(hostname) ?? 0;
    if (minDomainIntervalMs > 0 && now - lastTs < minDomainIntervalMs) {
      throw new DeepSeekProviderError(
        `Per-domain throttle active for '${hostname}'`,
        429,
        true,
        'RATE_LIMITED',
      );
    }
    this.domainLastFetchMs.set(hostname, now);

    const { status, data, attempts } = await this.postWithBoundedRetry(
      `${this.baseUrl}/v1/tools/fetch`,
      { url },
    );

    const payload = data?.data ?? data ?? {};
    const title = String(payload.title ?? 'Untitled');
    const content = String(payload.content ?? payload.markdown ?? payload.text ?? '');

    return { status, title, content, attempts };
  }

  private async postWithBoundedRetry(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; data: any; attempts: number }> {
    let attempts = 0;
    let lastError: DeepSeekProviderError | undefined;

    while (attempts <= this.maxRetries) {
      attempts++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const res = await this.fetchFn(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        const status = res.status;
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          return { status, data, attempts };
        }

        const errText = await res.text().catch(() => '');
        const classified = this.classifyHttpError(status, errText);
        if (!classified.retryable || attempts > this.maxRetries) {
          throw classified;
        }
        lastError = classified;
      } catch (err) {
        if (err instanceof DeepSeekProviderError) {
          if (!err.retryable || attempts > this.maxRetries) {
            throw err;
          }
          lastError = err;
        } else {
          // Network or AbortController timeout
          const timeoutErr = new DeepSeekProviderError(
            err instanceof Error ? err.message : 'Upstream timeout or network error',
            408,
            true,
            'UPSTREAM_TIMEOUT',
          );
          if (attempts > this.maxRetries) {
            throw timeoutErr;
          }
          lastError = timeoutErr;
        }
      } finally {
        clearTimeout(timer);
      }

      // Exponential backoff with jitter
      const delay = this.baseBackoffMs * Math.pow(2, attempts - 1) + Math.floor(Math.random() * 15);
      await new Promise((r) => setTimeout(r, delay));
    }

    throw (
      lastError ??
      new DeepSeekProviderError('Upstream request failed after retries', 503, false, 'UPSTREAM_5XX')
    );
  }

  private classifyHttpError(status: number, bodyText: string): DeepSeekProviderError {
    if (status === 401 || status === 403) {
      return new DeepSeekProviderError(
        `DeepSeek authentication failed (${status})`,
        status,
        false,
        'AUTH_ERROR',
      );
    }
    if (status === 402) {
      return new DeepSeekProviderError(
        'DeepSeek account has insufficient balance (402)',
        402,
        false,
        'INSUFFICIENT_BALANCE',
      );
    }
    if (status === 400 || status === 422) {
      return new DeepSeekProviderError(
        `DeepSeek rejected request (${status}): ${bodyText.slice(0, 200)}`,
        status,
        false,
        'INVALID_REQUEST',
      );
    }
    if (status === 408) {
      return new DeepSeekProviderError('DeepSeek request timeout (408)', 408, true, 'UPSTREAM_TIMEOUT');
    }
    if (status === 429) {
      return new DeepSeekProviderError('DeepSeek rate limit exceeded (429)', 429, true, 'RATE_LIMITED');
    }
    if (status >= 500) {
      return new DeepSeekProviderError(
        `DeepSeek upstream server error (${status})`,
        status,
        true,
        'UPSTREAM_5XX',
      );
    }
    return new DeepSeekProviderError(`DeepSeek HTTP ${status}`, status, false, 'INVALID_REQUEST');
  }
}
