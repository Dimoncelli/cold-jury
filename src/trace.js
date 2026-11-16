import { createHash } from 'node:crypto';

/**
 * AgentTrace normalisation and the four deterministic trace metrics.
 *
 * Accepts a single JSON object, a JSON array of steps or a .jsonl file (one JSON
 * step per line). Every string stays untrusted: callers must pass the raw text
 * through shield() first.
 */
const MAX_TEXT = 100_000;

function asText(value) {
  if (typeof value === 'string') return value.slice(0, MAX_TEXT);
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function asArguments(value) {
  if (value === undefined) return undefined;
  return value;
}

function normalizeToolCall(raw, index) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    id: typeof source.id === 'string' ? source.id : `TC-${String(index + 1).padStart(3, '0')}`,
    name: asText(source.name ?? source.tool ?? source.tool_name).trim(),
    arguments: asArguments(source.arguments ?? source.args ?? source.input),
    ...(source.ok === undefined ? {} : { ok: source.ok === true }),
    ...(source.error ? { error: asText(source.error) } : {}),
    ...(source.result === undefined ? {} : { result: source.result }),
  };
}

function normalizeMessage(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const message = {
    role: asText(source.role).trim().toLowerCase() || 'unknown',
    content: asText(source.content ?? source.text),
  };
  const calls = Array.isArray(source.tool_calls) ? source.tool_calls : source.tool_call ? [source.tool_call] : [];
  if (calls.length > 0) message.tool_calls = calls;
  if (source.name) message.name = asText(source.name);
  return message;
}

function unusable() {
  return new Error('trace_unusable: invalid JSON or structure');
}

function assertArrayField(root, field) {
  if (root && root[field] !== undefined && !Array.isArray(root[field])) throw unusable();
}

function parseDocument(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    assertArrayField(raw, 'messages');
    assertArrayField(raw, 'tool_calls');
    return { root: raw, items: [raw] };
  }
  if (Array.isArray(raw)) return { root: null, items: raw };

  const text = String(raw ?? '').trim();
  if (!text) throw unusable();

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return { root: null, items: parsed };
    if (parsed && typeof parsed === 'object') {
      assertArrayField(parsed, 'messages');
      assertArrayField(parsed, 'tool_calls');
      return { root: parsed, items: [parsed] };
    }
    // A scalar (42, "text", true) is not a trace.
    throw unusable();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('trace_unusable')) throw error;
    // fall through to JSONL
  }

  const items = [];
  const lines = text.split(String.fromCharCode(10));
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // One broken line makes the whole document unusable: never score half a trace.
      throw unusable();
    }
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw unusable();
      }
      items.push(...parsed);
    } else if (parsed && typeof parsed === 'object') {
      items.push(parsed);
    } else {
      throw unusable();
    }
  }
  if (items.length === 0) throw unusable();
  return { root: null, items };
}

