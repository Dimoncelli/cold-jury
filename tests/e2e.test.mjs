import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { main } from '../src/cli.js';

const tempDirs = [];

function capture() {
  const chunks = [];
  return {
    write(value) {
      chunks.push(String(value));
      return true;
    },
    text() {
      return chunks.join('');
    },
  };
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function makeRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-jury-e2e-'));
  tempDirs.push(cwd);
  git(cwd, ['init', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'qa@example.test']);
  git(cwd, ['config', 'user.name', 'QA']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(cwd, 'app.js'), 'export const x = 1;\n');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-m', 'init']);
  fs.writeFileSync(path.join(cwd, 'app.js'), 'export const x = 1;\nexport const y = 2;\n');
  git(cwd, ['add', '-A']);
  return cwd;
}

const REPORTS = [
  { engine: 'ollama', status: 'READY', command: 'ollama.exe', path: '/bin/ollama.exe' },
  { engine: 'opencode', status: 'READY', command: 'node', path: '/bin/opencode.cmd' },
  { engine: 'claude', status: 'READY', command: 'claude.exe', path: '/bin/claude.exe' },
  { engine: 'codex', status: 'NOT_FOUND', command: '', path: '' },
  { engine: 'gemini', status: 'NOT_FOUND', command: '', path: '' },
];

const NO_REPORTS = REPORTS.map((report) => ({ ...report, status: 'NOT_FOUND' }));
const GIT_PLAN = () => ({ command: 'git', prefixArgs: [], wrapper: 'direct' });

function dictamen(engine, probe, findings = []) {
  return {
    juror: { engine, probe, author: 'claude' },
    verdict: findings.length > 0 ? 'BLOCK' : 'PASS',
    severity: findings.length > 0 ? findings[0].severity : 'NONE',
    findings,
    summary: findings.length > 0 ? 'Findings reported.' : 'Clean diff.',
  };
}

function failing(engine) {
  return {
    juror: { engine, probe: 'appsec' },
    verdict: 'ERROR',
    severity: 'NONE',
    findings: [],
    summary: 'fetch failed',
  };
}

function adapterFactories(state) {
  const factoryFor = (engine) => () => ({
    engine,
    async run({ spec, diffRedacted, probe, author, cwd, nonce }) {
      state.calls.push({ engine, probe, author, cwd, spec, diffRedacted, nonce });
      if (state.failEngines?.includes(engine)) return failing(engine);
      return dictamen(engine, probe, state.findings?.[engine] ?? []);
    },
  });
  return {
    opencode: factoryFor('opencode'),
    ollama: factoryFor('ollama'),
    claude: factoryFor('claude'),
  };
}

