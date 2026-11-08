import { redactText, secretLeakFinding } from './shield.js';

export const VERDICTS = Object.freeze(['PASS', 'BLOCK', 'ERROR']);
export const SEVERITIES = Object.freeze(['NONE', 'P0', 'P1', 'P2']);
const MAX_DEPTH = 12;
const MAX_PLAIN_TEXT = 200_000;

const ANSI_ESCAPE = /\u001b\[[0-9;?]*[A-Za-z]/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Secrets out, then terminal control codes out, before anything is stored or printed. */
function clean(value) {
  return redactText(value)
    .replace(ANSI_ESCAPE, '')
    .replace(CONTROL_CHARS, ' ');
}

function severityRank(severity) {
  if (severity === 'P0') return 0;
  if (severity === 'P1') return 1;
  if (severity === 'P2') return 2;
  return 3;
}

export function normalizeSeverity(value, fallback = 'P2') {
  const text = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return SEVERITIES.includes(text) && text !== 'NONE' ? text : fallback;
}

export function normalizeFinding(raw, index = 0, probePrefix = 'JR') {
  const source = raw && typeof raw === 'object' ? raw : {};
  const line = Number.isInteger(source.line) ? source.line : null;
  const id =
    typeof source.id === 'string' && source.id.trim()
      ? source.id.trim()
      : `${probePrefix}-${String(index + 1).padStart(3, '0')}`;
  return {
    id,
    severity: normalizeSeverity(source.severity),
    title: clean(typeof source.title === 'string' ? source.title : 'Untitled finding'),
    file: typeof source.file === 'string' ? source.file : '',
    line,
    cwe: typeof source.cwe === 'string' ? source.cwe : '',
    evidence: clean(typeof source.evidence === 'string' ? source.evidence : ''),
    suggestion: clean(typeof source.suggestion === 'string' ? source.suggestion : ''),
  };
}

function looksLikeVerdict(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.verdict !== 'string') return false;
  return VERDICTS.includes(value.verdict.trim().toUpperCase());
}

function normalizeDictamen(raw, engine, nonce) {
  const juror = raw.juror && typeof raw.juror === 'object' ? raw.juror : {};
  const findings = Array.isArray(raw.findings)
    ? raw.findings.map((finding, index) => normalizeFinding(finding, index))
    : [];
  const highest = findings.reduce(
    (worst, finding) => (severityRank(finding.severity) < severityRank(worst) ? finding.severity : worst),
    'NONE',
  );
  return {
    nonce: typeof raw.nonce === 'string' ? raw.nonce : nonce ?? '',
    juror: {
      engine: typeof juror.engine === 'string' && juror.engine ? juror.engine : engine,
      probe: typeof juror.probe === 'string' ? juror.probe : '',
      author: typeof juror.author === 'string' ? juror.author : '',
    },
    verdict: String(raw.verdict).trim().toUpperCase(),
    severity: findings.length > 0 ? highest : 'NONE',
    findings,
    summary: clean(typeof raw.summary === 'string' ? raw.summary : ''),
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseEvents(raw) {
  const direct = safeJson(raw);
  if (direct !== null) return Array.isArray(direct) ? direct : [direct];
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith('{') && !text.startsWith('[')) continue;
    const parsed = safeJson(text);
    if (parsed === null) continue;
    if (Array.isArray(parsed)) events.push(...parsed);
    else events.push(parsed);
  }
  return events;
}

function textOf(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value)) {
      const joined = value.map((item) => (typeof item === 'string' ? item : item?.text)).filter(Boolean);
      if (joined.length > 0) return joined.join('\n');
    }
  }
  return null;
}

/**
 * Official assistant channel per engine. Anything else in the stream (input
 * echo, tool output, reasoning, diff) is ignored on purpose: it is untrusted.
 */
