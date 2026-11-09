/**
 * Asynchronous Training-Data Queue Consumer (Section 8 & 15)
 *
 * Processes synthetic training-example generation batches via `MiniMindWorkforceIntegration`
 * without silently initiating GPU training.
 */

import { MiniMindWorkforceIntegration, SyntheticTrainingExample } from '../integrations/minimind-workforce';
import { VerifiedTenantIdentity } from '../gateway/middleware/identity';

export interface TrainingDataQueueJob {
  batchId: string;
  topics: string[];
  identity: VerifiedTenantIdentity;
  retrieveWebReferences?: boolean;
}

export class TrainingDataQueueConsumer {
  constructor(private readonly minimind: MiniMindWorkforceIntegration) {}

  async processBatch(job: TrainingDataQueueJob): Promise<SyntheticTrainingExample[]> {
    const examples: SyntheticTrainingExample[] = [];
    for (const topic of job.topics) {
      const ex = await this.minimind.generateSyntheticExample({
        topic,
        identity: job.identity,
        retrieveWebReferences: job.retrieveWebReferences,
      });
      examples.push(ex);
    }
    return examples;
  }
}
