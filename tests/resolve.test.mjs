import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  isCmdSafe,
  parseNpmShim,
  planBinary,
  quoteWindowsArg,
  resolveBinary,
} from '../src/resolve.js';
import { buildArgv } from '../src/runner.js';

const win = { platform: 'win32', nodePath: 'C:/node/node.exe' };

function normalizeKey(target) {
  return String(target).replace(/\\/g, '/').toLowerCase();
}

function fakeFs(files) {
  return {
    statSync(target) {
      const key = normalizeKey(target);
      if (!(key in files)) throw new Error(`ENOENT ${key}`);
      return { isFile: () => true, mode: 0o755 };
    },
    readFileSync(target) {
      const key = normalizeKey(target);
      if (!(key in files)) throw new Error(`ENOENT ${key}`);
      return files[key];
    },
  };
}

// Forward slashes on purpose: no escaping games, and path.win32 accepts them.
const SHIM_CONTAINED = [
  '@ECHO off',
  'SETLOCAL',
  'IF EXIST "%dp0%/node.exe" (',
  '  SET "_prog=%dp0%/node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  ')',
  'endLocal & "%_prog%"  "%dp0%/node_modules/pkg/bin/cli.js" %*',
].join('\r\n');

const SHIM_ESCAPING = [
  '@ECHO off',
  'endLocal & "%_prog%"  "%dp0%/../pkg/bin/cli.js" %*',
].join('\r\n');

const SHIM_NPM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%/node.exe" (',
  '  SET "_prog=%dp0%/node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%/../pkg/bin/cli.js" %*',
].join('\r\n');

const SHIM_EXE = '"%dp0%/node_modules/opencode-ai/bin/opencode.exe"   %*';

describe('resolve: npm shim parsing', () => {
  it('extracts the real entry from a standard npm shim', () => {
    assert.equal(parseNpmShim(SHIM_NPM), '../pkg/bin/cli.js');
  });

  it('extracts a packaged exe entry', () => {
    assert.equal(parseNpmShim(SHIM_EXE), 'node_modules/opencode-ai/bin/opencode.exe');
  });

  it('ignores the node.exe probe line', () => {
    const shim = 'IF EXIST "%~dp0/node.exe" (\n"%~dp0/node.exe" "%~dp0/../lib/cli.mjs" %*';
    assert.equal(parseNpmShim(shim), '../lib/cli.mjs');
  });

  it('returns null when there is nothing to resolve', () => {
    assert.equal(parseNpmShim('@ECHO off\nrem no entry'), null);
    assert.equal(parseNpmShim(''), null);
    assert.equal(parseNpmShim(undefined), null);
  });
});