const ASSISTANT_TEXT = Object.freeze({
  claude(raw) {
    const events = parseEvents(raw);
    const result = [...events].reverse().find((event) => event && event.type === 'result');
    if (!result) return null;
    return textOf(result.result, result.response);
  },
  codex(raw) {
    const events = parseEvents(raw);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      const message = event?.msg ?? event?.item ?? event;
      const type = String(message?.type ?? '');
      const role = String(message?.role ?? '');
      if (role && role !== 'assistant') continue;
      if (type !== 'agent_message' && type !== 'assistant_message' && type !== 'message') continue;
      const text = textOf(message.message, message.text, message.content);
      if (text) return text;
    }
    return null;
  },
  opencode(raw) {
    const texts = [];
    for (const event of parseEvents(raw)) {
      if (event?.type === 'text' && event.role && event.role !== 'assistant') continue;
      const part = event?.part ?? event;
      const role = part?.role ?? part?.message?.role;
      if (role && role !== 'assistant') continue;
      if (event?.type !== 'text' && !part?.text) continue;
      const text = textOf(part?.text);
      if (text) texts.push(text);
    }
    return texts.length > 0 ? texts.join('\n') : null;
  },
  gemini(raw) {
    const parsed = safeJson(raw);
    if (typeof parsed?.response === 'string') return parsed.response;
    const parts = parsed?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      const joined = parts.map((part) => part?.text).filter((text) => typeof text === 'string');
      if (joined.length > 0) return joined.join('\n');
    }
    return null;
  },
  ollama(raw) {
    const parsed = safeJson(raw);
    return typeof parsed?.response === 'string' ? parsed.response : null;
  },
});

function collectVerdicts(value, engine, depth = 0, out = []) {
  if (depth > MAX_DEPTH || value === null || value === undefined) return out;

  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || text.length > MAX_PLAIN_TEXT) return out;
    const parsed = safeJson(text);
    if (parsed !== null) {
      collectVerdicts(parsed, engine, depth + 1, out);
      return out;
    }
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{') || line.startsWith('['));
    if (lines.length > 1) {
      for (const line of lines) collectVerdicts(line, engine, depth + 1, out);
      if (out.length > 0) return out;
    }
    const fenced = extractFencedJson(text);
    if (fenced && fenced !== text) collectVerdicts(fenced, engine, depth + 1, out);
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectVerdicts(item, engine, depth + 1, out);
    return out;
  }

  if (typeof value !== 'object') return out;
  if (looksLikeVerdict(value)) {
    out.push(normalizeDictamen(value, engine));
    return out;
  }
  for (const nested of Object.values(value)) collectVerdicts(nested, engine, depth + 1, out);
  return out;
}

function extractFencedJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1].trim()) return fenced[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) return text.slice(first, last + 1);
  return null;
}

function pickCandidate(candidates, nonce) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    const only = candidates[0];
    if (nonce && only.nonce && only.nonce !== nonce) return null;
    return only;
  }
  if (nonce) {
    const matching = candidates.filter((candidate) => candidate.nonce === nonce);
    if (matching.length > 0) return matching[matching.length - 1];
    const withoutNonce = candidates.filter((candidate) => !candidate.nonce);
    if (withoutNonce.length === candidates.length) return candidates[candidates.length - 1];
    return null;
  }
  return candidates[candidates.length - 1];
}

/**
 * Reads the verdict from the official assistant channel of the engine. JSON
 * echoed from the diff, tool output or user events is never considered.
 * When a run nonce is supplied, a candidate that carries a different nonce is
 * rejected as spoofed.
 */
export function extractJurorJson(rawStdout, engine = 'unknown', options = {}) {
  if (typeof rawStdout !== 'string') return null;
  const raw = rawStdout.trim();
  if (!raw) return null;
  const nonce = typeof options.nonce === 'string' ? options.nonce : '';

  const reader = ASSISTANT_TEXT[engine];
  const assistantText = reader ? reader(raw) : raw;
  if (assistantText) {
    const candidates = collectVerdicts(assistantText, engine);
    const picked = pickCandidate(candidates, nonce);
    if (picked) return picked;
  }
  if (reader) return null;

  const picked = pickCandidate(collectVerdicts(raw, engine), nonce);
  return picked;
}