async function review(cwd, argv, options = {}) {
  const state = { calls: [], findings: options.findings, failEngines: options.failEngines };
  const stdout = capture();
  const stderr = capture();
  const code = await main(argv, {
    cwd,
    env: {},
    stdout,
    stderr,
    doctor: () => options.reports ?? REPORTS,
    resolveBinary: GIT_PLAN,
    adapterFactories: adapterFactories(state),
  });
  return { code, stdout: stdout.text(), stderr: stderr.text(), calls: state.calls };
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('e2e: sterile room against a real git repository', () => {
  it('passes a clean diff with three probes per juror and one nonce per run', async () => {
    const cwd = makeRepo();
    const result = await review(cwd, ['review', '--author', 'claude', '--jurors', 'opencode,ollama', '--json', '--spec', 'Add y']);

    assert.equal(result.code, 0);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.tool, 'cold-jury');
    assert.equal(verdict.gate, 'PASS');
    assert.equal(verdict.exitCode, 0);
    assert.equal(verdict.author, 'claude');
    assert.deepEqual(verdict.jurors, ['opencode', 'ollama']);
    assert.deepEqual(verdict.probes, ['appsec', 'correctness', 'surgical']);
    assert.deepEqual(verdict.counts, { P0: 0, P1: 0, P2: 0 });
    assert.deepEqual(verdict.errors, []);
    assert.deepEqual(verdict.secretShield, { scanned: true, redactions: 0, leak: false });
    assert.equal(result.calls.length, 6);

    const nonces = new Set(result.calls.map((call) => call.nonce));
    assert.equal(nonces.size, 1, 'one nonce per run');
    assert.ok([...nonces][0].length >= 8);

    for (const call of result.calls) {
      assert.equal(call.author, 'claude');
      assert.equal(call.spec, 'Add y');
      assert.ok(call.diffRedacted.includes('export const y = 2;'));
      assert.notEqual(call.cwd, cwd, 'each juror runs in its own sterile room');
      assert.equal(fs.existsSync(call.cwd), false, 'the sterile room is removed in finally');
    }
  });

  it('blocks on a P1 finding and exits 1', async () => {
    const cwd = makeRepo();
    const finding = {
      id: 'AS-001',
      severity: 'P1',
      title: 'Missing validation',
      file: 'app.js',
      line: 2,
      cwe: 'CWE-20',
      evidence: 'export const y = 2;',
      suggestion: 'Validate input.',
    };
    const result = await review(cwd, ['review', '--author', 'claude', '--jurors', 'opencode', '--json'], {
      findings: { opencode: [finding] },
    });
    assert.equal(result.code, 1);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.gate, 'BLOCK');
    assert.deepEqual(verdict.counts, { P0: 0, P1: 3, P2: 0 });
    assert.equal(verdict.findings[0].juror, 'opencode');
    assert.equal(verdict.findings[0].file, 'app.js');
  });

  it('keeps the threshold contract: a P2 finding passes at P1 and blocks at P2', async () => {
    const cwd = makeRepo();
    const finding = { id: 'SG-001', severity: 'P2', title: 'Dead code', file: 'app.js' };
    const relaxed = await review(cwd, ['review', '--author', 'claude', '--jurors', 'opencode', '--json'], {
      findings: { opencode: [finding] },
    });
    assert.equal(relaxed.code, 0);
    assert.equal(JSON.parse(relaxed.stdout).gate, 'PASS');

    const strict = await review(cwd, ['review', '--author', 'claude', '--jurors', 'opencode', '--json', '--fail-on', 'P2'], {
      findings: { opencode: [finding] },
    });
    assert.equal(strict.code, 1);
    assert.equal(JSON.parse(strict.stdout).gate, 'BLOCK');
  });

  it('short circuits an empty diff without spawning a juror', async () => {
    const cwd = makeRepo();
    git(cwd, ['commit', '-m', 'add y']);
    const result = await review(cwd, ['review', '--author', 'claude', '--json']);
    assert.equal(result.code, 0);
    assert.equal(result.calls.length, 0);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.gate, 'PASS');
    assert.deepEqual(verdict.jurors, []);
    assert.match(verdict.note, /No changes in diff/);
  });

  it('never runs a juror when the shield finds a P0 secret', async () => {
    const cwd = makeRepo();
    const token = `ghp_${'r'.repeat(40)}`;
    fs.writeFileSync(path.join(cwd, 'secret.txt'), `GITHUB_TOKEN=${token}\n`);
    git(cwd, ['add', '-A']);

    const result = await review(cwd, ['review', '--author', 'claude', '--jurors', 'opencode', '--json']);
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 0, 'no juror runs after a P0 leak');
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.gate, 'BLOCK');
    assert.equal(verdict.secretShield.leak, true);
    assert.deepEqual(verdict.counts, { P0: 1, P1: 0, P2: 0 });
    assert.equal(verdict.findings[0].id, 'SL-001');
    assert.equal(result.stdout.includes(token), false);
    assert.equal(result.stderr.includes(token), false);
    assert.match(result.stderr, /P0 SECRET_LEAK/);
  });

  it('blocks when a secret only appears in --spec', async () => {
    const cwd = makeRepo();
    const token = `ghp_${'s'.repeat(40)}`;
    const result = await review(cwd, ['review', '--author', 'claude', '--json', '--spec', `deploy with ${token}`]);
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 0);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.secretShield.leak, true);
    assert.match(verdict.note, /--spec/);
    assert.equal(result.stdout.includes(token), false);
  });

  it('rejects a --spec file outside the repository', async () => {
    const cwd = makeRepo();
    const outside = path.join(path.dirname(cwd), `cold-jury-outside-${Date.now()}.md`);
    fs.writeFileSync(outside, 'outside spec');
    tempDirs.push(outside);
    const result = await review(cwd, ['review', '--author', 'claude', '--json', '--spec', outside]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /spec_outside_cwd/);
  });

  it('truncates a diff over --max-bytes and flags it', async () => {
    const cwd = makeRepo();
    fs.writeFileSync(path.join(cwd, 'big.txt'), `${'x'.repeat(200)}\n`.repeat(60));
    git(cwd, ['add', '-A']);
    const result = await review(cwd, ['review', '--author', 'claude', '--jurors', 'opencode', '--json', '--max-bytes', '1000']);
    assert.equal(result.code, 0);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.limit.truncated, true);
    assert.equal(verdict.limit.maxBytes, 1000);
    assert.ok(verdict.limit.originalBytes > 1000);
    assert.ok(result.calls[0].diffRedacted.length <= 1000);
  });

  it('exits 2 when every juror fails technically', async () => {
    const cwd = makeRepo();
    const result = await review(cwd, ['review', '--author', 'claude', '--jurors', 'opencode', '--json'], {
      failEngines: ['opencode'],
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /engine_execution_failed/);
    assert.match(result.stderr, /opencode/);
    assert.equal(result.stdout, '', 'no verdict is printed when nothing completed');
  });

  it('excludes the author engine from the pool', async () => {
    const cwd = makeRepo();
    const result = await review(cwd, ['review', '--author', 'claude', '--jurors', 'claude,opencode', '--json']);
    assert.equal(result.code, 0);
    assert.deepEqual([...new Set(result.calls.map((call) => call.engine))], ['opencode']);
  });

  it('lets a neutral author use every READY engine', async () => {
    const cwd = makeRepo();
    const result = await review(cwd, ['review', '--author', 'ci', '--json']);
    assert.equal(result.code, 0);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.author, 'ci');
    assert.equal(verdict.jurors.length, 3);
    assert.ok(verdict.jurors.includes('claude'));
    assert.deepEqual([...new Set(result.calls.map((call) => call.engine))].sort(), ['claude', 'ollama', 'opencode']);
  });

  it('puts claude first when it is not the author', async () => {
    const cwd = makeRepo();
    const result = await review(cwd, ['review', '--author', 'codex', '--json']);
    assert.equal(result.code, 0);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.jurors[0], 'claude');
  });

  it('allows the same engine only with --allow-same-engine', async () => {
    const cwd = makeRepo();
    const blocked = await review(cwd, ['review', '--author', 'claude', '--jurors', 'claude', '--json']);
    assert.equal(blocked.code, 2);
    assert.match(blocked.stderr, /no_ready_jurors/);

    const allowed = await review(cwd, ['review', '--author', 'claude', '--jurors', 'claude', '--json', '--allow-same-engine']);
    assert.equal(allowed.code, 0);
    assert.equal(allowed.calls.length, 3);
  });

  it('exits 2 with an actionable message when no engine is READY', async () => {
    const cwd = makeRepo();
    const result = await review(cwd, ['review', '--author', 'claude', '--json'], { reports: NO_REPORTS });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /no READY juror available/);
    assert.match(result.stderr, /cold-jury doctor/);
  });

  it('reports an OFFLINE daemon in the actionable message', async () => {
    const cwd = makeRepo();
    const reports = NO_REPORTS.map((report) =>
      report.engine === 'ollama' ? { ...report, status: 'OFFLINE' } : report,
    );
    const result = await review(cwd, ['review', '--author', 'claude', '--jurors', 'ollama', '--json'], {
      reports,
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Offline: ollama/);
  });

  it('writes the verdict JSON to --output inside the repository', async () => {
    const cwd = makeRepo();
    const result = await review(cwd, ['review', '--author', 'claude', '--jurors', 'opencode', '--output', 'reports/verdict.json']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /VERDICT: PASS/);
    assert.match(result.stdout, /JSON written to/);
    const written = JSON.parse(fs.readFileSync(path.join(cwd, 'reports', 'verdict.json'), 'utf8'));
    assert.equal(written.gate, 'PASS');
    assert.equal(written.tool, 'cold-jury');
  });

  it('refuses an --output symlink', (t) => {
    const cwd = makeRepo();
    const link = path.join(cwd, 'link.json');
    const target = path.join(cwd, 'real.json');
    fs.writeFileSync(target, '{}');
    try {
      fs.symlinkSync(target, link);
    } catch {
      t.skip('symlinks need privileges on this host');
      return;
    }
    const result = spawnSync(
      process.execPath,
      [path.join(process.cwd(), 'bin', 'cold-jury.mjs'), 'review', '--author', 'claude', '--output', 'link.json'],
      { cwd, encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /symlink_refused/);
  });

  it('reviews a commit range instead of the index', async () => {
    const cwd = makeRepo();
    git(cwd, ['commit', '-m', 'add y']);
    fs.writeFileSync(path.join(cwd, 'other.js'), 'export const z = 3;\n');
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-m', 'add z']);

    const result = await review(cwd, ['review', '--author', 'claude', '--jurors', 'opencode', '--range', 'HEAD~1', '--json']);
    assert.equal(result.code, 0);
    assert.ok(result.calls.length > 0);
    assert.ok(result.calls[0].diffRedacted.includes('other.js'));
    assert.equal(result.calls[0].diffRedacted.includes('export const y = 2;'), false);
  });
});