describe('resolve: execution plans', () => {
  it('plans a direct spawn for a .exe', () => {
    const plan = planBinary('C:/tools/claude.exe', { ...win, fs: fakeFs({}) });
    assert.deepEqual(plan, {
      command: 'C:/tools/claude.exe',
      prefixArgs: [],
      wrapper: 'direct',
      kind: 'binary',
      source: 'C:/tools/claude.exe',
    });
    assert.equal('shell' in plan, false, 'a plan never carries a shell field');
  });

  it('plans node plus entry when the shim points inside its directory', () => {
    const target = 'C:/npm/opencode.cmd';
    const entry = path.win32.resolve('C:/npm', 'node_modules/pkg/bin/cli.js');
    const plan = planBinary(target, {
      ...win,
      fs: fakeFs({ [normalizeKey(target)]: SHIM_CONTAINED, [normalizeKey(entry)]: 'x' }),
    });
    assert.equal(plan.command, 'C:/node/node.exe');
    assert.deepEqual(plan.prefixArgs, [entry]);
    assert.equal(plan.kind, 'npm-shim');
    assert.notEqual(plan.command, 'cmd.exe');
  });

  it('refuses a shim entry that escapes the shim directory', () => {
    const target = 'C:/npm/opencode.cmd';
    const escape = path.win32.resolve('C:/npm', '../pkg/bin/cli.js');
    const plan = planBinary(target, {
      ...win,
      fs: fakeFs({ [normalizeKey(target)]: SHIM_ESCAPING, [normalizeKey(escape)]: 'x' }),
    });
    assert.equal(plan.command, 'cmd.exe');
    assert.equal(plan.kind, 'cmd-fallback');
    assert.equal(plan.prefixArgs.length, 4);
  });

  it('plans the packaged exe of a shim without cmd.exe', () => {
    const target = 'C:/npm/opencode.cmd';
    const entry = path.win32.resolve('C:/npm', 'node_modules/opencode-ai/bin/opencode.exe');
    const plan = planBinary(target, {
      ...win,
      fs: fakeFs({ [normalizeKey(target)]: SHIM_EXE, [normalizeKey(entry)]: '' }),
    });
    assert.equal(plan.command, entry);
    assert.equal(plan.kind, 'npm-shim');
    assert.deepEqual(plan.prefixArgs, []);
  });

  it('falls back to cmd.exe with a fully quoted single token', () => {
    const target = 'C:/Users/some user/tools/engine & friend.cmd';
    const plan = planBinary(target, { ...win, fs: fakeFs({ [normalizeKey(target)]: 'no shim' }) });
    assert.equal(plan.command, 'cmd.exe');
    assert.equal(plan.wrapper, 'cmd');
    assert.deepEqual(plan.prefixArgs, ['/d', '/s', '/c', quoteWindowsArg(target)]);
    assert.equal(plan.prefixArgs.length, 4);
  });

  it('plans powershell with an argv array and RemoteSigned for a .ps1', () => {
    const target = 'C:/tools/engine.ps1';
    const plan = planBinary(target, { ...win, fs: fakeFs({ [normalizeKey(target)]: '' }) });
    assert.equal(plan.command, 'powershell.exe');
    assert.deepEqual(plan.prefixArgs, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'RemoteSigned',
      '-File',
      target,
    ]);
  });

  it('refuses to hand an unsafe path to cmd.exe', () => {
    for (const name of ['engine%PATH%.cmd', 'engine!PATH!.cmd', 'eng"ine.cmd', 'eng^ine.cmd']) {
      const target = `C:/tools/${name}`;
      const plan = planBinary(target, { ...win, fs: fakeFs({ [normalizeKey(target)]: 'no shim' }) });
      assert.equal(plan, null, `${name} must be refused`);
      assert.equal(isCmdSafe(target), false);
    }
  });

  it('keeps shell metacharacters inside a single quoted token', () => {
    for (const name of ['engine & calc.cmd', 'engine ; calc.cmd', 'engine | calc.cmd', 'engine (x).cmd']) {
      const target = `C:/tools/${name}`;
      const plan = planBinary(target, { ...win, fs: fakeFs({ [normalizeKey(target)]: 'no shim' }) });
      assert.equal(plan.command, 'cmd.exe');
      assert.equal(plan.wrapper, 'cmd');
      assert.equal(plan.prefixArgs[3], `"${target}"`);
      const argv = buildArgv(plan, ['run', '--format', 'json', 'a b', 'c&d']);
      assert.deepEqual(argv.slice(0, 3), ['/d', '/s', '/c']);
      assert.equal(argv[3], `"${target}"`);
      assert.equal(argv[4], '"run"');
      assert.equal(argv[7], '"a b"');
      assert.equal(argv[8], '"c&d"');
      assert.equal(argv.length, 9);
    }
  });

  it('requires the executable bit on posix', () => {
    const target = '/usr/local/bin/claude';
    const exec = planBinary(target, {
      platform: 'linux',
      fs: { statSync: () => ({ isFile: () => true, mode: 0o755 }) },
    });
    assert.equal(exec.command, target);
    const plain = planBinary(target, {
      platform: 'linux',
      fs: { statSync: () => ({ isFile: () => true, mode: 0o644 }) },
    });
    assert.equal(plain, null);
  });
});

describe('resolve: PATH search', () => {
  const target = 'C:/bin/claude.exe';

  it('finds a binary in PATH order', () => {
    const plan = resolveBinary('claude', {
      platform: 'win32',
      env: { PATH: 'C:/empty;C:/bin' },
      fs: fakeFs({ [normalizeKey(target)]: '' }),
    });
    assert.equal(normalizeKey(plan.command), normalizeKey(target));
    assert.equal(plan.wrapper, 'direct');
  });

  it('returns null when nothing matches', () => {
    const plan = resolveBinary('codex', {
      platform: 'win32',
      env: { PATH: 'C:/empty' },
      fs: fakeFs({}),
    });
    assert.equal(plan, null);
  });

  it('rejects engine names outside the safe charset', () => {
    for (const name of ['claude & calc', 'claude;calc', '%PATH%', 'claude"']) {
      assert.equal(resolveBinary(name, { platform: 'win32', env: { PATH: 'C:/bin' }, fs: fakeFs({}) }), null);
    }
  });

  it('keeps unicode directories intact as a single quoted token', () => {
    const unicode = 'C:/Users/josé/bin/opencode.cmd';
    const plan = resolveBinary('opencode', {
      platform: 'win32',
      env: { PATH: 'C:/Users/josé/bin' },
      fs: fakeFs({ [normalizeKey(unicode)]: 'no shim' }),
    });
    assert.equal(plan.command, 'cmd.exe');
    assert.equal(normalizeKey(plan.prefixArgs[3]), normalizeKey(`"${unicode}"`));
    assert.equal(plan.prefixArgs.length, 4);
  });
});

describe('runner: argv building never enables a shell', () => {
  it('keeps arguments as separate tokens', () => {
    const plan = { command: 'engine.exe', prefixArgs: ['--json'], wrapper: 'direct' };
    assert.deepEqual(buildArgv(plan, ['run', 'a b']), ['--json', 'run', 'a b']);
    assert.deepEqual(buildArgv(plan, ['run']), ['--json', 'run']);
  });
});
