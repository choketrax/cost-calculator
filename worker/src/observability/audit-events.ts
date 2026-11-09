/**
 * Audit Event Logger (Sections 7, 12, 13)
 *
 * Records structured security, tool-invocation, and routing audit events
 * while automatically redacting any credentials or PII via `UnifiedSecurityEngine`.
 */

import { UnifiedSecurityEngine } from '../policies/data-classification';

export interface AuditEvent {
  eventId: string;
  eventType:
    | 'inference_routed'
    | 'tool_invoked'
    | 'external_fallback_denied'
    | 'external_fallback_approved'
    | 'prompt_injection_filtered'
    | 'url_policy_blocked'
    | 'authorization_denied';
  tenantId: string;
  agentId?: string;
  workflowId?: string;
  requestId: string;
  summary: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export class AuditEventLogger {
  private readonly events: AuditEvent[] = [];
  private readonly security = new UnifiedSecurityEngine();

  log(input: Omit<AuditEvent, 'eventId' | 'timestamp'>): AuditEvent {
    const redactedSummary = this.security.redactForLogs(input.summary);
    const redactedMetadata = input.metadata
      ? JSON.parse(this.security.redactForLogs(input.metadata))
      : undefined;

    const event: AuditEvent = {
      eventId: `aud-${crypto.randomUUID()}`,
      ...input,
      summary: redactedSummary,
      metadata: redactedMetadata,
      timestamp: new Date().toISOString(),
    };
    this.events.push(event);
    return event;
  }

  listEvents(tenantId?: string): ReadonlyArray<AuditEvent> {
    return tenantId ? this.events.filter((e) => e.tenantId === tenantId) : this.events;
  }
}
