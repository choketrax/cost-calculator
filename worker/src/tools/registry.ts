/**
 * AgentGateway Tool Registry (Section 7)
 *
 * Registers `web.search` (MCP `web_search`) and `web.fetch` (MCP `web_fetch`)
 * with complete governance metadata:
 * - Unique internal name, MCP name, and version
 * - JSON schema
 * - Read-only classification
 * - Required permission (`tools.web.search`, `tools.web.fetch`)
 * - Tenant context requirements
 * - Rate limits, default timeout, maximum output length
 * - Billing category (`web_search_usd`, `web_fetch_usd`)
 * - Audit requirements
 */

import { WEB_SEARCH_JSON_SCHEMA, WEB_FETCH_JSON_SCHEMA } from './schemas';
import { TenantBudgetCategory } from '../billing/spend-control-adapter';

export interface ToolRegistrationMetadata {
  name: string;
  mcpName: string;
  version: string;
  description: string;
  provider: 'deepseek' | 'internal' | string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  requiredPermission: 'tools.web.search' | 'tools.web.fetch' | string;
  requiresVerifiedTenantContext: boolean;
  /** '*' for shared platform tools, or explicit tenant IDs for private tenant MCP tools */
  tenantAllowlist?: string[];
  rateLimitRpm: number;
  defaultTimeoutMs: number;
  maxOutputChars: number;
  billingCategory: TenantBudgetCategory;
  costPerBillableSuccessUsd: number;
  auditRequired: boolean;
}

export const DEFAULT_TOOL_REGISTRATIONS: ReadonlyArray<ToolRegistrationMetadata> = [
  {
    name: 'web.search',
    mcpName: 'web_search',
    version: '2.0.0',
    description:
      'Reusable web search tool powered by DeepSeek Search. Returns normalized titles, URLs, snippets, provenance, and citations.',
    provider: 'deepseek',
    inputSchema: WEB_SEARCH_JSON_SCHEMA as unknown as Record<string, unknown>,
    readOnly: true,
    requiredPermission: 'tools.web.search',
    requiresVerifiedTenantContext: true,
    rateLimitRpm: 60,
    defaultTimeoutMs: 15000,
    maxOutputChars: 32768,
    billingCategory: 'web_search_usd',
    costPerBillableSuccessUsd: 0.00075,
    auditRequired: true,
  },
  {
    name: 'web.fetch',
    mcpName: 'web_fetch',
    version: '2.0.0',
    description:
      'Reusable web page retrieval tool powered by DeepSeek Fetch. Enforces SSRF/URL safety policies and returns normalized Markdown with provenance.',
    provider: 'deepseek',
    inputSchema: WEB_FETCH_JSON_SCHEMA as unknown as Record<string, unknown>,
    readOnly: true,
    requiredPermission: 'tools.web.fetch',
    requiresVerifiedTenantContext: true,
    rateLimitRpm: 30,
    defaultTimeoutMs: 20000,
    maxOutputChars: 65536,
    billingCategory: 'web_fetch_usd',
    costPerBillableSuccessUsd: 0.00075,
    auditRequired: true,
  },
];

export class ToolRegistry {
  private readonly byInternalName = new Map<string, ToolRegistrationMetadata>();
  private readonly byMcpName = new Map<string, ToolRegistrationMetadata>();

  constructor(initial: ReadonlyArray<ToolRegistrationMetadata> = DEFAULT_TOOL_REGISTRATIONS) {
    for (const item of initial) {
      this.register(item);
    }
  }

  register(meta: ToolRegistrationMetadata): void {
    this.byInternalName.set(meta.name, meta);
    this.byMcpName.set(meta.mcpName, meta);
  }

  get(nameOrMcpName: string): ToolRegistrationMetadata | undefined {
    return this.byInternalName.get(nameOrMcpName) ?? this.byMcpName.get(nameOrMcpName);
  }

  listAll(): ToolRegistrationMetadata[] {
    return Array.from(this.byInternalName.values());
  }

  listForTenant(tenantId: string): ToolRegistrationMetadata[] {
    return this.listAll().filter((meta) => this.isTenantAllowed(meta, tenantId));
  }

  isTenantAllowed(meta: ToolRegistrationMetadata, tenantId: string): boolean {
    if (!meta.tenantAllowlist || meta.tenantAllowlist.length === 0) return true;
    return meta.tenantAllowlist.includes('*') || meta.tenantAllowlist.includes(tenantId);
  }
}
