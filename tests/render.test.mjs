import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findingLocation, renderDoctor, renderJson, renderTable, renderTrace, stripControl, truncateLeft } from '../src/render.js';

function verdict(overrides = {}) {
  return {
    tool: 'cold-jury',
    version: '0.1.0',
    author: 'claude',
    jurors: ['codex', 'opencode'],
    probes: ['appsec'],
    gate: 'BLOCK',
    exitCode: 1,
    threshold: 'P1',
    counts: { P0: 0, P1: 1, P2: 0 },
    secretShield: { scanned: true, redactions: 0, leak: false },
    findings: [
      {
        id: 'AS-001',
        severity: 'P1',
        juror: 'codex',
        probe: 'appsec',
        title: 'Missing signature check',
        file: 'src/webhook.ts',
        line: 42,
      },
    ],
    errors: [],
    durationMs: 10,
    generatedAt: '2026-11-08T09:32:00.000Z',
    ...overrides,
  };
}

describe('render: control characters', () => {
  it('strips ANSI escapes and C0/C1 bytes', () => {
    assert.equal(stripControl('\u001b[31mred\u001b[0m'), 'red');
    assert.equal(stripControl('bad\u0000byte'), 'bad byte');
    assert.equal(stripControl('bell\u0007'), 'bell ');
    assert.equal(stripControl('c1\u0085next'), 'c1 next');
  });

  it('strips a hostile juror title before it reaches the terminal', () => {
    const hostile = verdict({
      findings: [
        {
          severity: 'P1',
          juror: 'codex\u001b[2J',
          probe: 'appsec',
          title: '\u001b[31mowned\u001b[0m',
          file: '\u001b]0;pwn\u0007src/app.ts',
          line: 7,
        },
      ],
    });
    const text = renderTable(hostile, { color: false, columns: 88 });
    assert.equal(text.includes('\u001b[31m'), false);
    assert.equal(text.includes('\u0007'), false);
    assert.ok(text.includes('owned'));
  });
});

describe('render: width and truncation', () => {
  it('keeps every line inside the terminal width', () => {
    for (const columns of [80, 88, 100, 120]) {
      const text = renderTable(verdict(), { color: false, columns });
      for (const line of text.split('\n')) {
        assert.ok(line.length <= columns, `${line.length} > ${columns}: ${line}`);
      }
    }
  });

  it('truncates long paths from the left, keeping the file name and line', () => {
    assert.equal(truncateLeft('src/deeply/nested/folder/webhook.ts:42', 20), '…older/webhook.ts:42');
    assert.equal(truncateLeft('short.ts:1', 20), 'short.ts:1');
    assert.equal(findingLocation({ file: 'src/a.ts', line: 3 }), 'src/a.ts:3');
    assert.equal(findingLocation({ file: '', line: null }), '-');
  });

  it('never emits ANSI when colour is off', () => {
    const text = renderTable(verdict(), { color: false });
    assert.equal(text.includes('\u001b['), false);
    assert.ok(text.includes('VERDICT: BLOCK (exit 1) | P0 0 | P1 1 | P2 0'));
  });

  it('emits ANSI only when colour is on', () => {
    const text = renderTable(verdict(), { color: true });
    assert.ok(text.includes('\u001b['));
    assert.ok(text.includes('VERDICT: BLOCK'));
  });

  it('lists engine errors and the input limit', () => {
    const text = renderTable(
      verdict({
        errors: [{ engine: 'gemini', probe: 'appsec', reason: 'engine_not_found: gemini' }],
        note: 'No changes in diff, skipping juror spawn',
        limit: { maxBytes: 1000, truncated: true, originalBytes: 4000 },
      }),
      { color: false, columns: 100 },
    );
    assert.ok(text.includes('ENGINE ERROR: gemini/appsec'));
    assert.ok(text.includes('NOTE: No changes in diff'));
    assert.ok(text.includes('LIMIT: input truncated to 1000 bytes (4000 before)'));
  });
});

describe('render: doctor table', () => {
  it('aligns READY, OFFLINE and NOT_FOUND', () => {
    const text = renderDoctor(
      [
        { engine: 'claude', status: 'READY', path: '/bin/claude.exe' },
        { engine: 'ollama', status: 'OFFLINE', path: '/bin/ollama.exe' },
        { engine: 'codex', status: 'NOT_FOUND', path: '' },
      ],
      { color: false },
    );
    const lines = text.split('\n');
    assert.equal(lines.length, 4);
    assert.match(lines[0], /GATEWAY/);
    assert.match(lines[1], /^claude\s+READY\s+no\s+\/bin\/claude\.exe$/);
    assert.match(lines[2], /^ollama\s+OFFLINE\s+no\s+\/bin\/ollama\.exe$/);
    assert.match(lines[3], /^codex\s+NOT_FOUND\s+no\s+-$/);
  });
});

describe('render: trace verdict', () => {
  const TRACE_VERDICT = {
    tool: 'cold-jury',
    version: '0.2.0',
    trace_id: 'trace-abc123',
    verdict: 'BLOCK',
    severity: 'P1',
    exitCode: 1,
    metrics: {
      tool_selection_accuracy: 0.6667,
      mcp_compliance: 0.5,
      turn_efficiency: 0.5,
      workflow_completion: 0.6667,
    },
    probes: {
      delegation_quality: { verdict: 'PASS', severity: 'NONE', findings: [] },
      prompt_injection_detection: { verdict: 'BLOCK', severity: 'P1', findings: [] },
    },
    findings: [{ id: 'PI-001', probe: 'prompt_injection_detection', severity: 'P1', title: 'Injected instruction obeyed' }],
    secretShield: { scanned: true, redactions: 0, leak: false },
  };

  it('renders the trace id, the four metrics with two decimals and the verdict', () => {
    const text = renderTrace(TRACE_VERDICT);
    assert.match(text, /trace-abc123/);
    assert.match(text, /tool selection accuracy\s+0\.67/);
    assert.match(text, /MCP compliance\s+0\.50/);
    assert.match(text, /turn efficiency\s+0\.50/);
    assert.match(text, /workflow completion\s+0\.67/);
    assert.match(text, /VERDICT: BLOCK/);
    assert.match(text, /PI-001/);
    assert.match(text, /SECRET SHIELD: CLEAN/);
  });

  it('serialises the aggregate as parseable JSON', () => {
    const parsed = JSON.parse(renderJson(TRACE_VERDICT));
    assert.equal(parsed.verdict, 'BLOCK');
    assert.equal(parsed.metrics.mcp_compliance, 0.5);
  });
});

describe('render: doctor gateway column', () => {
  it('marks gateway availability per engine', () => {
    const text = renderDoctor(
      [
        { engine: 'claude', status: 'READY', path: '/bin/claude.exe', gateway: true },
        { engine: 'ollama', status: 'READY', path: '/bin/ollama.exe', gateway: false },
      ],
      { color: false },
    );
    const lines = text.split('\n');
    assert.match(lines[1], /^claude\s+READY\s+yes\s+/);
    assert.match(lines[2], /^ollama\s+READY\s+no\s+/);
  });
});
