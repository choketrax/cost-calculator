/**
 * Data Classification & Unified Security Engine (DLP + Secret Redaction)
 * (Capability 9 of v3.0 Addendum + Sections 12 & 13)
 *
 * Applies data classification, Data Loss Prevention (DLP), secret redaction,
 * and provider data-boundary checks throughout the execution pipeline.
 */

import { DataClassificationLevel } from '../inference/model-registry';

export interface DlpScanResult {
  classification: DataClassificationLevel;
  containsSecrets: boolean;
  containsPii: boolean;
  redactedText: string;
  matchedRules: string[];
}

const SECRET_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: 'openai_or_deepseek_key', regex: /\bsk-[a-zA-Z0-9_-]{20,}\b/g },
  { name: 'bearer_jwt', regex: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g },
  { name: 'private_key_block', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'aws_access_key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
];

const PII_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: 'us_ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: 'credit_card', regex: /\b(?:\d[ -]*?){13,16}\b/g },
];

export class UnifiedSecurityEngine {
  scanAndRedact(text: string, baseClassification: DataClassificationLevel = 'internal'): DlpScanResult {
    let working = text;
    let containsSecrets = false;
    let containsPii = false;
    const matchedRules: string[] = [];

    for (const rule of SECRET_PATTERNS) {
      if (rule.regex.test(working)) {
        containsSecrets = true;
        matchedRules.push(rule.name);
        working = working.replace(rule.regex, '[REDACTED_SECRET]');
      }
      rule.regex.lastIndex = 0;
    }

    for (const rule of PII_PATTERNS) {
      if (rule.regex.test(working)) {
        containsPii = true;
        matchedRules.push(rule.name);
        working = working.replace(rule.regex, '[REDACTED_PII]');
      }
      rule.regex.lastIndex = 0;
    }

    let classification = baseClassification;
    if (containsSecrets) {
      classification = 'restricted';
    } else if (containsPii && classification === 'public') {
      classification = 'confidential';
    }

    return {
      classification,
      containsSecrets,
      containsPii,
      redactedText: working,
      matchedRules,
    };
  }

  /**
   * Redact secrets from operational log objects before printing or persisting.
   */
  redactForLogs(input: unknown): string {
    const raw = typeof input === 'string' ? input : JSON.stringify(input);
    return this.scanAndRedact(raw, 'internal').redactedText;
  }
}
