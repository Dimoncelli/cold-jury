import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  AUTHORS,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  ENGINES,
  MAX_TIMEOUT_MS,
  PROBES,
  defaults,
  parseArgs,
  resolveColor,
  resolveOutputPath,
  usage,
  validateRange,
} from '../src/args.js';
import { ColdJuryError } from '../src/errors.js';

function failsWith(argv, code) {
  assert.throws(() => parseArgs(argv), (error) => {
    assert.ok(error instanceof ColdJuryError);
    assert.equal(error.exitCode, 2);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
    return true;
  });
}

describe('args: defaults', () => {
  it('starts with two minutes, P1, no color decision and a 300 kB diff cap', () => {
    const parsed = parseArgs(['review']);
    assert.equal(parsed.command, 'review');
    assert.deepEqual(parsed.flags, defaults());
    assert.equal(parsed.flags.failOn, 'P1');
    assert.equal(parsed.flags.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.equal(parsed.flags.maxBytes, DEFAULT_MAX_BYTES);
    assert.equal(DEFAULT_TIMEOUT_MS, 120000);
    assert.equal(DEFAULT_MAX_BYTES, 300000);
    assert.equal(parsed.flags.color, undefined, 'color is decided later from NO_COLOR and isTTY');
    assert.equal(parsed.flags.hookType, 'pre-push');
    assert.equal(parsed.flags.staged, false);
  });

  it('prints help when no subcommand is given', () => {
    assert.equal(parseArgs([]).command, 'help');
  });

  it('accepts every subcommand', () => {
    for (const command of ['doctor', 'review', 'install-hook']) {
      assert.equal(parseArgs([command]).command, command);
    }
  });
});

describe('args: color policy', () => {
  it('honours NO_COLOR, --no-color and isTTY', () => {
    assert.equal(resolveColor({}, { env: {}, isTTY: true }), true);
    assert.equal(resolveColor({}, { env: { NO_COLOR: '1' }, isTTY: true }), false);
    assert.equal(resolveColor({}, { env: {}, isTTY: false }), false);
    assert.equal(resolveColor({ color: false }, { env: {}, isTTY: true }), false);
    assert.equal(parseArgs(['review', '--no-color']).flags.color, false);
  });
});

describe('args: flags', () => {
  it('parses every review flag', () => {
    const { flags } = parseArgs([
      'review',
      '--staged',
      '--spec',
      'Add idempotency',
      '--author',
      'CODEX',
      '--jurors',
      'opencode,ollama,opencode',
      '--probes',
      'appsec,surgical',
      '--json',
      '--fail-on',
      'p2',
      '--allow-same-engine',
      '--timeout',
      '500',
      '--max-bytes',
      '5000',
      '--output',
      'reports/verdict.json',
      '--no-color',
    ]);
    assert.equal(flags.staged, true);
    assert.equal(flags.spec, 'Add idempotency');
    assert.equal(flags.author, 'codex');
    assert.deepEqual(flags.jurors, ['opencode', 'ollama']);
    assert.deepEqual(flags.probes, ['appsec', 'surgical']);
    assert.equal(flags.json, true);
    assert.equal(flags.failOn, 'P2');
    assert.equal(flags.allowSameEngine, true);
    assert.equal(flags.timeoutMs, 500);
    assert.equal(flags.maxBytes, 5000);
    assert.equal(flags.output, 'reports/verdict.json');
    assert.equal(flags.color, false);
  });

  it('accepts inline values', () => {
    const { flags } = parseArgs(['review', '--range=HEAD~1', '--timeout=1000', '--fail-on=P0']);
    assert.equal(flags.range, 'HEAD~1');
    assert.equal(flags.timeoutMs, 1000);
    assert.equal(flags.failOn, 'P0');
  });

  it('accepts the neutral authors', () => {
    for (const author of ['hook', 'ci']) {
      assert.equal(parseArgs(['review', '--author', author]).flags.author, author);
    }
    assert.deepEqual([...AUTHORS], ['claude', 'codex', 'gemini', 'opencode', 'ollama', 'hook', 'ci']);
  });

  it('maps -v, -h and --doctor', () => {
    assert.equal(parseArgs(['-v']).command, 'version');
    assert.equal(parseArgs(['--version']).command, 'version');
    assert.equal(parseArgs(['-h']).command, 'help');
    assert.equal(parseArgs(['--help']).command, 'help');
    assert.equal(parseArgs(['--doctor']).command, 'doctor');
    assert.equal(parseArgs(['doctor']).command, 'doctor');
  });

  it('reads hook options', () => {
    const { flags } = parseArgs(['install-hook', '--force', '--type', 'pre-commit']);
    assert.equal(flags.force, true);
    assert.equal(flags.hookType, 'pre-commit');
  });
});

describe('args: git range injection', () => {
  it('accepts real revisions', () => {
    for (const range of ['HEAD~1', 'origin/main...HEAD', '@{u}..HEAD', 'main', 'HEAD@{1}']) {
      assert.equal(validateRange(range), range);
    }
  });

  it('rejects option injection attempts', () => {
    for (const range of ['-o', '--output=/tmp/pwn', '--name-only', '--ext-diff', '--no-index=-x']) {
      assert.throws(() => validateRange(range), (error) => error.code === 'invalid_range');
    }
    failsWith(['review', '--range=--output=/tmp/pwn'], 'invalid_range');
    failsWith(['review', '--range', '-o'], 'invalid_range');
    failsWith(['review', '--range', 'HEAD;rm -rf /'], 'invalid_range');
    failsWith(['review', '--range', 'HEAD$(id)'], 'invalid_range');
  });

  it('rejects control characters and empty revisions', () => {
    assert.throws(() => validateRange('HEAD\nHEAD~1'), (error) => error.code === 'invalid_range');
    assert.throws(() => validateRange('   '), (error) => error.code === 'invalid_range');
  });
});

describe('args: rejections', () => {
  it('rejects unknown flags and commands', () => {
    failsWith(['review', '--nope'], 'unknown_flag');
    failsWith(['-x'], 'unknown_flag');
    failsWith(['deploy'], 'unknown_command');
    failsWith(['review', 'extra'], 'unexpected_argument');
  });

  it('rejects missing or empty values', () => {
    failsWith(['review', '--spec'], 'missing_value');
    failsWith(['review', '--spec', '--json'], 'missing_value');
    failsWith(['review', '--output'], 'missing_value');
    failsWith(['review', '--json=1'], 'unexpected_value');
  });

  it('rejects conflicting combinations', () => {
    failsWith(['review', '--staged', '--range', 'HEAD~1'], 'conflicting_flags');
    failsWith(['review', '--force'], 'conflicting_flags');
    failsWith(['install-hook', '--json'], 'conflicting_flags');
    failsWith(['install-hook', '--range', 'HEAD~1'], 'conflicting_flags');
    failsWith(['--doctor', 'review'], 'conflicting_flags');
    failsWith(['review', '--type', 'pre-commit'], 'conflicting_flags');
  });

  it('rejects unknown engines, probes, thresholds and hook types', () => {
    failsWith(['review', '--author', 'gpt'], 'unknown_value');
    failsWith(['review', '--jurors', 'opencode,gpt'], 'unknown_value');
    failsWith(['review', '--probes', 'style'], 'unknown_value');
    failsWith(['review', '--fail-on', 'P3'], 'unknown_value');
    failsWith(['install-hook', '--type', 'post-merge'], 'unknown_value');
    failsWith(['review', '--jurors', ','], 'empty_list');
  });

  it('rejects invalid timeouts and byte caps', () => {
    failsWith(['review', '--timeout', 'abc'], 'invalid_timeout');
    failsWith(['review', '--timeout', '0'], 'invalid_timeout');
    failsWith(['review', '--timeout', String(MAX_TIMEOUT_MS + 1)], 'invalid_timeout');
    failsWith(['review', '--timeout', '1.5'], 'invalid_timeout');
    failsWith(['review', '--max-bytes', 'abc'], 'invalid_max_bytes');
    failsWith(['review', '--max-bytes', '0'], 'invalid_max_bytes');
    failsWith(['review', '--max-bytes', '999'], 'invalid_max_bytes');
  });
});

describe('args: output confinement', () => {
  const cwd = path.resolve('/work/repo');

  it('accepts relative and absolute paths inside the repository', () => {
    assert.equal(resolveOutputPath('verdict.json', cwd), path.join(cwd, 'verdict.json'));
    assert.equal(
      resolveOutputPath('reports/verdict.json', cwd),
      path.join(cwd, 'reports', 'verdict.json'),
    );
    assert.equal(resolveOutputPath(path.join(cwd, 'final.json'), cwd), path.join(cwd, 'final.json'));
  });

  it('rejects paths that escape the repository', () => {
    for (const raw of ['../escape.json', '../../escape.json', path.join(path.dirname(cwd), 'x.json')]) {
      assert.throws(() => resolveOutputPath(raw, cwd), (error) => error.code === 'output_outside_cwd');
    }
  });

  it('rejects non json targets and the directory itself', () => {
    assert.throws(() => resolveOutputPath('verdict.txt', cwd), (error) => error.code === 'output_must_be_json');
    assert.throws(() => resolveOutputPath('.', cwd), (error) => error.code === 'output_must_be_json');
    assert.throws(() => resolveOutputPath('  ', cwd), (error) => error.code === 'output_requires_path');
  });
});

describe('args: usage text stays in sync with the parser', () => {
  it('documents every subcommand and flag', () => {
    const text = usage();
    for (const command of ['doctor', 'review', 'install-hook']) {
      assert.ok(text.includes(command), `missing subcommand ${command}`);
    }
    for (const flag of [
      '--staged',
      '--range',
      '--spec',
      '--author',
      '--jurors',
      '--probes',
      '--json',
      '--fail-on',
      '--allow-same-engine',
      '--timeout',
      '--max-bytes',
      '--output',
      '--type',
      '--no-color',
      '--version',
      '--help',
      '--doctor',
    ]) {
      assert.ok(text.includes(flag), `missing flag ${flag}`);
    }
    assert.ok(text.includes('NO_COLOR'));
    assert.ok(text.includes('hook|ci'));
  });

  it('lists the exact engine and probe vocabulary', () => {
    assert.deepEqual([...ENGINES], ['claude', 'codex', 'gemini', 'opencode', 'ollama']);
    assert.deepEqual([...PROBES], ['appsec', 'correctness', 'surgical']);
  });
});
