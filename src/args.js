import path from 'node:path';
import { UsageError } from './errors.js';

export const ENGINES = Object.freeze(['claude', 'codex', 'gemini', 'opencode', 'ollama']);
export const PROBES = Object.freeze(['appsec', 'correctness', 'surgical']);
export const THRESHOLDS = Object.freeze(['P0', 'P1', 'P2']);
export const SUBCOMMANDS = Object.freeze(['doctor', 'review', 'install-hook']);

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 1_800_000;
export const MAX_JURORS = 3;
export const DEFAULT_MAX_BYTES = 300_000;
export const MAX_SPEC_BYTES = 20_000;
export const MIN_MAX_BYTES = 1_000;
export const AUTHORS = Object.freeze([...ENGINES, 'hook', 'ci']);
export const HOOK_TYPES = Object.freeze(['pre-commit', 'pre-push']);
export const RANGE_PATTERN = /^[A-Za-z0-9._/~^:@{}\-]+$/;

const VALUE_FLAGS = new Set([
  'range',
  'spec',
  'author',
  'jurors',
  'probes',
  'fail-on',
  'timeout',
  'output',
  'max-bytes',
  'type',
]);

const BOOLEAN_FLAGS = new Set([
  'staged',
  'json',
  'allow-same-engine',
  'no-color',
  'force',
  'help',
  'version',
  'doctor',
]);

const SHORT_FLAGS = new Map([
  ['-v', 'version'],
  ['-h', 'help'],
]);

export function defaults() {
  return {
    staged: false,
    range: null,
    spec: null,
    author: null,
    jurors: null,
    probes: null,
    json: false,
    failOn: 'P1',
    allowSameEngine: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxBytes: DEFAULT_MAX_BYTES,
    // undefined means "decide from NO_COLOR and isTTY"; --no-color pins it to false.
    color: undefined,
    output: null,
    force: false,
    hookType: 'pre-push',
  };
}

/** Colors are on only for an interactive TTY that has not opted out via NO_COLOR. */
export function resolveColor(flags, { env = process.env, isTTY = false } = {}) {
  if (flags?.color === false) return false;
  if (env?.NO_COLOR) return false;
  return Boolean(isTTY);
}

export function validateRange(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new UsageError('invalid_range', 'empty revision');
  if (value.startsWith('-')) {
    throw new UsageError('invalid_range', 'a revision cannot start with a dash');
  }
  if (/\p{Cc}/u.test(value)) {
    throw new UsageError('invalid_range', 'control characters are not allowed');
  }
  if (!RANGE_PATTERN.test(value)) {
    throw new UsageError('invalid_range', `rejected revision ${JSON.stringify(value)}`);
  }
  return value;
}

function requireValue(name, inline) {
  if (typeof inline === 'string') {
    if (!inline) throw new UsageError('missing_value', `--${name}`);
    return inline;
  }
  return undefined;
}

function parseList(raw, allowed, flag) {
  const items = raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (items.length === 0) throw new UsageError('empty_list', `--${flag}`);
  const unknown = items.filter((item) => !allowed.includes(item));
  if (unknown.length > 0) {
    throw new UsageError('unknown_value', `--${flag} ${unknown.join(',')} (allowed: ${allowed.join(',')})`);
  }
  return [...new Set(items)];
}

function parseMaxBytes(raw) {
  if (!/^\d+$/.test(raw)) throw new UsageError('invalid_max_bytes', raw);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_MAX_BYTES) {
    throw new UsageError('invalid_max_bytes', `must be at least ${MIN_MAX_BYTES}`);
  }
  return value;
}

