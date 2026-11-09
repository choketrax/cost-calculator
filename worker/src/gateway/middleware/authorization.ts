/**
 * RBAC & Tool Permission Authorization Middleware (Section 7, 13, 16)
 */

import { VerifiedTenantIdentity } from './identity';

export class ForbiddenError extends Error {
  constructor(
    message: string,
    public readonly requiredPermission: string,
    public readonly statusCode: number = 403,
  ) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class AuthorizationEnforcer {
  hasPermission(identity: VerifiedTenantIdentity, permission: string): boolean {
    if (!identity.authenticated) return false;
    if (identity.roles.includes('admin') || identity.permissions.includes('*')) {
      return true;
    }
    return identity.permissions.includes(permission);
  }

  requirePermission(identity: VerifiedTenantIdentity, permission: string): void {
    if (!this.hasPermission(identity, permission)) {
      throw new ForbiddenError(
        `Tenant '${identity.tenantId}' lacks required permission '${permission}'`,
        permission,
      );
    }
  }
}
