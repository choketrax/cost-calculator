/**
 * Asynchronous Research Queue Consumer (Section 14 & 15)
 *
 * Processes long-running web research jobs via Cloudflare Queues with
 * idempotency and durable checkpoints via `ExecutionRecoveryEngine`.
 */

import { OpenVikingIntegration, OpenVikingResearchArtifact } from '../integrations/openviking';
import { ExecutionRecoveryEngine } from '../inference/execution-recovery';
import { VerifiedTenantIdentity } from '../gateway/middleware/identity';

export interface ResearchQueueJob {
  jobId: string;
  question: string;
  identity: VerifiedTenantIdentity;
  requiresLiveFreshness?: boolean;
  requiresFullContent?: boolean;
}

export class ResearchQueueConsumer {
  constructor(
    private readonly deps: {
      openViking: OpenVikingIntegration;
      recovery: ExecutionRecoveryEngine;
    },
  ) {}

  async processJob(job: ResearchQueueJob): Promise<OpenVikingResearchArtifact> {
    const existing = this.deps.recovery.getCheckpoint(
      job.identity.tenantId,
      job.jobId,
      'research_completed',
    );
    if (existing && existing.status === 'completed' && existing.state.artifact) {
      return existing.state.artifact as OpenVikingResearchArtifact;
    }

    try {
      const artifact = await this.deps.openViking.executeResearchQuestion({
        question: job.question,
        identity: job.identity,
        requiresLiveFreshness: job.requiresLiveFreshness,
        requiresFullContent: job.requiresFullContent,
      });

      await this.deps.recovery.saveCheckpoint({
        requestId: job.jobId,
        tenantId: job.identity.tenantId,
        stage: 'research_completed',
        state: { artifact },
        status: 'completed',
      });

      return artifact;
    } catch (err: any) {
      await this.deps.recovery.saveCheckpoint({
        requestId: job.jobId,
        tenantId: job.identity.tenantId,
        stage: 'research_failed',
        state: { question: job.question },
        status: 'dlq',
        lastError: err?.message ?? String(err),
      });
      throw err;
    }
  }
}
