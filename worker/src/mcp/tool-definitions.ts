/**
 * MCP Tool Definitions (Section 7)
 *
 * Exposes `web_search` and `web_fetch` in standard Model Context Protocol (MCP)
 * `tools/list` format, derived directly from the single AgentGateway `ToolRegistry`.
 */

import { ToolRegistry } from '../tools/registry';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
    internalToolName: string;
    requiredPermission: string;
    version: string;
  };
}

export function buildMcpToolDefinitions(
  registry = new ToolRegistry(),
  tenantId?: string,
): McpToolDefinition[] {
  const list = tenantId ? registry.listForTenant(tenantId) : registry.listAll();
  return list.map((meta) => ({
    name: meta.mcpName,
    description: meta.description,
    inputSchema: meta.inputSchema,
    annotations: {
      title: meta.name,
      readOnlyHint: meta.readOnly,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      internalToolName: meta.name,
      requiredPermission: meta.requiredPermission,
      version: meta.version,
    },
  }));
}
