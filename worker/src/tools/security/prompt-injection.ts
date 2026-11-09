/**
 * Prompt-Injection Detection & Isolation Engine (Section 12)
 *
 * Treats every Search and Fetch result as untrusted external data.
 * Detects and neutralizes embedded instructions attempting to:
 * - Override system prompts ("Ignore previous instructions", "You are now...")
 * - Invoke AgentGateway tools (`web.fetch`, `web_search`, `<tool_call>`, `function_call`)
 * - Exfiltrate credentials or environment secrets (`DEEPSEEK_API_KEY`, `Authorization`, `.env`)
 * - Inject role delimiters (`<|im_start|>`, `### System:`, `[INST]`)
 */

export interface SanitizationResult {
  sanitizedText: string;
  injectionDetected: boolean;
  findings: string[];
  truncated: boolean;
}

const INJECTION_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  {
    name: 'system_override',
    regex: /\b(ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|rules)|disregard\s+system\s+prompt|you\s+are\s+now\s+in\s+developer\s+mode)\b/gi,
  },
  {
    name: 'role_delimiter_injection',
    regex: /(?:<\|im_start\|>|<\|im_end\|>|<\|system\|>|\[INST\]|\[\/INST\]|^###\s*System\s*:)/gim,
  },
  {
    name: 'unauthorized_tool_invocation',
    regex: /(?:<tool_call>|<\/tool_call>|<function_calls>|\b(?:invoke|call|execute)\s+tool\s+(?:web\.search|web\.fetch|web_search|web_fetch)\b)/gi,
  },
  {
    name: 'secret_exfiltration_attempt',
    regex: /\b(print|output|send|exfiltrate|reveal|leak)\s+(?:the\s+)?(?:DEEPSEEK_API_KEY|OPENROUTER_API_KEY|API_KEY|system\s+credentials|bearer\s+token)\b/gi,
  },
  {
    name: 'script_execution_payload',
    regex: /<script\b[^>]*>[\s\S]*?<\/script>/gi,
  },
];

export class PromptInjectionGuard {
  constructor(private readonly maxChars: number = 32768) {}

  sanitizeUntrustedContent(rawText: string, sourceUrl?: string): SanitizationResult {
    if (!rawText) {
      return {
        sanitizedText: '',
        injectionDetected: false,
        findings: [],
        truncated: false,
      };
    }

    let working = rawText;
    const findings: string[] = [];

    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.regex.test(working)) {
        findings.push(pattern.name);
        working = working.replace(pattern.regex, '[REDACTED_UNTRUSTED_INSTRUCTION]');
      }
      pattern.regex.lastIndex = 0;
    }

    let truncated = false;
    if (working.length > this.maxChars) {
      working = working.slice(0, this.maxChars) + '\n...[TRUNCATED_BY_CONTENT_POLICY]';
      truncated = true;
    }

    return {
      sanitizedText: working,
      injectionDetected: findings.length > 0,
      findings,
      truncated,
    };
  }

  /**
   * Wrap untrusted external content in a clearly isolated provenance envelope
   * so downstream Workers AI summarization treats it strictly as data, never instructions.
   */
  wrapIsolatedDocument(content: string, sourceUrl: string, retrievedAt: string): string {
    const sanitized = this.sanitizeUntrustedContent(content, sourceUrl);
    return [
      `<untrusted_external_content source="${sourceUrl}" retrieved_at="${retrievedAt}" injection_filtered="${sanitized.injectionDetected}">`,
      sanitized.sanitizedText,
      `</untrusted_external_content>`,
    ].join('\n');
  }
}
