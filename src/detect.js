import { resolveBinary } from './resolve.js';

export const ENGINES = Object.freeze(['claude', 'codex', 'gemini', 'opencode', 'ollama']);
export const NEUTRAL_AUTHORS = Object.freeze(['hook', 'ci']);
export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
export const OLLAMA_PROBE_MS = 600;

const ENV_SIGNATURES = Object.freeze([
  { engine: 'claude', keys: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE'] },
  { engine: 'codex', keys: ['CODEX_CLI'] },
  { engine: 'gemini', keys: ['GEMINI_CLI'] },
  { engine: 'opencode', keys: ['OPENCODE_TTY'] },
]);

/** Author detection is env based and never guesses from installed binaries. */
export function detectAuthor(env = process.env) {
  for (const signature of ENV_SIGNATURES) {
    for (const key of signature.keys) {
      if (env[key]) return signature.engine;
    }
  }
  const opencodeKey = Object.keys(env).find((key) => key.startsWith('OPENCODE_') && env[key]);
  return opencodeKey ? 'opencode' : null;
}

export function isNeutralAuthor(author) {
  return NEUTRAL_AUTHORS.includes(author);
}

/** Short HTTP probe so a binary with a stopped daemon is not reported as READY. */
export async function ollamaDaemonReachable(options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? OLLAMA_BASE_URL).replace(/\/$/, '');
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : OLLAMA_PROBE_MS;
  if (typeof fetchImpl !== 'function') return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/api/tags`, { signal: controller.signal });
    return Boolean(response?.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves every engine: READY when it can actually answer, NOT_FOUND when the
 * binary is missing and OFFLINE when the binary exists but its daemon is down.
 */
export async function doctor(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform;
  const resolveImpl = options.resolveBinary ?? resolveBinary;
  const probe = options.ollamaProbe;

  const reports = ENGINES.map((engine) => {
    const plan = resolveImpl(engine, { env, platform });
    return {
      engine,
      status: plan ? 'READY' : 'NOT_FOUND',
      command: plan?.command ?? '',
      path: plan?.source ?? plan?.command ?? '',
    };
  });

  const ollama = reports.find((report) => report.engine === 'ollama');
  if (ollama && ollama.status === 'READY') {
    const reachable = probe
      ? await probe()
      : await ollamaDaemonReachable({
          fetch: options.fetch,
          baseUrl: options.ollamaBaseUrl,
          timeoutMs: options.ollamaProbeMs,
        });
    if (!reachable) ollama.status = 'OFFLINE';
  }

  return reports;
}

export function readyEngines(reports = []) {
  return reports.filter((report) => report.status === 'READY').map((report) => report.engine);
}

/**
 * Default pool order. Claude reviews other models best in the cross-model
 * evidence, so it goes first whenever it is not the author.
 */
export function prioritizeJurors(engines, author) {
  const unique = [...new Set(engines)];
  if (author === 'claude') return unique;
  const claude = unique.filter((engine) => engine === 'claude');
  return [...claude, ...unique.filter((engine) => engine !== 'claude')];
}
