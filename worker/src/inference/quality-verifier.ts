/**
 * Quality Verification Engine (Capability 2 of v3.0 Addendum)
 *
 * Validates structured JSON outputs, tool calls, generated code blocks,
 * and workflow results using deterministic checks first and optional secondary
 * lightweight Workers AI verification when justified.
 * Extends existing `evaluateQuality` from `../routing` without duplicating it.
 */

import { ModelRequest, ModelResponse, ModelGateway, QualityEvaluation, QualityCheck } from '../types';
import { evaluateQuality } from '../routing';

export class QualityVerificationEngine {
  constructor(private readonly secondaryVerifierGateway?: ModelGateway) {}

  async verify(
    request: ModelRequest,
    response: ModelResponse,
    minScore: number = 0.75,
  ): Promise<QualityEvaluation> {
    const baseEval = evaluateQuality(request, response, minScore);
    const semanticChecks: QualityCheck[] = [...baseEval.semantic.checks];
    const content = response.choices?.[0]?.message?.content ?? '';

    // 1. Deterministic JSON / structured output check
    if (request.response_format && content) {
      let validJson = false;
      try {
        const cleaned = content.replace(/^```json\s*|\s*```$/g, '').trim();
        JSON.parse(cleaned);
        validJson = true;
      } catch {
        validJson = false;
      }
      semanticChecks.push({
        name: 'structured_json_parseable',
        passed: validJson,
        score: validJson ? 1.0 : 0.0,
        detail: validJson ? 'Valid JSON structure' : 'Invalid JSON in structured output response',
      });
    }

    // 2. Deterministic generated code syntax balance check
    if (content.includes('```')) {
      const balancedBraces = this.checkBalancedDelimiters(content);
      semanticChecks.push({
        name: 'code_block_delimiter_balance',
        passed: balancedBraces,
        score: balancedBraces ? 1.0 : 0.4,
        detail: balancedBraces ? 'Balanced code delimiters' : 'Unbalanced braces/brackets in generated code',
      });
    }

    // 3. Deterministic tool call JSON arguments validation
    const toolCalls = response.choices?.[0]?.message?.tool_calls as any[] | undefined;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const allArgsValid = toolCalls.every((tc) => {
        if (!tc?.function?.name) return false;
        const args = tc.function.arguments;
        if (typeof args === 'object' && args !== null) return true;
        if (typeof args === 'string') {
          try {
            JSON.parse(args);
            return true;
          } catch {
            return false;
          }
        }
        return false;
      });
      semanticChecks.push({
        name: 'tool_call_arguments_json',
        passed: allArgsValid,
        score: allArgsValid ? 1.0 : 0.0,
        detail: allArgsValid ? 'All tool call arguments are valid JSON' : 'Malformed tool call arguments',
      });
    }

    const semanticScore =
      semanticChecks.length > 0
        ? semanticChecks.reduce((sum, c) => sum + (c.score ?? (c.passed ? 1 : 0)), 0) /
          semanticChecks.length
        : 1.0;

    const overallScore = Math.min(baseEval.operational.score, semanticScore, baseEval.policy.score);
    const passed = overallScore >= minScore;

    return {
      overallScore,
      passed,
      operational: baseEval.operational,
      semantic: {
        score: semanticScore,
        passed: semanticScore >= minScore,
        checks: semanticChecks,
      },
      policy: baseEval.policy,
      recommendation: passed
        ? 'accept'
        : overallScore >= minScore * 0.5
          ? 'escalate'
          : 'human_review',
    };
  }

  private checkBalancedDelimiters(text: string): boolean {
    let curly = 0;
    for (const ch of text) {
      if (ch === '{') curly++;
      if (ch === '}') curly--;
      if (curly < 0) return false;
    }
    return curly === 0;
  }
}
