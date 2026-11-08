export const SECRET_PATTERNS = Object.freeze([
  {
    id: 'PEM',
    severity: 'P0',
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi,
    replacement: '[REDACTED_PEM]',
  },
  {
    id: 'JWT',
    severity: 'P0',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: '[REDACTED_JWT]',
  },
  {
    id: 'ANTHROPIC',
    severity: 'P0',
    regex: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    replacement: '[REDACTED_ANTHROPIC]',
  },
  {
    id: 'GITHUB_PAT',
    severity: 'P0',
    regex: /github_pat_[A-Za-z0-9_]{22,}/g,
    replacement: '[REDACTED_GITHUB_PAT]',
  },
  {
    id: 'GITHUB',
    severity: 'P0',
    regex: /gh[opusr]_[A-Za-z0-9]{36,}/g,
    replacement: '[REDACTED_GITHUB]',
  },
  {
    id: 'GITLAB',
    severity: 'P0',
    regex: /glpat-[A-Za-z0-9_-]{20,}/g,
    replacement: '[REDACTED_GITLAB]',
  },
  {
    id: 'SLACK',
    severity: 'P0',
    regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    replacement: '[REDACTED_SLACK]',
  },
  {
    id: 'SENDGRID',
    severity: 'P0',
    regex: /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
    replacement: '[REDACTED_SENDGRID]',
  },
  {
    id: 'GOOGLE_OAUTH',
    severity: 'P0',
    regex: /GOCSPX-[A-Za-z0-9_-]{20,}/g,
    replacement: '[REDACTED_GOOGLE_OAUTH]',
  },
  {
    id: 'NPM',
    severity: 'P0',
    regex: /npm_[A-Za-z0-9]{30,}/g,
    replacement: '[REDACTED_NPM]',
  },
  {
    id: 'AWS',
    severity: 'P0',
    regex: /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
    replacement: '[REDACTED_AWS]',
  },
  {
    id: 'GOOGLE',
    severity: 'P0',
    regex: /AIza[0-9A-Za-z_-]{35}/g,
    replacement: '[REDACTED_GOOGLE]',
  },
  {
    id: 'STRIPE',
    severity: 'P0',
    regex: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}/g,
    replacement: '[REDACTED_STRIPE]',
  },
  {
    id: 'WEBHOOK',
    severity: 'P0',
    regex: /\bwhsec_[0-9A-Za-z]{16,}/g,
    replacement: '[REDACTED_WEBHOOK]',
  },
  {
    id: 'URI_CREDENTIALS',
    severity: 'P0',
    regex: /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]{4,}@/gi,
    replacement: '$1[REDACTED_CREDENTIALS]@',
  },
  {
    id: 'APIKEY',
    severity: 'P1',
    regex: /(?:sk-|sk_)[0-9A-Za-z]{20,}/g,
    replacement: '[REDACTED_APIKEY]',
  },
  {
    id: 'ENV',
    severity: 'P1',
    regex:
      /([A-Za-z0-9_]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret))\s*[:=]\s*["']?[^\s"']{8,}["']?/gi,
    replacement: '$1=[REDACTED_ENV]',
  },
]);

export const SECRET_LEAK_FINDING_ID = 'SL-001';

/**
 * Deterministic, local, no network. Every P0 match aborts the run before the
 * text is written into any subprocess stdin. Returns the redacted text only,
 * never the original secret.
 */
export function shield(textInput) {
  let text = typeof textInput === 'string' ? textInput : String(textInput ?? '');
  let redactions = 0;
  const hits = [];

  for (const pattern of SECRET_PATTERNS) {
    const found = text.match(pattern.regex);
    if (!found || found.length === 0) continue;
    redactions += found.length;
    hits.push({ id: pattern.id, severity: pattern.severity, count: found.length });
    text = text.replace(pattern.regex, pattern.replacement);
  }

  const leak = hits.some((hit) => hit.severity === 'P0');
  return { diffRedacted: text, redactions, leak, hits };
}

export function redactText(value) {
  return shield(value).diffRedacted;
}

export function secretLeakFinding() {
  return {
    id: SECRET_LEAK_FINDING_ID,
    severity: 'P0',
    title: 'Secret material found in the reviewed input',
    file: '',
    line: null,
    cwe: 'CWE-798',
    evidence: 'Pre-Flight Secret Shield matched a P0 pattern. The input was redacted before any juror ran.',
    suggestion: 'Remove the secret, rotate it and keep it out of the commit.',
  };
}
