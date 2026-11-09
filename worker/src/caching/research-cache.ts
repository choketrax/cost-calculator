/**
 * Tenant-Isolated Research Cache (Section 9 & 13)
 *
 * Uses in-memory + D1 metadata index (`scp_research_cache`) and R2 (`AUDIT_STORAGE`)
 * for large research artifacts, enforcing strict per-tenant isolation so Tenant A
 * can never read Tenant B's cached search or fetch entries.
 */

import { ContentFreshnessClass } from '../tools/security/content-policy';
import { FreshnessPolicy } from './freshness-policy';

export interface CachedArtifactEntry<T> {
  cacheKey: string;
  tenantId: string;
  toolName: 'web.search' | 'web.fetch';
  provider: string;
  freshnessClass: ContentFreshnessClass;
  payload: T;
  r2ObjectKey?: string;
  createdAt: string;
  expiresAt: string;
}

export class ResearchCache {
  private readonly memoryStore = new Map<string, CachedArtifactEntry<any>>();
  private readonly freshness: FreshnessPolicy;

  constructor(
    private readonly options: {
      db?: D1Database;
      r2?: R2Bucket;
      freshness?: FreshnessPolicy;
      r2ThresholdChars?: number;
    } = {},
  ) {
    this.freshness = options.freshness ?? new FreshnessPolicy();
  }

  async get<T>(cacheKey: string, tenantId: string): Promise<CachedArtifactEntry<T> | null> {
    const mem = this.memoryStore.get(cacheKey);
    if (mem) {
      // Enforce strict tenant isolation check even if a caller guesses a key
      if (mem.tenantId !== tenantId) {
        return null;
      }
      if (new Date(mem.expiresAt).getTime() <= Date.now()) {
        this.memoryStore.delete(cacheKey);
        return null;
      }
      return mem as CachedArtifactEntry<T>;
    }

    if (this.options.db) {
      try {
        const row = (await this.options.db
          .prepare(
            `SELECT * FROM scp_research_cache WHERE cache_key = ? AND tenant_id = ? LIMIT 1`,
          )
          .bind(cacheKey, tenantId)
          .first()) as any;

        if (!row) return null;
        if (new Date(row.expires_at).getTime() <= Date.now()) {
          return null;
        }

        let payload: T | null = null;
        if (row.inline_payload_json) {
          payload = JSON.parse(row.inline_payload_json) as T;
        } else if (row.r2_object_key && this.options.r2) {
          const obj = await this.options.r2.get(row.r2_object_key);
          if (obj) {
            payload = (await obj.json()) as T;
          }
        }
        if (!payload) return null;

        const entry: CachedArtifactEntry<T> = {
          cacheKey: row.cache_key,
          tenantId: row.tenant_id,
          toolName: row.tool_name,
          provider: row.provider,
          freshnessClass: row.content_class,
          payload,
          r2ObjectKey: row.r2_object_key ?? undefined,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
        };
        this.memoryStore.set(cacheKey, entry);
        return entry;
      } catch {
        return null;
      }
    }

    return null;
  }

  async put<T>(input: {
    cacheKey: string;
    tenantId: string;
    toolName: 'web.search' | 'web.fetch';
    provider: string;
    normalizedTarget: string;
    freshnessClass: ContentFreshnessClass;
    payload: T;
  }): Promise<CachedArtifactEntry<T>> {
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = this.freshness.computeExpiresAt(input.freshnessClass, now);
    const serialized = JSON.stringify(input.payload);
    const threshold = this.options.r2ThresholdChars ?? 8192;

    let r2ObjectKey: string | undefined;
    if (this.options.r2 && serialized.length >= threshold) {
      r2ObjectKey = `research-cache/${input.tenantId}/${input.cacheKey}.json`;
      await this.options.r2.put(r2ObjectKey, serialized, {
        httpMetadata: { contentType: 'application/json' },
      });
    }

    const entry: CachedArtifactEntry<T> = {
      cacheKey: input.cacheKey,
      tenantId: input.tenantId,
      toolName: input.toolName,
      provider: input.provider,
      freshnessClass: input.freshnessClass,
      payload: input.payload,
      r2ObjectKey,
      createdAt,
      expiresAt,
    };

    this.memoryStore.set(input.cacheKey, entry);

    if (this.options.db) {
      try {
        await this.options.db
          .prepare(
            `INSERT OR REPLACE INTO scp_research_cache (
              cache_key, tenant_id, tool_name, provider, normalized_target,
              content_class, r2_object_key, inline_payload_json, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            input.cacheKey,
            input.tenantId,
            input.toolName,
            input.provider,
            input.normalizedTarget,
            input.freshnessClass,
            r2ObjectKey ?? null,
            r2ObjectKey ? null : serialized,
            createdAt,
            expiresAt,
          )
          .run();
      } catch {
        // Non-fatal in unit test memory mode
      }
    }

    return entry;
  }
}
