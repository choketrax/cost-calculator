/**
 * MCP Tool Dispatch (Section 7 & 13)
 *
 * Dispatches MCP `tools/call` and internal tool invocations (`web_search`/`web.search`,
 * `web_fetch`/`web.fetch`) through verified tenant identity and RBAC permission checks.
 * Never accepts an unverified `tenant_id` supplied in LLM arguments or raw headers.
 */

import { ToolRegistry } from '../tools/registry';
import { WebSearchHandler } from '../tools/handlers/web-search';
import { WebFetchHandler } from '../tools/handlers/web-fetch';
import { VerifiedTenantIdentity } from '../gateway/middleware/identity';
import { AuthorizationEnforcer, ForbiddenError } from '../gateway/middleware/authorization';
import { ToolValidationError } from '../tools/schemas';

export interface McpToolCallRequest {
  name: string;
  arguments?: Record<string, unknown>;
  requestId?: string;
}

export interface McpToolCallResponse {
  isError: boolean;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
}

export class McpToolDispatcher {
  private readonly authz = new AuthorizationEnforcer();

  constructor(
    private readonly deps: {
      registry: ToolRegistry;
      searchHandler: WebSearchHandler;
      fetchHandler: WebFetchHandler;
    },
  ) {}

  async dispatch(
    call: McpToolCallRequest,
    verifiedIdentity: VerifiedTenantIdentity,
  ): Promise<McpToolCallResponse> {
    if (!call || typeof call.name !== 'string' || call.name.trim().length === 0) {
      throw new ToolValidationError('MCP tool call requires a non-empty tool name');
    }
    if (call.arguments !== undefined && (typeof call.arguments !== 'object' || Array.isArray(call.arguments))) {
      throw new ToolValidationError('MCP tool arguments must be a JSON object');
    }

    const meta = this.deps.registry.get(call.name);
    if (!meta) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool '${call.name}'` }],
      };
    }

    // Enforce tenant isolation for private MCP tools
    if (!this.deps.registry.isTenantAllowed(meta, verifiedIdentity.tenantId)) {
      throw new ForbiddenError(
        `Tenant '${verifiedIdentity.tenantId}' is not authorized to access private MCP tool '${call.name}'`,
        meta.requiredPermission,
      );
    }

    // Enforce verified tenant context and tool permission
    this.authz.requirePermission(verifiedIdentity, meta.requiredPermission);

    // Strip any LLM-supplied `tenant_id` or `tenantId` inside arguments so an agent prompt
    // can never spoof another tenant's cache or budget
    const rawArgs = { ...(call.arguments ?? {}) };
    delete (rawArgs as any).tenant_id;
    delete (rawArgs as any).tenantId;

    const requestId = call.requestId ?? crypto.randomUUID();

    if (meta.name === 'web.search') {
      const result = await this.deps.searchHandler.execute(rawArgs, {
        requestId,
        tenantId: verifiedIdentity.tenantId,
        agentId: verifiedIdentity.agentId,
        workflowId: verifiedIdentity.workflowId,
      });
      return {
        isError: false,
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }

    if (meta.name === 'web.fetch') {
      const result = await this.deps.fetchHandler.execute(rawArgs, {
        requestId,
        tenantId: verifiedIdentity.tenantId,
        agentId: verifiedIdentity.agentId,
        workflowId: verifiedIdentity.workflowId,
      });
      return {
        isError: false,
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }

    return {
      isError: true,
      content: [{ type: 'text', text: `Unsupported tool '${meta.name}'` }],
    };
  }
}
