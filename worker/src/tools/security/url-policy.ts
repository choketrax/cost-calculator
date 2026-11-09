/**
 * URL Safety & SSRF Defense-in-Depth Policy (Section 6 & 12)
 *
 * Enforces:
 * - HTTP or HTTPS scheme only
 * - Maximum URL length of 8,192 characters
 * - No embedded credentials (username/password)
 * - Rejection of localhost, loopback, RFC1918 private IPv4, link-local (169.254.0.0/16),
 *   CGNAT (100.64.0.0/10), IPv6 loopback/unique-local/link-local, cloud metadata endpoints,
 *   and internal hostnames (.local, .internal, .corp, .lan, .intranet, .home.arpa)
 * - Domain blocklist / allowlist policy
 */

export class UrlSecurityError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'URL_TOO_LONG'
      | 'INVALID_URL_SYNTAX'
      | 'UNSUPPORTED_SCHEME'
      | 'EMBEDDED_CREDENTIALS'
      | 'PRIVATE_OR_INTERNAL_HOST'
      | 'CLOUD_METADATA_BLOCKED'
      | 'BLOCKED_DOMAIN',
  ) {
    super(message);
    this.name = 'UrlSecurityError';
  }
}

export interface UrlPolicyOptions {
  maxLength?: number;
  blockedDomains?: string[];
  allowedDomains?: string[];
}

const METADATA_HOSTS = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
]);

const INTERNAL_SUFFIXES = [
  '.local',
  '.internal',
  '.corp',
  '.lan',
  '.intranet',
  '.home.arpa',
  '.localdomain',
  '.svc.cluster.local',
];

export class UrlPolicyValidator {
  private readonly maxLength: number;
  private readonly blockedDomains: Set<string>;
  private readonly allowedDomains?: Set<string>;

  constructor(options: UrlPolicyOptions = {}) {
    this.maxLength = options.maxLength ?? 8192;
    this.blockedDomains = new Set((options.blockedDomains ?? []).map((d) => d.toLowerCase()));
    if (options.allowedDomains && options.allowedDomains.length > 0) {
      this.allowedDomains = new Set(options.allowedDomains.map((d) => d.toLowerCase()));
    }
  }

  validateAndNormalize(rawUrl: string): string {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
      throw new UrlSecurityError('URL must be a non-empty string', 'INVALID_URL_SYNTAX');
    }
    if (rawUrl.length > this.maxLength) {
      throw new UrlSecurityError(
        `URL length ${rawUrl.length} exceeds maximum of ${this.maxLength} characters`,
        'URL_TOO_LONG',
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new UrlSecurityError('Malformed URL', 'INVALID_URL_SYNTAX');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new UrlSecurityError(
        `Unsupported URL scheme '${parsed.protocol}' (only http: and https: are allowed)`,
        'UNSUPPORTED_SCHEME',
      );
    }

    if (parsed.username || parsed.password) {
      throw new UrlSecurityError(
        'Embedded credentials in URLs are prohibited',
        'EMBEDDED_CREDENTIALS',
      );
    }

    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

    if (METADATA_HOSTS.has(host)) {
      throw new UrlSecurityError(
        `Access to cloud metadata endpoint '${host}' is prohibited`,
        'CLOUD_METADATA_BLOCKED',
      );
    }

    if (this.isPrivateOrInternalHost(host)) {
      throw new UrlSecurityError(
        `Target host '${host}' resolves to localhost, private network, or internal address space`,
        'PRIVATE_OR_INTERNAL_HOST',
      );
    }

    if (this.blockedDomains.has(host)) {
      throw new UrlSecurityError(`Domain '${host}' is blocked by policy`, 'BLOCKED_DOMAIN');
    }

    if (this.allowedDomains && !this.allowedDomains.has(host)) {
      throw new UrlSecurityError(`Domain '${host}' is not in tenant allowlist`, 'BLOCKED_DOMAIN');
    }

    // Strip URL fragment for canonical retrieval
    parsed.hash = '';
    return parsed.toString();
  }

  private isPrivateOrInternalHost(host: string): boolean {
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '::' ||
      host === '0:0:0:0:0:0:0:1'
    ) {
      return true;
    }

    // Reject single-label hostnames without a public TLD
    if (!host.includes('.') && !host.includes(':')) {
      return true;
    }

    for (const suffix of INTERNAL_SUFFIXES) {
      if (host.endsWith(suffix)) {
        return true;
      }
    }

    // Reject numeric/octal/hex IP encodings or standard dotted IPv4 in private ranges
    if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
      return true;
    }

    const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
      const octets = ipv4Match.slice(1, 5).map(Number);
      if (octets.some((o) => o > 255)) return true;
      const [a, b] = octets;
      // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8
      if (a === 0 || a === 10 || a === 127) return true;
      // 169.254.0.0/16 (link-local & cloud metadata)
      if (a === 169 && b === 254) return true;
      // 172.16.0.0/12
      if (a === 172 && b >= 16 && b <= 31) return true;
      // 192.168.0.0/16
      if (a === 192 && b === 168) return true;
      // 100.64.0.0/10 (Carrier-grade NAT / Tailscale / internal mesh)
      if (a === 100 && b >= 64 && b <= 127) return true;
      // 224.0.0.0/4 multicast & 240.0.0.0/4 reserved
      if (a >= 224) return true;
    }

    // IPv6 private/link-local/loopback checks
    if (host.includes(':')) {
      const normalized = host.toLowerCase();
      if (
        normalized.startsWith('fc') ||
        normalized.startsWith('fd') ||
        normalized.startsWith('fe80') ||
        normalized.startsWith('::ffff:127.') ||
        normalized.startsWith('::ffff:10.') ||
        normalized.startsWith('::ffff:192.168.') ||
        normalized.startsWith('::ffff:169.254.')
      ) {
        return true;
      }
    }

    return false;
  }
}
