/**
 * Server-Side Tenant Context Resolver (Section 13)
 *
 * Ensures tenant scope is attached strictly from `VerifiedTenantIdentity`
 * and strips or ignores any client-supplied or LLM-supplied tenant overrides.
 */

import { VerifiedTenantIdentity } from './identity';

export interface ScopedTenantExecutionContext {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly agentId?: string;
  readonly workflowId?: string;
  readonly requestId: string;
  readonly identity: VerifiedTenantIdentity;
}

export function buildTenantExecutionContext(
  identity: VerifiedTenantIdentity,
  request: Request,
): ScopedTenantExecutionContext {
  const requestId = request.headers.get('X-Request-Id')?.trim() || crypto.randomUUID();
  return Object.freeze({
    tenantId: identity.tenantId,
    tenantName: identity.tenantName,
    agentId: identity.agentId,
    workflowId: identity.workflowId,
    requestId,
    identity,
  });
}
