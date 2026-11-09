/**
 * Context Optimization Engine (Capability 7 of v3.0 Addendum)
 *
 * Integrates OpenViking retrieval with token-budget management,
 * relevant-context filtering, chunk deduplication, and prompt-cache-aware formatting
 * (placing static system + high-reuse tenant context prefix first to maximize cached tokens).
 */

export interface ContextChunk {
  id: string;
  source: string;
  content: string;
  relevanceScore: number;
  isStaticPrefix?: boolean;
}

export interface OptimizedContextResult {
  formattedMessages: Array<{ role: 'system' | 'user'; content: string }>;
  includedChunkIds: string[];
  deduplicatedCount: number;
  droppedForBudgetCount: number;
  estimatedTokens: number;
  cacheablePrefixTokens: number;
}

export class ContextOptimizationEngine {
  optimize(input: {
    systemInstruction: string;
    userQuery: string;
    chunks: ContextChunk[];
    maxContextTokens: number;
    minRelevanceScore?: number;
  }): OptimizedContextResult {
    const minRelevance = input.minRelevanceScore ?? 0.5;
    const seenHashes = new Set<string>();
    let deduplicatedCount = 0;

    // 1. Filter by relevance and deduplicate normalized text
    const uniqueChunks: ContextChunk[] = [];
    for (const chunk of input.chunks) {
      if (chunk.relevanceScore < minRelevance && !chunk.isStaticPrefix) continue;
      const normKey = chunk.content.trim().toLowerCase().replace(/\s+/g, ' ');
      if (seenHashes.has(normKey)) {
        deduplicatedCount++;
        continue;
      }
      seenHashes.add(normKey);
      uniqueChunks.push(chunk);
    }

    // 2. Sort static prefix chunks first (for prompt cache hit efficiency), then by relevance descending
    uniqueChunks.sort((a, b) => {
      if (Boolean(a.isStaticPrefix) !== Boolean(b.isStaticPrefix)) {
        return a.isStaticPrefix ? -1 : 1;
      }
      return b.relevanceScore - a.relevanceScore;
    });

    const systemTokens = Math.ceil(input.systemInstruction.length / 4);
    const queryTokens = Math.ceil(input.userQuery.length / 4);
    let remainingBudget = Math.max(0, input.maxContextTokens - systemTokens - queryTokens);

    const selectedChunks: ContextChunk[] = [];
    let droppedForBudgetCount = 0;
    let cacheablePrefixTokens = systemTokens;

    for (const chunk of uniqueChunks) {
      const chunkTokens = Math.ceil(chunk.content.length / 4);
      if (chunkTokens <= remainingBudget) {
        selectedChunks.push(chunk);
        remainingBudget -= chunkTokens;
        if (chunk.isStaticPrefix) {
          cacheablePrefixTokens += chunkTokens;
        }
      } else {
        droppedForBudgetCount++;
      }
    }

    const contextBlock = selectedChunks
      .map((c) => `[Source: ${c.source}]\n${c.content}`)
      .join('\n\n---\n\n');

    const formattedMessages: Array<{ role: 'system' | 'user'; content: string }> = [
      {
        role: 'system',
        content: contextBlock
          ? `${input.systemInstruction}\n\n<retrieved_context>\n${contextBlock}\n</retrieved_context>`
          : input.systemInstruction,
      },
      {
        role: 'user',
        content: input.userQuery,
      },
    ];

    const totalTokens = formattedMessages.reduce(
      (sum, m) => sum + Math.ceil(m.content.length / 4),
      0,
    );

    return {
      formattedMessages,
      includedChunkIds: selectedChunks.map((c) => c.id),
      deduplicatedCount,
      droppedForBudgetCount,
      estimatedTokens: totalTokens,
      cacheablePrefixTokens,
    };
  }
}
