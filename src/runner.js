import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { quoteWindowsArg, resolveBinary } from './resolve.js';
import { buildPrompt } from './probes.js';
import { redactText } from './shield.js';
import { errorDictamen, extractJurorJson } from './verdict.js';

const BASE_ENV_KEYS = Object.freeze([
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'TMP',
  'TEMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'SHELL',
]);

const ENGINE_ENV_PREFIXES = Object.freeze({
  claude: ['ANTHROPIC_', 'CLAUDE_'],
  codex: ['OPENAI_', 'CODEX_'],
  gemini: ['GEMINI_', 'GOOGLE_'],
  opencode: ['OPENCODE_'],
  ollama: ['OLLAMA_'],
});

/**
 * The sterile room gets a minimal environment: the OS basics, NO_COLOR and only
 * the variables owned by the engine being called. Nothing else leaks in.
 */
export function sanitizeEnv(engine, source = process.env) {
  const env = {};
  for (const key of BASE_ENV_KEYS) {
    if (source?.[key] !== undefined) env[key] = source[key];
  }
  for (const prefix of ENGINE_ENV_PREFIXES[engine] ?? []) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (key.startsWith(prefix)) env[key] = value;
    }
  }
  env.NO_COLOR = '1';
  return env;
}

export function buildArgv(plan, args = []) {
  const base = Array.isArray(plan?.prefixArgs) ? [...plan.prefixArgs] : [];
  if (plan?.wrapper === 'cmd') return [...base, ...args.map(quoteWindowsArg)];
  return [...base, ...args];
}

function killTree(child) {
  try {
    child.kill('SIGKILL');
  } catch {
    /* the child is already gone */
  }
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = nodeSpawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.unref?.();
    } catch {
      /* best effort: the direct kill above already ran */
    }
  }
}

/**
 * spawn with an argv array and shell disabled. The prompt only ever travels on
 * stdin, so it stays out of `ps`, Process Explorer and argv length limits.
 */
export function runProcess(plan, options = {}) {
  const args = options.args ?? [];
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 120_000;
  const spawnImpl = options.spawn ?? nodeSpawn;
  const argv = buildArgv(plan, args);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(plan.command, argv, {
        shell: false,
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: options.env,
      });
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: String(error?.message ?? error),
        timedOut: false,
        spawnError: true,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      finish({
        code: null,
        signal: null,
        stdout,
        stderr: stderr || String(error?.message ?? error),
        timedOut,
        spawnError: true,
      });
    });
    child.on('close', (code, signal) => {
      finish({ code, signal, stdout, stderr, timedOut, spawnError: false });
    });

    if (child.stdin) {
      child.stdin.on('error', () => {
        /* a closed stdin is reported through the exit code */
      });
      child.stdin.end(options.stdin ?? '');
    }
  });
}

export function createSterileRoom(engine = 'juror') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cold-jury-${engine}-`));
}

export function destroySterileRoom(directory) {
  if (!directory) return;
  fs.rmSync(directory, { recursive: true, force: true });
}

function exitReason(result, timeoutMs) {
  if (result.timedOut) return `timeout after ${timeoutMs}ms`;
  if (result.spawnError) return 'spawn_failed';
  if (typeof result.code === 'number' && result.code !== 0) return `engine_exit_${result.code}`;
  return 'no_verdict';
}

/** Shared executor: resolve, spawn, unwrap the engine envelope, never leak stderr. */
export async function runSpawnEngine(config) {
  const engine = config.engine;
  const probe = config.probe;
  const author = config.author ?? '';
  const nonce = config.nonce ?? '';
  const timeoutMs = config.timeoutMs ?? 120_000;
  const deps = config.deps ?? {};
  const resolveImpl = deps.resolveBinary ?? resolveBinary;
  const runImpl = deps.runProcess ?? runProcess;
  const prompt =
    config.prompt ??
    buildPrompt({ spec: config.spec, diffRedacted: config.diffRedacted, probe, nonce });

  const plan = resolveImpl(config.binName, {
    env: deps.env,
    platform: deps.platform,
    fs: deps.fs,
    nodePath: deps.nodePath,
  });
  if (!plan) {
    return errorDictamen({ engine, probe, author, reason: `engine_not_found: ${config.binName}` });
  }

  const result = await runImpl(plan, {
    args: config.args,
    stdin: prompt,
    timeoutMs,
    cwd: config.cwd,
    env: sanitizeEnv(engine, deps.env ?? process.env),
    spawn: deps.spawn,
  });

  const parsed = extractJurorJson(result.stdout, engine, { nonce });
  if (!parsed) {
    const detail = redactText(String(result.stderr ?? '').split(/\r?\n/)[0] ?? '').slice(0, 200);
    const reason = detail ? `${exitReason(result, timeoutMs)}: ${detail}` : exitReason(result, timeoutMs);
    return errorDictamen({ engine, probe, author, reason });
  }

  return {
    juror: { engine, probe, author },
    nonce: parsed.nonce,
    verdict: parsed.verdict,
    severity: parsed.severity,
    findings: parsed.findings,
    summary: parsed.summary,
  };
}
