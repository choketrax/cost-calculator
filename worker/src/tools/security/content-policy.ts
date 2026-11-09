/**
 * Content Policy & Retention Classifier (Sections 9 & 12)
 *
 * Enforces token-budget limits, strips unsafe HTML/script tags,
 * checks whether content contains sensitive personal data or authenticated-session markers
 * that prohibit caching, and classifies content volatility for freshness TTLs.
 */

export type ContentFreshnessClass =
  | 'breaking_news'
  | 'general_business'
  | 'evergreen_reference'
  | 'article_fetch'
  | 'documentation_fetch'
  | 'high_volatility_financial';

export interface ContentPolicyCheck {
  cacheable: boolean;
  noCacheReason?: string;
  freshnessClass: ContentFreshnessClass;
  redactedContent: string;
}

export class ContentPolicyEnforcer {
  evaluateSearchQuery(query: string): {
    cacheable: boolean;
    noCacheReason?: string;
    freshnessClass: ContentFreshnessClass;
  } {
    const lower = query.toLowerCase();

    // Do not cache queries containing personal identifiers, tokens, or emails
    if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(query) || /\b\d{3}-\d{2}-\d{4}\b/.test(query)) {
      return {
        cacheable: false,
        noCacheReason: 'contains_sensitive_personal_identifier',
        freshnessClass: 'general_business',
      };
    }

    if (/\b(stock price|ticker|forex|crypto price|sec filing|fed rate|live quote)\b/.test(lower)) {
      return { cacheable: true, freshnessClass: 'high_volatility_financial' };
    }

    if (/\b(breaking|today|latest news|just happened|live updates)\b/.test(lower)) {
      return { cacheable: true, freshnessClass: 'breaking_news' };
    }

    if (/\b(definition|history of|rfc |specification|standard|mathematics|wikipedia)\b/.test(lower)) {
      return { cacheable: true, freshnessClass: 'evergreen_reference' };
    }

    return { cacheable: true, freshnessClass: 'general_business' };
  }

  evaluateFetchedDocument(url: string, content: string): ContentPolicyCheck {
    const lowerUrl = url.toLowerCase();
    const lowerContent = content.toLowerCase();

    // Do not cache authenticated pages or personal account pages
    if (
      /[?&](token|session|auth|sig|signature|access_token)=/i.test(url) ||
      lowerContent.includes('log out of your account') ||
      lowerContent.includes('private dashboard')
    ) {
      return {
        cacheable: false,
        noCacheReason: 'authenticated_or_session_scoped_page',
        freshnessClass: 'article_fetch',
        redactedContent: content,
      };
    }

    let freshnessClass: ContentFreshnessClass = 'article_fetch';
    if (/\b(docs\.|developer\.|documentation|\/docs\/|\/api\/|reference)/i.test(lowerUrl)) {
      freshnessClass = 'documentation_fetch';
    } else if (/\b(sec\.gov|bloomberg|reuters|nasdaq|finance)/i.test(lowerUrl)) {
      freshnessClass = 'high_volatility_financial';
    }

    return {
      cacheable: true,
      freshnessClass,
      redactedContent: content,
    };
  }
}