function hashTrace(messages, tool_calls, ground_truth) {
  const canonical = JSON.stringify({ messages, tool_calls, ground_truth });
  return `trace-${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

export function normalizeTrace(raw) {
  const { root, items } = parseDocument(raw);
  const messages = [];
  const messageCalls = [];
  const declaredCalls = [];
  const stepCalls = [];

  for (const message of Array.isArray(root?.messages) ? root.messages : []) {
    const normalized = normalizeMessage(message);
    messages.push(normalized);
    if (Array.isArray(normalized.tool_calls)) {
      for (const call of normalized.tool_calls) messageCalls.push(normalizeToolCall(call, messageCalls.length));
    }
  }
  for (const call of Array.isArray(root?.tool_calls) ? root.tool_calls : []) {
    declaredCalls.push(normalizeToolCall(call, declaredCalls.length));
  }

  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (root && item === root) continue;
    const step = item.step && typeof item.step === 'object' ? item.step : item;
    const counts = [];
    if (step.tool_call && typeof step.tool_call === 'object') counts.push(step.tool_call);
    if (Array.isArray(step.tool_calls)) counts.push(...step.tool_calls);
    for (const call of counts) stepCalls.push(normalizeToolCall(call, stepCalls.length));

    const hasEnvelope = Boolean(step.role) || step.content !== undefined || step.text !== undefined;
    if (hasEnvelope) {
      const normalized = normalizeMessage(step);
      if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) normalized.tool_calls = step.tool_calls;
      messages.push(normalized);
    } else if (counts.length > 0) {
      // A bare JSONL step is one assistant turn that made these calls.
      messages.push({ role: 'assistant', content: '', tool_calls: counts });
    }
  }

  // Message-embedded calls win; a top-level list is the fallback for flat traces.
  const tool_calls = messageCalls.length > 0 ? [...messageCalls, ...stepCalls] : [...declaredCalls, ...stepCalls];
  const groundTruth = root?.ground_truth && typeof root.ground_truth === 'object' ? root.ground_truth : null;

  return {
    trace_id: asText(root?.trace_id).trim() || hashTrace(messages, tool_calls, groundTruth),
    messages,
    tool_calls,
    ground_truth: groundTruth,
  };
}

export function clamp01(n) {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}

function round4(n) {
  return Math.round(clamp01(n) * 10_000) / 10_000;
}

function isInvalidCall(call) {
  if (call.ok === false) return true;
  if (typeof call.error === 'string' && call.error.trim() !== '') return true;
  if (call.arguments !== undefined && call.arguments !== null) {
    if (typeof call.arguments !== 'object' || Array.isArray(call.arguments)) return true;
  }
  return false;
}

function turnsOf(trace) {
  // A turn is an assistant message that actually called a tool, not a final text reply.
  const withCalls = trace.messages.filter(
    (message) => message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
  );
  if (withCalls.length > 0) return withCalls.length;
  return trace.tool_calls.length;
}

export function computeMetrics(trace) {
  const calls = Array.isArray(trace?.tool_calls) ? trace.tool_calls : [];
  const total = calls.length;
  const groundTruth = trace?.ground_truth ?? null;
  const requiredTools = Array.isArray(groundTruth?.required_tools) ? groundTruth.required_tools.map(String) : null;
  const requiredSteps = Array.isArray(groundTruth?.required_steps) ? groundTruth.required_steps.map(String) : null;
  const minTurns = Number.isInteger(groundTruth?.min_turns) ? groundTruth.min_turns : null;

  let toolSelection;
  if (requiredTools) {
    toolSelection = total === 0 ? 0 : calls.filter((call) => requiredTools.includes(call.name)).length / total;
  } else {
    toolSelection = total === 0 ? 1 : 1 - calls.filter(isInvalidCall).length / total;
  }

  const mcpCompliance = total === 0 ? 1 : 1 - calls.filter(isInvalidCall).length / total;

  const turns = turnsOf(trace);
  let turnEfficiency;
  if (minTurns) {
    turnEfficiency = clamp01(minTurns / Math.max(turns, 1));
  } else {
    const seen = new Set();
    let redundant = 0;
    for (const call of calls) {
      const key = `${call.name}:${JSON.stringify(call.arguments ?? null)}`;
      if (seen.has(key)) redundant += 1;
      else seen.add(key);
    }
    turnEfficiency = 1 - redundant / Math.max(turns, 1);
  }

  let workflowCompletion;
  if (requiredSteps) {
    const pool = new Set([
      ...calls.map((call) => call.name),
      ...trace.messages.map((message) => message.content.trim()).filter(Boolean),
    ]);
    workflowCompletion = requiredSteps.filter((step) => pool.has(step)).length / requiredSteps.length;
  } else {
    workflowCompletion = 1;
  }

  return {
    tool_selection_accuracy: round4(toolSelection),
    mcp_compliance: round4(mcpCompliance),
    turn_efficiency: round4(turnEfficiency),
    workflow_completion: round4(workflowCompletion),
  };
}

export { isInvalidCall };