export function errorDictamen({ engine, probe, author, reason }) {
  return {
    juror: { engine, probe: probe ?? '', author: author ?? '' },
    verdict: 'ERROR',
    severity: 'NONE',
    findings: [],
    summary: clean(reason),
  };
}

export function gateFor(counts, threshold = 'P1') {
  if (counts.P0 > 0) return 'BLOCK';
  if ((threshold === 'P1' || threshold === 'P2') && counts.P1 > 0) return 'BLOCK';
  if (threshold === 'P2' && counts.P2 > 0) return 'BLOCK';
  return 'PASS';
}

export function countSeverities(findings) {
  const counts = { P0: 0, P1: 0, P2: 0 };
  for (const finding of findings) {
    if (finding.severity in counts) counts[finding.severity] += 1;
  }
  return counts;
}

function sortFindings(findings) {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((left, right) => {
      const bySeverity = severityRank(left.finding.severity) - severityRank(right.finding.severity);
      if (bySeverity !== 0) return bySeverity;
      const byId = String(left.finding.id).localeCompare(String(right.finding.id));
      return byId !== 0 ? byId : left.index - right.index;
    })
    .map((entry) => entry.finding);
}

export function completedVerdicts(verdicts = []) {
  return verdicts.filter((dictamen) => dictamen && dictamen.verdict !== 'ERROR');
}

export function aggregate({
  verdicts = [],
  threshold = 'P1',
  author = '',
  jurors = [],
  probes = [],
  secretShield = { scanned: true, redactions: 0, leak: false },
  durationMs = 0,
  version = '0.1.0',
  generatedAt = new Date().toISOString(),
  note = '',
  limit = null,
} = {}) {
  const findings = [];
  const errors = [];

  for (const dictamen of verdicts) {
    if (!dictamen) continue;
    const engine = dictamen.juror?.engine ?? 'unknown';
    if (dictamen.verdict === 'ERROR') {
      errors.push({
        engine,
        probe: dictamen.juror?.probe ?? '',
        reason: clean(dictamen.summary ?? ''),
      });
      continue;
    }
    for (const finding of dictamen.findings ?? []) {
      findings.push({
        ...finding,
        title: clean(finding.title),
        evidence: clean(finding.evidence),
        suggestion: clean(finding.suggestion),
        juror: engine,
        probe: dictamen.juror?.probe ?? '',
      });
    }
  }

  const ordered = sortFindings(findings);
  const counts = countSeverities(ordered);
  const leak = Boolean(secretShield?.leak);
  const gate = leak ? 'BLOCK' : gateFor(counts, threshold);

  return {
    tool: 'cold-jury',
    version,
    author,
    jurors,
    probes,
    gate,
    exitCode: gate === 'BLOCK' ? 1 : 0,
    threshold,
    counts,
    secretShield: {
      scanned: secretShield?.scanned !== false,
      redactions: Number.isInteger(secretShield?.redactions) ? secretShield.redactions : 0,
      leak,
    },
    findings: ordered,
    errors,
    ...(note ? { note } : {}),
    ...(limit ? { limit } : {}),
    durationMs,
    generatedAt,
  };
}

/** Short circuit used when the shield matches a P0 pattern: no juror runs. */
export function secretLeakVerdict({
  author = '',
  jurors = [],
  probes = [],
  redactions = 0,
  threshold = 'P1',
  version = '0.1.0',
  durationMs = 0,
  generatedAt = new Date().toISOString(),
  note = '',
} = {}) {
  return {
    tool: 'cold-jury',
    version,
    author,
    jurors,
    probes,
    gate: 'BLOCK',
    exitCode: 1,
    threshold,
    counts: { P0: 1, P1: 0, P2: 0 },
    secretShield: { scanned: true, redactions, leak: true },
    findings: [secretLeakFinding()],
    errors: [],
    ...(note ? { note } : {}),
    durationMs,
    generatedAt,
  };
}
