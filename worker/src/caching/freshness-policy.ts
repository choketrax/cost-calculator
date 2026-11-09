/**
 * Freshness Policy for Search & Fetch Caching (Section 9)
 *
 * Initial suggested TTLs:
 * - Breaking news searches: 5 minutes (300s)
 * - General business search: 30 minutes (1800s)
 * - Evergreen reference search: 24 hours (86400s)
 * - Article fetch: 24 hours (86400s)
 * - Documentation fetch: 6 hours (21600s)
 * - High-volatility financial or regulatory information: 2 minutes (120s)
 */

import { ContentFreshnessClass } from '../tools/security/content-policy';

export const DEFAULT_TTL_SECONDS: Readonly<Record<ContentFreshnessClass, number>> = {
  breaking_news: 5 * 60,
  general_business: 30 * 60,
  evergreen_reference: 24 * 60 * 60,
  article_fetch: 24 * 60 * 60,
  documentation_fetch: 6 * 60 * 60,
  high_volatility_financial: 2 * 60,
};

export class FreshnessPolicy {
  private readonly overrides: Partial<Record<ContentFreshnessClass, number>>;

  constructor(overrides: Partial<Record<ContentFreshnessClass, number>> = {}) {
    this.overrides = overrides;
  }

  getTtlSeconds(freshnessClass: ContentFreshnessClass): number {
    return this.overrides[freshnessClass] ?? DEFAULT_TTL_SECONDS[freshnessClass];
  }

  computeExpiresAt(freshnessClass: ContentFreshnessClass, now = new Date()): string {
    const ttlSeconds = this.getTtlSeconds(freshnessClass);
    return new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  }
}
