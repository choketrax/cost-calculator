/**
 * Paperclip Agent Integration (Sections 7 & 17)
 *
 * Allows Paperclip agents to discover both `web_search` and `web_fetch` MCP tools
 * and invoke them through the shared AgentGateway MCP dispatcher.
 */

import { buildMcpToolDefinitions, McpToolDefinition } from '../mcp/tool-definitions';
import { McpToolDispatcher, McpToolCallResponse } from '../mcp/tool-dispatch';
import { ToolRegistry } from '../tools/registry';
import { VerifiedTenantIdentity } from '../gateway/middleware/identity';

export class PaperclipAgentIntegration {
  constructor(
    private readonly deps: {
      registry: ToolRegistry;
      dispatcher: McpToolDispatcher;
    },
  ) {}

  discoverMcpTools(): McpToolDefinition[] {
    return buildMcpToolDefinitions(this.deps.registry);
  }

  async callMcpTool(
    toolName: 'web_search' | 'web_fetch',
    args: Record<string, unknown>,
    identity: VerifiedTenantIdentity,
  ): Promise<McpToolCallResponse> {
    return this.deps.dispatcher.dispatch(
      {
        name: toolName,
        arguments: args,
      },
      {
        ...identity,
        agentId: identity.agentId ?? 'paperclip-agent',
      },
    );
  }
}
