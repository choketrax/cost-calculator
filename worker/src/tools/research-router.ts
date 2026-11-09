/**
 * Research Intelligence Router (Capability 3 of v3.0 Addendum + Section 8)
 *
 * Chooses among:
 *   1. OpenViking (tenant-scoped existing knowledge)
 *   2. Cached research information (`ResearchCache`)
 *   3. DeepSeek Search (`web.search`)
 *   4. DeepSeek Fetch (`web.fetch` — only when full source content is necessary)
 * based on freshness, relevance, source reliability, and estimated cost.
 * Strictly separates retrieval from Workers AI inference.
 */

export type ResearchSourceChoice =
  | 'openviking_knowledge'
  | 'research_cache'
  | 'deepseek_search'
  | 'deepseek_search_and_fetch';

export interface ResearchRoutingInput {
  query: string;
  tenantHasOpenVikingMatch: boolean;
  openVikingRelevanceScore?: number;
  hasFreshCacheHit: boolean;
  requiresLiveFreshness: boolean;
  requiresFullArticleBody: boolean;
  remainingResearchBudgetUsd: number;
}

export interface ResearchRoutingDecision {
  selectedSource: ResearchSourceChoice;
  estimatedCostUsd: number;
  reason: string;
}

export class ResearchIntelligenceRouter {
  decide(input: ResearchRoutingInput): ResearchRoutingDecision {
    // 1. If tenant-scoped OpenViking knowledge has a high-relevance match and live freshness is not required
    if (
      input.tenantHasOpenVikingMatch &&
      !input.requiresLiveFreshness &&
      (input.openVikingRelevanceScore ?? 0) >= 0.82
    ) {
      return {
        selectedSource: 'openviking_knowledge',
        estimatedCostUsd: 0,
        reason: 'Satisfied by existing tenant-scoped OpenViking knowledge without external web retrieval',
      };
    }

    // 2. If a fresh tenant-scoped cache entry exists
    if (input.hasFreshCacheHit) {
      return {
        selectedSource: 'research_cache',
        estimatedCostUsd: 0,
        reason: 'Satisfied by fresh tenant-isolated research cache entry',
      };
    }

    // 3. Check budget for DeepSeek Search ($0.00075)
    if (input.remainingResearchBudgetUsd < 0.00075) {
      return {
        selectedSource: 'openviking_knowledge',
        estimatedCostUsd: 0,
        reason: 'Research budget below $0.00075 threshold; falling back to local tenant knowledge',
      };
    }

    // 4. Only invoke DeepSeek Fetch ($0.00075 extra) when full source content is genuinely required
    if (input.requiresFullArticleBody && input.remainingResearchBudgetUsd >= 0.0015) {
      return {
        selectedSource: 'deepseek_search_and_fetch',
        estimatedCostUsd: 0.0015,
        reason: 'Fresh external search plus full page Markdown fetch required',
      };
    }

    return {
      selectedSource: 'deepseek_search',
      estimatedCostUsd: 0.00075,
      reason: 'Fresh external web search via DeepSeek ($0.00075); snippet synthesis sufficient',
    };
  }
}
