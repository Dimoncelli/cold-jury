import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clamp01, computeMetrics, normalizeTrace } from '../src/trace.js';

const CALLS = [
  { name: 'search', arguments: { q: 'invoices' } },
  { name: 'search', arguments: { q: 'payments' } },
  { name: 'calc', arguments: { expression: '1+1' } },
];

function traceWith(calls, extra = {}) {
  return normalizeTrace({ tool_calls: calls, ...extra });
}

describe('trace: normalisation', () => {
  it('accepts an object, an array of steps and a .jsonl document with the same calls', () => {
    const object = normalizeTrace({ tool_calls: CALLS });
    const array = normalizeTrace(CALLS.map((call) => ({ tool_call: call })));
    const jsonl = normalizeTrace(CALLS.map((call) => JSON.stringify({ tool_call: call })).join('\n'));

    const names = (trace) => trace.tool_calls.map((call) => call.name);
    assert.deepEqual(names(object), ['search', 'search', 'calc']);
    assert.deepEqual(names(array), names(object));
    assert.deepEqual(names(jsonl), names(object));
    assert.equal(object.trace_id.length > 0, true);
  });

  it('derives a deterministic trace_id from the content', () => {
    const first = normalizeTrace({ tool_calls: CALLS });
    const second = normalizeTrace({ tool_calls: CALLS });
    assert.equal(first.trace_id, second.trace_id);
    assert.match(first.trace_id, /^trace-[0-9a-f]{16}$/);
  });

  it('keeps ground truth and message roles', () => {
    const trace = normalizeTrace({
      messages: [
        { role: 'user', content: 'busca facturas' },
        { role: 'assistant', content: 'ok', tool_calls: [CALLS[0]] },
      ],
      ground_truth: { required_tools: ['search'], min_turns: 1 },
    });
    assert.equal(trace.messages.length, 2);
    assert.deepEqual(trace.ground_truth.required_tools, ['search']);
    assert.equal(trace.tool_calls.length, 1);
  });
});

describe('trace: deterministic metrics', () => {
  it('scores tool selection against required_tools', () => {
    assert.equal(computeMetrics(traceWith(CALLS, { ground_truth: { required_tools: ['search'] } })).tool_selection_accuracy, 0.6667);
  });

  it('scores tool selection by valid calls when no ground truth exists', () => {
    const metrics = computeMetrics(traceWith([CALLS[0], { name: 'boom', arguments: {}, ok: false }]));
    assert.equal(metrics.tool_selection_accuracy, 0.5);
  });

  it('scores MCP compliance and treats an empty trace as compliant', () => {
    const metrics = computeMetrics(traceWith([CALLS[0], { name: 'fail', arguments: {}, error: 'timeout' }]));
    assert.equal(metrics.mcp_compliance, 0.5);
    assert.equal(computeMetrics(traceWith([])).mcp_compliance, 1);
    assert.equal(computeMetrics(traceWith([{ name: 'bad', arguments: 'not-an-object' }])).mcp_compliance, 0);
  });

  it('scores turn efficiency against min_turns', () => {
    const turns = Array.from({ length: 4 }, (_, index) => ({
      role: 'assistant',
      content: '',
      tool_calls: [{ name: `step-${index}`, arguments: { index } }],
    }));
    const trace = normalizeTrace({ messages: turns, ground_truth: { min_turns: 2 } });
    assert.equal(computeMetrics(trace).turn_efficiency, 0.5);
  });

  it('penalises redundant calls when min_turns is absent', () => {
    const repeated = { name: 'search', arguments: { q: 'same' } };
    const trace = normalizeTrace({
      messages: [
        { role: 'assistant', tool_calls: [repeated] },
        { role: 'assistant', tool_calls: [repeated] },
        { role: 'assistant', tool_calls: [CALLS[2]] },
      ],
    });
    assert.equal(computeMetrics(trace).turn_efficiency, 0.6667);
  });

  it('scores workflow completion against required_steps', () => {
    const trace = normalizeTrace({
      messages: [
        { role: 'assistant', tool_calls: [{ name: 'a', arguments: {} }] },
        { role: 'assistant', tool_calls: [{ name: 'b', arguments: {} }] },
      ],
      ground_truth: { required_steps: ['a', 'b', 'c'] },
    });
    assert.equal(computeMetrics(trace).workflow_completion, 0.6667);
    assert.equal(computeMetrics(traceWith(CALLS)).workflow_completion, 1);
  });

  it('is deterministic and clamps out-of-range values', () => {
    const trace = traceWith(CALLS, { ground_truth: { required_tools: ['search'] } });
    assert.deepEqual(computeMetrics(trace), computeMetrics(trace));
    assert.equal(clamp01(-3), 0);
    assert.equal(clamp01(7), 1);
    assert.equal(clamp01(Number.NaN), 0);
  });
});

describe('trace: fail-closed input', () => {
  const CASES = [
    ['empty string', ''],
    ['truncated JSON', '{"trace_id": "broken",'],
    ['scalar', '42'],
    ['non-array messages', '{"messages":"not-an-array"}'],
    ['non-array tool_calls', '{"tool_calls":{}}'],
    ['broken jsonl line', '{"role":"assistant"}\n{"broken"\n'],
  ];

  for (const [label, input] of CASES) {
    it('rejects ' + label, () => {
      assert.throws(() => normalizeTrace(input), /trace_unusable: invalid JSON or structure/);
    });
  }

  it('accepts a valid JSONL document', () => {
    const trace = normalizeTrace('{"tool_call":{"name":"search","arguments":{}}}\n{"role":"user","content":"hola"}');
    assert.equal(trace.tool_calls.length, 1);
  });
});

describe('trace: turns count only tool-calling assistant messages', () => {
  it('ignores a final text-only assistant reply', () => {
    const trace = normalizeTrace({
      messages: [
        { role: 'user', content: 'busca' },
        { role: 'assistant', content: '', tool_calls: [{ name: 'search', arguments: { q: 'x' } }] },
        { role: 'assistant', content: 'Listo, la factura está pagada.' },
      ],
    });
    assert.equal(computeMetrics(trace).turn_efficiency, 1);
  });

  it('falls back to the number of tool calls when no assistant message carries them', () => {
    const trace = normalizeTrace({ tool_calls: [{ name: 'a', arguments: {} }, { name: 'b', arguments: {} }], ground_truth: { min_turns: 1 } });
    assert.equal(computeMetrics(trace).turn_efficiency, 0.5);
  });
});
