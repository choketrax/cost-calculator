/**
 * Task Classifier & Deterministic Short-Circuit Engine
 *
 * Classifies incoming prompts/requests by task type, complexity, risk level,
 * and determines whether an existing deterministic function can handle the request
 * without invoking an LLM (Priority 1 of Neuron-first routing).
 */

import { ModelRequest, ModelResponse } from '../types';
import { DataClassificationLevel } from './model-registry';

export type TaskType =
  | 'deterministic_utility'
  | 'classification'
  | 'extraction'
  | 'summarization'
  | 'general_chat'
  | 'coding'
  | 'complex_reasoning'
  | 'research_synthesis';

export type RiskClassification = 'low' | 'medium' | 'high' | 'critical';

export interface TaskClassification {
  taskType: TaskType;
  complexity: 'trivial' | 'low' | 'medium' | 'high';
  risk: RiskClassification;
  dataClass: DataClassificationLevel;
  canRunDeterministically: boolean;
  deterministicHandlerName?: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  requiresTools: boolean;
  requiresStructuredOutput: boolean;
  requiresVision: boolean;
  requiresStreaming: boolean;
}

export class TaskClassifier {
  /**
   * Classify a ModelRequest and check if a deterministic function applies.
   */
  classify(
    request: ModelRequest,
    options: { preferDeterministic?: boolean; tenantDataClass?: DataClassificationLevel } = {},
  ): TaskClassification {
    const preferDeterministic = options.preferDeterministic ?? true;
    const lastUserMessage = this.extractLastUserText(request);
    const allText = this.extractAllText(request);
    const estimatedInputTokens = Math.max(1, Math.ceil(allText.length / 4));

    const requiresTools = Boolean(request.tools && request.tools.length > 0);
    const requiresStructuredOutput = Boolean(request.response_format);
    const requiresStreaming = Boolean(request.stream);
    const requiresVision = this.detectVision(request);

    // 1. Check if deterministic handler can satisfy without AI
    if (preferDeterministic && !requiresTools && !requiresVision) {
      const detMatch = this.matchDeterministicHandler(lastUserMessage);
      if (detMatch) {
        return {
          taskType: 'deterministic_utility',
          complexity: 'trivial',
          risk: 'low',
          dataClass: options.tenantDataClass ?? 'public',
          canRunDeterministically: true,
          deterministicHandlerName: detMatch,
          estimatedInputTokens,
          estimatedOutputTokens: 32,
          requiresTools: false,
          requiresStructuredOutput,
          requiresVision: false,
          requiresStreaming,
        };
      }
    }

    const lower = lastUserMessage.toLowerCase();
    let taskType: TaskType = 'general_chat';
    let complexity: TaskClassification['complexity'] = 'low';
    let risk: RiskClassification = 'low';
    let estimatedOutputTokens = request.max_tokens ?? 512;

    if (
      /\b(classify|categorize|sentiment|label|intent|yes or no|true or false)\b/.test(lower) &&
      estimatedInputTokens < 2000
    ) {
      taskType = 'classification';
      complexity = 'low';
      estimatedOutputTokens = Math.min(estimatedOutputTokens, 128);
    } else if (/\b(extract|parse|json fields|pull out|entities)\b/.test(lower) && estimatedInputTokens < 4000) {
      taskType = 'extraction';
      complexity = 'low';
      estimatedOutputTokens = Math.min(estimatedOutputTokens, 512);
    } else if (/\b(summarize|summary|tl;dr|brief)\b/.test(lower)) {
      taskType = 'summarization';
      complexity = estimatedInputTokens > 8000 ? 'medium' : 'low';
    } else if (/\b(typescript|javascript|python|sql|function|refactor|bug|compile|regex|class )\b/.test(lower)) {
      taskType = 'coding';
      complexity = estimatedInputTokens > 4000 || /\b(architect|distributed|security|optimize)\b/.test(lower)
        ? 'high'
        : 'medium';
    } else if (
      /\b(prove|mathematical|theorem|multi-step|formal verification|deep analysis|legal|medical|financial audit)\b/.test(
        lower,
      ) ||
      estimatedInputTokens > 16000
    ) {
      taskType = 'complex_reasoning';
      complexity = 'high';
      risk = /\b(legal|medical|financial|compliance|security)\b/.test(lower) ? 'high' : 'medium';
    } else if (/\b(cite|sources|search results|according to|research)\b/.test(lower)) {
      taskType = 'research_synthesis';
      complexity = 'medium';
    } else if (estimatedInputTokens > 4000) {
      complexity = 'medium';
    }

    const dataClass = this.detectDataClassification(allText, options.tenantDataClass);
    if (dataClass === 'restricted' || dataClass === 'confidential') {
      risk = risk === 'low' ? 'medium' : 'high';
    }

    return {
      taskType,
      complexity,
      risk,
      dataClass,
      canRunDeterministically: false,
      estimatedInputTokens,
      estimatedOutputTokens,
      requiresTools,
      requiresStructuredOutput,
      requiresVision,
      requiresStreaming,
    };
  }

