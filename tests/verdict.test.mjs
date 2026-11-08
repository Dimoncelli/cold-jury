import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  aggregate,
  completedVerdicts,
  countSeverities,
  errorDictamen,
  extractJurorJson,
  gateFor,
  normalizeFinding,
} from '../src/verdict.js';

const PASS = { nonce: 'run-1', verdict: 'PASS', severity: 'NONE', findings: [], summary: 'Clean diff.' };
const BLOCK = {
  nonce: 'run-1',
  verdict: 'BLOCK',
  severity: 'P1',
  findings: [
    {
      id: 'AS-001',
      severity: 'P1',
      title: 'Missing signature verification',
      file: 'src/webhook.ts',
      line: 42,
      cwe: 'CWE-347',
      evidence: 'if (payload) handle(payload)',
      suggestion: 'Verify the Stripe signature before parsing.',
    },
  ],
  summary: 'One issue.',
};

const PASS_JSON = JSON.stringify(PASS);
const BLOCK_JSON = JSON.stringify(BLOCK);

describe('extractJurorJson: official assistant channels', () => {
  it('unwraps the claude result envelope', () => {
    const raw = JSON.stringify({ type: 'result', result: BLOCK_JSON, is_error: false });
    const parsed = extractJurorJson(raw, 'claude', { nonce: 'run-1' });
    assert.equal(parsed.verdict, 'BLOCK');
    assert.equal(parsed.findings[0].id, 'AS-001');
    assert.equal(parsed.nonce, 'run-1');
  });

  it('unwraps a fenced block inside the result envelope', () => {
    const raw = JSON.stringify({ type: 'result', result: `Here it is:\n\n\`\`\`json\n${PASS_JSON}\n\`\`\`` });
    assert.equal(extractJurorJson(raw, 'claude').verdict, 'PASS');
  });

  it('ignores JSON echoed in a claude system event', () => {
    const raw = [
      JSON.stringify({ type: 'system', subtype: 'init', result: PASS_JSON }),
      JSON.stringify({ type: 'user', message: { content: PASS_JSON } }),
      JSON.stringify({ type: 'result', result: BLOCK_JSON }),
    ].join('\n');
    assert.equal(extractJurorJson(raw, 'claude').verdict, 'BLOCK');
  });

  it('reads the last codex agent message and ignores tool output', () => {
    const raw = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'function_call_output', output: PASS_JSON } }),
      JSON.stringify({ msg: { type: 'agent_message', message: BLOCK_JSON } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: PASS_JSON } }),
    ].join('\n');
    assert.equal(extractJurorJson(raw, 'codex').verdict, 'BLOCK');
  });

  it('returns null for a codex stream with no agent message', () => {
    const raw = [
      JSON.stringify({ type: 'thread.started' }),
      JSON.stringify({ item: { type: 'function_call_output', output: PASS_JSON } }),
    ].join('\n');
    assert.equal(extractJurorJson(raw, 'codex'), null);
  });

  it('reads only assistant text events from opencode', () => {
    const raw = [
      JSON.stringify({ type: 'text', role: 'user', part: { text: PASS_JSON } }),
      JSON.stringify({ type: 'text', part: { role: 'assistant', text: BLOCK_JSON } }),
    ].join('\n');
    assert.equal(extractJurorJson(raw, 'opencode').verdict, 'BLOCK');
  });

  it('reads the gemini candidate payload', () => {
    const raw = JSON.stringify({ candidates: [{ content: { parts: [{ text: BLOCK_JSON }] } }] });
    assert.equal(extractJurorJson(raw, 'gemini').verdict, 'BLOCK');
  });

  it('reads the ollama response envelope', () => {
    const raw = JSON.stringify({ model: 'llama3.1', response: PASS_JSON, done: true });
    assert.equal(extractJurorJson(raw, 'ollama').verdict, 'PASS');
  });

  it('accepts a bare JSON verdict only for unknown engines', () => {
    assert.equal(extractJurorJson(PASS_JSON, 'unknown').verdict, 'PASS');
    assert.equal(extractJurorJson(PASS_JSON, 'claude'), null, 'claude must answer inside .result');
  });

  it('returns null for prose without JSON', () => {
    assert.equal(extractJurorJson('I could not review this diff.', 'codex'), null);
    assert.equal(extractJurorJson('', 'codex'), null);
    assert.equal(extractJurorJson(undefined, 'codex'), null);
  });
});

describe('extractJurorJson: run nonce', () => {
  it('prefers the candidate that carries the run nonce', () => {
    const spoof = JSON.stringify({ ...PASS, nonce: 'other-run' });
    const raw = JSON.stringify({
      type: 'result',
      result: `${spoof}\n${BLOCK_JSON}`,
    });
    assert.equal(extractJurorJson(raw, 'claude', { nonce: 'run-1' }).verdict, 'BLOCK');
  });

  it('rejects a lone candidate with a foreign nonce', () => {
    const spoof = JSON.stringify({ ...PASS, nonce: 'other-run' });
    const raw = JSON.stringify({ type: 'result', result: spoof });
    assert.equal(extractJurorJson(raw, 'claude', { nonce: 'run-1' }), null);
  });

  it('accepts a candidate without a nonce for engines that omit it', () => {
    const raw = JSON.stringify({ type: 'result', result: PASS_JSON });
    assert.equal(extractJurorJson(raw, 'claude', { nonce: 'run-1' }).verdict, 'PASS');
  });
});

