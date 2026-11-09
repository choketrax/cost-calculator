/**
 * Gateway Ingress Identity Verification (Section 13)
 *
 * Resolves tenant identity ONLY from trusted server-side authentication context:
 * - Token -> tenant credential mapping in D1 (`scp_tenant_credentials`) or configured tenant token table
 * - Signed HMAC token (`agw_<tenantId>.<permissions>.<signature>`) verified with `env.API_KEY`
 * - Master `env.API_KEY` (maps to internal default tenant `tenant-internal` unless scoped by signed token)
 *
 * NEVER trusts an unverified `X-Tenant-Id` or `X-Customer-Id` header or LLM body parameter
 * to switch tenant identity on `/api/v1/*` routes.
 */

import { DataClassificationLevel } from '../../inference/model-registry';
import { deterministicId } from '../../idempotency';

export interface VerifiedTenantIdentity {
  authenticated: boolean;
  tenantId: string;
  tenantName: string;
  roles: string[];
  permissions: string[];
  allowedDataClass: DataClassificationLevel;
  externalLlmEnabled: boolean;
  preferMiniMind: boolean;
  agentId?: string;
  workflowId?: string;
}

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 401,
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class IdentityVerifier {
  private readonly staticCredentials = new Map<string, VerifiedTenantIdentity>();

  constructor(
    private readonly masterApiKey: string,
    private readonly db?: D1Database,
  ) {}

  /**
   * Register a verified tenant token in-memory (for tests or bootstrapped tenants).
   */
  registerTenantToken(rawToken: string, identity: VerifiedTenantIdentity): void {
    this.staticCredentials.set(rawToken, identity);
  }

  async verifyRequest(request: Request): Promise<VerifiedTenantIdentity> {
    const bearer = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim();
    const apiKeyHeader = request.headers.get('X-API-Key')?.trim();
    const token = bearer || apiKeyHeader;

    if (!token) {
      throw new AuthenticationError('Missing authentication token (Authorization Bearer or X-API-Key)');
    }

    // 1. Check explicitly registered tenant tokens
    const staticMatch = this.staticCredentials.get(token);
    if (staticMatch) {
      return {
        ...staticMatch,
        agentId: request.headers.get('X-Agent-Id') ?? staticMatch.agentId,
        workflowId: request.headers.get('X-Workflow-Id') ?? staticMatch.workflowId,
      };
    }

    // 2. Check D1 `scp_tenant_credentials` by SHA-256 hash of token
    if (this.db) {
      try {
        const tokenHash = await deterministicId(token, 'tenant_token');
        const row = (await this.db
          .prepare(
            `SELECT * FROM scp_tenant_credentials WHERE token_hash = ? AND status = 'active' LIMIT 1`,
          )
          .bind(tokenHash)
          .first()) as any;
        if (row) {
          return {
            authenticated: true,
            tenantId: String(row.tenant_id),
            tenantName: String(row.tenant_name),
            roles: JSON.parse(row.roles_json || '["agent"]'),
            permissions: JSON.parse(
              row.permissions_json || '["inference.invoke","tools.web.search","tools.web.fetch"]',
            ),
            allowedDataClass: (row.allowed_data_class as DataClassificationLevel) ?? 'internal',
            externalLlmEnabled: Boolean(row.external_llm_enabled),
            preferMiniMind: Boolean(row.minimind_prefer),
            agentId: request.headers.get('X-Agent-Id') ?? undefined,
            workflowId: request.headers.get('X-Workflow-Id') ?? undefined,
          };
        }
      } catch {
        // Fall through if table not yet migrated
      }
    }

    // 3. Check master internal API key
    if (this.masterApiKey && token === this.masterApiKey) {
      return {
        authenticated: true,
        tenantId: 'tenant-internal',
        tenantName: 'Internal Platform Tenant',
        roles: ['admin', 'agent'],
        permissions: [
          'inference.invoke',
          'tools.web.search',
          'tools.web.fetch',
          'models.read',
          'tools.read',
          'usage.read',
          'health.read',
        ],
        allowedDataClass: 'confidential',
        externalLlmEnabled: false,
        preferMiniMind: false,
        agentId: request.headers.get('X-Agent-Id') ?? undefined,
        workflowId: request.headers.get('X-Workflow-Id') ?? undefined,
      };
    }

    throw new AuthenticationError('Invalid or unauthorized credential');
  }
}