  /**
   * Execute built-in deterministic handlers for non-AI tasks (JSON validation, ping/echo,
   * token estimation, ISO timestamp, SHA/UUID or simple arithmetic).
   */
  executeDeterministic(request: ModelRequest, handlerName: string): ModelResponse {
    const text = this.extractLastUserText(request).trim();
    let output = '';

    switch (handlerName) {
      case 'ping':
        output = 'PONG';
        break;
      case 'json_validate': {
        const jsonPayload = text.replace(/^validate\s+json\s*:?\s*/i, '').trim();
        try {
          JSON.parse(jsonPayload);
          output = JSON.stringify({ valid: true });
        } catch (e: any) {
          output = JSON.stringify({ valid: false, error: e.message });
        }
        break;
      }
      case 'arithmetic': {
        const expr = text.replace(/^(calculate|compute|what is)\s+/i, '').replace(/[?=]/g, '').trim();
        if (/^[\d\s+\-*/().]+$/.test(expr)) {
          const val = this.safeEvalArithmetic(expr);
          output = String(val);
        } else {
          output = 'UNSUPPORTED_EXPRESSION';
        }
        break;
      }
      default:
        output = text;
    }

    return {
      id: `det-${crypto.randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: `deterministic/${handlerName}`,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: output },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
      _routing: {
        selectedProvider: 'deterministic-local',
        selectedModel: `deterministic/${handlerName}`,
        routerLatencyMs: 1,
      },
    };
  }

  private matchDeterministicHandler(text: string): string | null {
    const trimmed = text.trim();
    if (/^(ping|healthcheck|echo\s+ping)$/i.test(trimmed)) {
      return 'ping';
    }
    if (/^validate\s+json\s*:/i.test(trimmed)) {
      return 'json_validate';
    }
    if (/^(calculate|compute)\s+[\d\s+\-*/().]+[?=]?$/i.test(trimmed)) {
      return 'arithmetic';
    }
    return null;
  }

  private safeEvalArithmetic(expr: string): number {
    // Simple shunting-yard / recursive descent for +, -, *, / and parentheses
    const tokens = expr.match(/\d+(?:\.\d+)?|[+\-*/()]/g);
    if (!tokens) return NaN;
    let pos = 0;

    const parseExpr = (): number => {
      let left = parseTerm();
      while (pos < tokens.length && (tokens[pos] === '+' || tokens[pos] === '-')) {
        const op = tokens[pos++];
        const right = parseTerm();
        left = op === '+' ? left + right : left - right;
      }
      return left;
    };

    const parseTerm = (): number => {
      let left = parseFactor();
      while (pos < tokens.length && (tokens[pos] === '*' || tokens[pos] === '/')) {
        const op = tokens[pos++];
        const right = parseFactor();
        left = op === '*' ? left * right : left / right;
      }
      return left;
    };

    const parseFactor = (): number => {
      const tok = tokens[pos++];
      if (tok === '(') {
        const val = parseExpr();
        pos++; // ')'
        return val;
      }
      return Number(tok);
    };

    return parseExpr();
  }

  private extractLastUserText(request: ModelRequest): string {
    for (let i = request.messages.length - 1; i >= 0; i--) {
      const m = request.messages[i];
      if (m.role === 'user') {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) {
          return m.content
            .map((part: any) => (typeof part === 'string' ? part : part?.text ?? ''))
            .join(' ');
        }
      }
    }
    return '';
  }

  private extractAllText(request: ModelRequest): string {
    return request.messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
      .join('\n');
  }

  private detectVision(request: ModelRequest): boolean {
    return request.messages.some((m) => {
      if (Array.isArray(m.content)) {
        return m.content.some((part: any) => part?.type === 'image_url' || part?.image);
      }
      return false;
    });
  }

  private detectDataClassification(
    text: string,
    defaultClass: DataClassificationLevel = 'internal',
  ): DataClassificationLevel {
    if (/\b(\d{3}-\d{2}-\d{4}|ssn|secret_key|private_key|BEGIN RSA PRIVATE KEY)\b/i.test(text)) {
      return 'restricted';
    }
    if (/\b(confidential|internal only|proprietary|patient|hipaa)\b/i.test(text)) {
      return 'confidential';
    }
    return defaultClass;
  }
}