function parseTimeout(raw) {
  if (!/^\d+$/.test(raw)) throw new UsageError('invalid_timeout', raw);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new UsageError('invalid_timeout', `must be between 1 and ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

function parseFailOn(raw) {
  const value = raw.trim().toUpperCase();
  if (!THRESHOLDS.includes(value)) {
    throw new UsageError('unknown_value', `--fail-on ${raw} (allowed: ${THRESHOLDS.join(',')})`);
  }
  return value;
}

export function parseArgs(argv = []) {
  if (!Array.isArray(argv)) throw new UsageError('invalid_argv');
  const flags = defaults();
  let command = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);

    if (token.startsWith('--')) {
      const separator = token.indexOf('=');
      const name = (separator === -1 ? token.slice(2) : token.slice(2, separator)).toLowerCase();
      const inline = separator === -1 ? undefined : token.slice(separator + 1);

      if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) {
        throw new UsageError('unknown_flag', `--${name}`);
      }

      if (BOOLEAN_FLAGS.has(name)) {
        if (inline !== undefined) throw new UsageError('unexpected_value', `--${name}`);
        if (name === 'no-color') flags.color = false;
        else if (name === 'allow-same-engine') flags.allowSameEngine = true;
        else flags[name] = true;
        continue;
      }

      let value = requireValue(name, inline);
      if (value === undefined) {
        const next = argv[index + 1];
        if (typeof next !== 'string' || next.startsWith('--')) {
          throw new UsageError('missing_value', `--${name}`);
        }
        value = next;
        index += 1;
      }

      if (name === 'jurors') flags.jurors = parseList(value, ENGINES, 'jurors');
      else if (name === 'probes') flags.probes = parseList(value, PROBES, 'probes');
      else if (name === 'author') {
        const engine = value.trim().toLowerCase();
        if (!AUTHORS.includes(engine)) {
          throw new UsageError('unknown_value', `--author ${value} (allowed: ${AUTHORS.join(',')})`);
        }
        flags.author = engine;
      } else if (name === 'fail-on') flags.failOn = parseFailOn(value);
      else if (name === 'timeout') flags.timeoutMs = parseTimeout(value);
      else if (name === 'max-bytes') flags.maxBytes = parseMaxBytes(value);
      else if (name === 'type') {
        const hookType = value.trim().toLowerCase();
        if (!HOOK_TYPES.includes(hookType)) {
          throw new UsageError('unknown_value', `--type ${value} (allowed: ${HOOK_TYPES.join(',')})`);
        }
        flags.hookType = hookType;
      } else if (name === 'range') {
        flags.range = validateRange(value);
      } else if (name === 'output') {
        const output = value.trim();
        if (!output) throw new UsageError('missing_value', '--output');
        flags.output = output;
      } else if (name === 'spec') {
        if (!value.trim()) throw new UsageError('missing_value', '--spec');
        flags.spec = value;
      }
      continue;
    }

    const short = SHORT_FLAGS.get(token);
    if (short) {
      flags[short] = true;
      continue;
    }

    if (token.startsWith('-')) throw new UsageError('unknown_flag', token);

    if (command) {
      throw new UsageError('unexpected_argument', token);
    }
    const candidate = token.toLowerCase();
    if (!SUBCOMMANDS.includes(candidate)) {
      throw new UsageError('unknown_command', token);
    }
    command = candidate;
  }

  if (flags.doctor && command && command !== 'doctor') {
    throw new UsageError('conflicting_flags', '--doctor cannot be combined with a subcommand');
  }
  if (flags.help) command = 'help';
  else if (flags.version) command = 'version';
  else if (flags.doctor && !command) command = 'doctor';
  else if (!command) command = 'help';

  if (flags.staged && flags.range) {
    throw new UsageError('conflicting_flags', '--staged and --range are mutually exclusive');
  }
  if (flags.force && command !== 'install-hook') {
    throw new UsageError('conflicting_flags', '--force only applies to install-hook');
  }
  if (command === 'install-hook' && (flags.range || flags.output || flags.json || flags.spec)) {
    throw new UsageError('conflicting_flags', 'install-hook accepts only --force and --type');
  }
  if (command !== 'install-hook' && flags.hookType !== 'pre-push') {
    throw new UsageError('conflicting_flags', '--type only applies to install-hook');
  }

  return { command, flags };
}

/** Relative output paths must stay inside the repository; absolute paths must too. */
export function resolveOutputPath(raw, cwd = process.cwd()) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new UsageError('output_requires_path');
  }
  const root = path.resolve(cwd);
  const target = path.resolve(root, raw.trim());
  const relative = path.relative(root, target);
  const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  if (!inside) {
    throw new UsageError('output_outside_cwd', 'write into the repository or pass a relative path');
  }
  if (target === root || path.extname(target).toLowerCase() !== '.json') {
    throw new UsageError('output_must_be_json', raw);
  }
  return target;
}

export function usage(command) {
  const header = [
    'cold-jury 0.1.0',
    '',
    'Usage: cold-jury <subcommand> [flags]',
    '',
    'Subcommands:',
    '  doctor                  Detect the review engines available in PATH',
    '  review                  Run the sterile room: shield, diff, jurors, verdict',
    '  install-hook            Install a hook in .git/hooks (--type pre-commit|pre-push)',
    '',
    'review flags:',
    '  --staged                Review `git diff --cached` (default)',
    '  --range <rev>           Review `git diff <rev>` instead',
    '  --spec <text|file>      Atomic intent of the change, inline or a .md/.txt path',
    '  --author <engine>       claude|codex|gemini|opencode|ollama|hook|ci (auto-detected from env)',
    '  --jurors <list>         Comma separated engines, max 3 (default: every READY engine except the author)',
    '  --probes <list>         appsec,correctness,surgical (default: all three)',
    '  --json                  Print the aggregated verdict as JSON only',
    '  --fail-on <P0|P1|P2>    Blocking threshold (default: P1)',
    '  --allow-same-engine     Let the author engine judge, only for sterile room tests',
    '  --timeout <ms>          Per juror timeout (default: 120000)',
    '  --max-bytes <bytes>     Diff size cap before truncation (default: 300000)',
    '  --output <path>         Write the verdict JSON to a .json path inside the repo',
    '  --no-color              Disable ANSI colors (NO_COLOR=1 and non-TTY streams also do)',
    '',
    'Global flags:',
    '  --doctor                Alias of `cold-jury doctor`',
    '  --version, -v           Print the package version',
    '  --help, -h              Print this help',
  ];
  if (command === 'doctor' || command === 'review' || command === 'install-hook') {
    return header.join('\n');
  }
  return header.join('\n');
}