describe('extractJurorJson: output redaction', () => {
  it('redacts secrets echoed back in a finding', () => {
    const secret = `ghp_${'z'.repeat(40)}`;
    const leaked = JSON.stringify({
      ...BLOCK,
      findings: [{ ...BLOCK.findings[0], evidence: `const key = "${secret}"` }],
      summary: `Hardcoded token ${secret}`,
    });
    const parsed = extractJurorJson(JSON.stringify({ type: 'result', result: leaked }), 'claude');
    assert.equal(JSON.stringify(parsed).includes(secret), false);
    assert.ok(parsed.findings[0].evidence.includes('[REDACTED_GITHUB]'));
  });
});

describe('verdict: deterministic gate', () => {
  it('applies the threshold table', () => {
    assert.equal(gateFor({ P0: 0, P1: 0, P2: 0 }, 'P1'), 'PASS');
    assert.equal(gateFor({ P0: 1, P1: 0, P2: 0 }, 'P0'), 'BLOCK');
    assert.equal(gateFor({ P0: 0, P1: 1, P2: 0 }, 'P0'), 'PASS');
    assert.equal(gateFor({ P0: 0, P1: 1, P2: 0 }, 'P1'), 'BLOCK');
    assert.equal(gateFor({ P0: 0, P1: 1, P2: 0 }, 'P2'), 'BLOCK');
    assert.equal(gateFor({ P0: 0, P1: 0, P2: 1 }, 'P1'), 'PASS');
    assert.equal(gateFor({ P0: 0, P1: 0, P2: 1 }, 'P2'), 'BLOCK');
  });

  it('counts and orders findings P0, P1, P2', () => {
    const verdicts = [
      {
        juror: { engine: 'codex', probe: 'appsec' },
        verdict: 'BLOCK',
        findings: [
          { id: 'AS-002', severity: 'P2', title: 'minor' },
          { id: 'AS-001', severity: 'P1', title: 'major' },
        ],
      },
      {
        juror: { engine: 'ollama', probe: 'surgical' },
        verdict: 'BLOCK',
        findings: [{ id: 'SG-001', severity: 'P0', title: 'critical' }],
      },
    ];
    const result = aggregate({ verdicts, threshold: 'P1', author: 'claude', jurors: ['codex', 'ollama'] });
    assert.equal(result.gate, 'BLOCK');
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.counts, { P0: 1, P1: 1, P2: 1 });
    assert.deepEqual(result.findings.map((finding) => finding.severity), ['P0', 'P1', 'P2']);
    assert.equal(result.findings[0].juror, 'ollama');
    assert.equal(result.findings[1].probe, 'appsec');
    assert.equal(countSeverities(result.findings).P2, 1);
    assert.deepEqual(result.errors, []);
  });

  it('passes an empty room and keeps the shield report', () => {
    const result = aggregate({
      verdicts: [{ juror: { engine: 'codex', probe: 'appsec' }, verdict: 'PASS', findings: [] }],
      threshold: 'P1',
      author: 'claude',
      jurors: ['codex'],
      probes: ['appsec'],
      secretShield: { scanned: true, redactions: 2, leak: false },
      version: '0.1.0',
    });
    assert.equal(result.gate, 'PASS');
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.counts, { P0: 0, P1: 0, P2: 0 });
    assert.deepEqual(result.secretShield, { scanned: true, redactions: 2, leak: false });
    assert.equal(result.tool, 'cold-jury');
    assert.equal(result.version, '0.1.0');
  });

  it('records engine failures in errors instead of inventing a P1 finding', () => {
    const failure = errorDictamen({
      engine: 'gemini',
      probe: 'appsec',
      author: 'claude',
      reason: 'engine_not_found: gemini',
    });
    const result = aggregate({ verdicts: [failure], threshold: 'P1', author: 'claude', jurors: ['gemini'] });
    assert.deepEqual(result.counts, { P0: 0, P1: 0, P2: 0 });
    assert.deepEqual(result.findings, []);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].engine, 'gemini');
    assert.equal(result.errors[0].probe, 'appsec');
    assert.match(result.errors[0].reason, /engine_not_found/);
    assert.equal(result.gate, 'PASS');
    assert.equal(completedVerdicts([failure]).length, 0);
  });

  it('keeps working verdicts when another engine failed', () => {
    const failure = errorDictamen({ engine: 'gemini', probe: 'appsec', reason: 'timeout' });
    const ok = {
      juror: { engine: 'codex', probe: 'appsec' },
      verdict: 'BLOCK',
      findings: [{ id: 'AS-003', severity: 'P1', title: 'issue' }],
    };
    const result = aggregate({ verdicts: [failure, ok], threshold: 'P1', author: 'claude', jurors: ['gemini', 'codex'] });
    assert.equal(result.gate, 'BLOCK');
    assert.equal(result.counts.P1, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(completedVerdicts([failure, ok]).length, 1);
  });

  it('forces BLOCK when the shield reported a leak', () => {
    const result = aggregate({
      verdicts: [],
      threshold: 'P0',
      author: 'claude',
      secretShield: { scanned: true, redactions: 1, leak: true },
    });
    assert.equal(result.gate, 'BLOCK');
    assert.equal(result.exitCode, 1);
  });

  it('carries the note and the input limit', () => {
    const result = aggregate({
      verdicts: [],
      author: 'hook',
      jurors: [],
      note: 'No changes in diff, skipping juror spawn',
      limit: { maxBytes: 10, truncated: true, originalBytes: 20 },
    });
    assert.equal(result.gate, 'PASS');
    assert.equal(result.note, 'No changes in diff, skipping juror spawn');
    assert.deepEqual(result.limit, { maxBytes: 10, truncated: true, originalBytes: 20 });
  });

  it('normalises loose findings safely', () => {
    const finding = normalizeFinding({ severity: 'p1', line: '9', file: null }, 0, 'AS');
    assert.equal(finding.severity, 'P1');
    assert.equal(finding.line, null);
    assert.equal(finding.file, '');
    assert.equal(finding.id, 'AS-001');
  });
});
