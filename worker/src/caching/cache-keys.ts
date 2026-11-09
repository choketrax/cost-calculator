/**
 * Cache Key Builder (Section 9)
 *
 * Search cache keys include:
 *   - Provider
 *   - Normalized query
 *   - Count
 *   - Content flag
 *   - Localization setting, where allowed
 *   - Tenant ID & tenant data policy/version (prevents cross-tenant cache leakage)
 *
 * Fetch cache keys include:
 *   - Normalized URL
 *   - Provider
 *   - Relevant access policy & Tenant ID
 *   - Content version, where known
 */

import { deterministicId } from '../idempotency';

export interface SearchCacheKeyInput {
  tenantId: string;
  provider: string;
  query: string;
  count: number;
  needContent: boolean;
  localization?: string;
  policyVersion?: string;
}

export interface FetchCacheKeyInput {
  tenantId: string;
  provider: string;
  normalizedUrl: string;
  accessPolicy?: string;
  contentVersion?: string;
}

export function normalizeSearchQueryForCache(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function buildSearchCacheKey(input: SearchCacheKeyInput): Promise<string> {
  const normQuery = normalizeSearchQueryForCache(input.query);
  const raw = [
    `tenant:${input.tenantId}`,
    `prov:${input.provider}`,
    `q:${normQuery}`,
    `c:${input.count}`,
    `content:${input.needContent ? 1 : 0}`,
    `loc:${input.localization ?? 'none'}`,
    `pol:${input.policyVersion ?? 'v1'}`,
  ].join('|');
  const hash = await deterministicId(raw, 'search_cache');
  return `scache:${input.tenantId}:${hash}`;
}

export async function buildFetchCacheKey(input: FetchCacheKeyInput): Promise<string> {
  const raw = [
    `tenant:${input.tenantId}`,
    `prov:${input.provider}`,
    `url:${input.normalizedUrl}`,
    `pol:${input.accessPolicy ?? 'default'}`,
    `ver:${input.contentVersion ?? 'latest'}`,
  ].join('|');
  const hash = await deterministicId(raw, 'fetch_cache');
  return `fcache:${input.tenantId}:${hash}`;
}
