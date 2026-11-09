/**
 * Schemas & Request Validation for `web.search` and `web.fetch` (Sections 5, 6, 7)
 *
 * Enforces strict field allowlisting (rejects or strips unrecognized user fields),
 * Unicode character limits, count ranges, and JSON schemas for MCP registration.
 */

export interface WebSearchRequest {
  query: string;
  count?: number;
  ori_question?: string;
  need_content?: boolean;
  /** Optional internal gateway control for forced cache refresh (not sent upstream) */
  force_refresh?: boolean;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  summary?: string;
  content?: string;
  published_at?: string;
  authority?: number;
  relevance_score?: number;
}

export interface WebSearchResult {
  provider: 'deepseek';
  results: SearchResult[];
  cached: boolean;
  citations: string[];
}

export interface WebFetchRequest {
  url: string;
  /** Optional internal gateway control for forced cache refresh (not sent upstream) */
  force_refresh?: boolean;
}

export interface WebFetchResult {
  provider: 'deepseek';
  url: string;
  title: string;
  content: string;
  content_type: 'text/markdown';
  retrieved_at: string;
  cached: boolean;
}

export class ToolValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'INVALID_TOOL_INPUT',
  ) {
    super(message);
    this.name = 'ToolValidationError';
  }
}

const ALLOWED_SEARCH_FIELDS = new Set([
  'query',
  'count',
  'ori_question',
  'need_content',
  'force_refresh',
]);

const ALLOWED_FETCH_FIELDS = new Set(['url', 'force_refresh']);

export function validateWebSearchRequest(raw: unknown): Required<
  Pick<WebSearchRequest, 'query' | 'count' | 'need_content'>
> &
  Pick<WebSearchRequest, 'ori_question' | 'force_refresh'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ToolValidationError('Search request body must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_SEARCH_FIELDS.has(key)) {
      throw new ToolValidationError(
        `Unrecognized field '${key}' is not permitted in web.search`,
        'UNRECOGNIZED_FIELD',
      );
    }
  }

  if (typeof obj.query !== 'string') {
    throw new ToolValidationError('Field "query" is required and must be a string');
  }

  const trimmedQuery = obj.query.trim();
  const queryCodePoints = Array.from(obj.query).length;
  if (trimmedQuery.length === 0) {
    throw new ToolValidationError('Field "query" cannot be empty or whitespace-only', 'EMPTY_QUERY');
  }
  if (queryCodePoints < 1 || queryCodePoints > 128) {
    throw new ToolValidationError(
      `Field "query" must be 1–128 Unicode characters (got ${queryCodePoints})`,
      'QUERY_LENGTH_EXCEEDED',
    );
  }

  let count = 5;
  if (obj.count !== undefined) {
    if (typeof obj.count !== 'number' || !Number.isInteger(obj.count) || obj.count < 1 || obj.count > 50) {
      throw new ToolValidationError(
        'Field "count" must be an integer between 1 and 50',
        'INVALID_COUNT',
      );
    }
    count = obj.count;
  }

  let oriQuestion: string | undefined;
  if (obj.ori_question !== undefined) {
    if (typeof obj.ori_question !== 'string') {
      throw new ToolValidationError('Field "ori_question" must be a string');
    }
    const oriLen = Array.from(obj.ori_question).length;
    if (oriLen > 128) {
      throw new ToolValidationError(
        `Field "ori_question" must be at most 128 Unicode characters (got ${oriLen})`,
        'ORI_QUESTION_LENGTH_EXCEEDED',
      );
    }
    oriQuestion = obj.ori_question.trim();
  }

  const needContent = typeof obj.need_content === 'boolean' ? obj.need_content : false;
  const forceRefresh = typeof obj.force_refresh === 'boolean' ? obj.force_refresh : false;

  return {
    query: trimmedQuery,
    count,
    ...(oriQuestion ? { ori_question: oriQuestion } : {}),
    need_content: needContent,
    force_refresh: forceRefresh,
  };
}

export function validateWebFetchRequest(raw: unknown): { url: string; force_refresh: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ToolValidationError('Fetch request body must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_FETCH_FIELDS.has(key)) {
      throw new ToolValidationError(
        `Unrecognized field '${key}' is not permitted in web.fetch`,
        'UNRECOGNIZED_FIELD',
      );
    }
  }
  if (typeof obj.url !== 'string' || obj.url.trim().length === 0) {
    throw new ToolValidationError('Field "url" is required and must be a non-empty string');
  }
  return {
    url: obj.url.trim(),
    force_refresh: typeof obj.force_refresh === 'boolean' ? obj.force_refresh : false,
  };
}

export const WEB_SEARCH_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: 'Search query (1-128 Unicode characters, non-whitespace).',
    },
    count: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      default: 5,
      description: 'Number of results to return (default 5, max 50).',
    },
    ori_question: {
      type: 'string',
      maxLength: 128,
      description: 'Optional original user question for retrieval context (max 128 characters).',
    },
    need_content: {
      type: 'boolean',
      default: false,
      description: 'Whether to include extended page content in search results.',
    },
  },
} as const;

export const WEB_FETCH_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: {
      type: 'string',
      minLength: 1,
      maxLength: 8192,
      description: 'Public HTTP or HTTPS URL to fetch as normalized Markdown.',
    },
  },
} as const;
