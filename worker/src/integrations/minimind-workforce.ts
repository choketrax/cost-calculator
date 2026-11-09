/**
 * MiniMind Synthetic-Data & Workforce Integration (Sections 8 & 17)
 *
 * Implements the mandatory MiniMind synthetic-data workflow:
 * 1. Generate a candidate topic or training objective.
 * 2. Retrieve web references via shared `web.search` tool if necessary.
 * 3. Run a supported Workers AI teacher model.
 * 4. Sample and diversify examples with `StormDropExplorationEngine`.
 * 5. Validate outputs (`QualityVerificationEngine`) and record provenance.
 * 6. Save selected examples in R2 (scoped by tenant).
 * 7. Enqueue approved dataset metadata for the separate training system.
 *
 * Mandatory safeguard: Web research tools NEVER silently initiate GPU training.
 */

import { McpToolDispatcher } from '../mcp/tool-dispatch';
import { ModelRouter } from '../inference/model-router';
import { StormDropExplorationEngine } from '../inference/stormdrop';
import { QualityVerificationEngine } from '../inference/quality-verifier';
import { VerifiedTenantIdentity } from '../gateway/middleware/identity';
import { WebSearchResult } from '../tools/schemas';

export interface SyntheticTrainingExample {
  exampleId: string;
  tenantId: string;
  topic: string;
  teacherModelId: string;
  prompt: string;
  completion: string;
  citations: string[];
  qualityScore: number;
  stormDropBucket: number;
  r2Key?: string;
  gpuTrainingInitiated: false;
  createdAt: string;
}

export class MiniMindWorkforceIntegration {
  private readonly stormDrop = new StormDropExplorationEngine();
  private readonly verifier = new QualityVerificationEngine();

  constructor(
    private readonly deps: {
      toolDispatcher: McpToolDispatcher;
      modelRouter: ModelRouter;
      r2?: R2Bucket;
    },
  ) {}

  async generateSyntheticExample(input: {
    topic: string;
    identity: VerifiedTenantIdentity;
    retrieveWebReferences?: boolean;
    sampleRatePct?: number;
    remainingTrainingBudgetUsd?: number;
  }): Promise<SyntheticTrainingExample> {
    const citations: string[] = [];
    let referenceSnippet = '';

    if (input.retrieveWebReferences) {
      const searchOut = await this.deps.toolDispatcher.dispatch(
        {
          name: 'web_search',
          arguments: { query: input.topic.slice(0, 128), count: 2 },
        },
        input.identity,
      );
      const searchPayload = searchOut.structuredContent as WebSearchResult | undefined;
      if (searchPayload?.results?.length) {
        for (const r of searchPayload.results) {
          citations.push(r.url);
        }
        referenceSnippet = searchPayload.results.map((r) => r.snippet).join('\n');
      }
    }

    // Run supported Workers AI teacher model
    const prompt = `Summarize and create a high-quality training Q&A example for topic: ${input.topic}\nReferences:\n${referenceSnippet}`;
    const teacherOut = await this.deps.modelRouter.routeAndExecute(
      {
        model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
        messages: [{ role: 'user', content: prompt }],
      },
      {
        tenantId: input.identity.tenantId,
        agentId: 'minimind-synthetic-teacher',
      },
    );

    // Sample with StormDrop
    const sampleDecision = this.stormDrop.evaluateSample({
      requestId: teacherOut.decision.requestId,
      tenantId: input.identity.tenantId,
      sampleRatePct: input.sampleRatePct ?? 100,
      dataClass: 'internal',
      risk: 'low',
      remainingExperimentBudgetUsd: input.remainingTrainingBudgetUsd ?? 5.0,
      estimatedComparisonCostUsd: 0.001,
    });

    // Validate output quality
    const quality = await this.verifier.verify(
      { model: teacherOut.response.model, messages: [{ role: 'user', content: prompt }] },
      teacherOut.response,
      0.7,
    );

    const exampleId = `mm-ex-${crypto.randomUUID()}`;
    const r2Key = `minimind-datasets/${input.identity.tenantId}/${exampleId}.json`;

    const example: SyntheticTrainingExample = {
      exampleId,
      tenantId: input.identity.tenantId,
      topic: input.topic,
      teacherModelId: teacherOut.decision.selectedModel ?? teacherOut.response.model,
      prompt,
      completion: teacherOut.response.choices[0]?.message?.content ?? '',
      citations,
      qualityScore: quality.overallScore,
      stormDropBucket: sampleDecision.bucketValue,
      r2Key,
      // Mandatory invariant: Web research tools must NEVER silently initiate GPU training
      gpuTrainingInitiated: false,
      createdAt: new Date().toISOString(),
    };

    if (this.deps.r2 && quality.passed && sampleDecision.sampled) {
      await this.deps.r2.put(r2Key, JSON.stringify(example), {
        httpMetadata: { contentType: 'application/json' },
      });
    }

    return example;
  }
}
