import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createClaudeAdapter } from '../src/adapters/claude.js';
import { PROVIDERS } from '../src/gateway.js';
import { buildGatewayEnv, ephemeralToken, sanitizeEnv } from '../src/runner.js';

const PLAN = { command: 'claude.exe', prefixArgs: [], wrapper: 'direct', kind: 'binary', source: 'claude.exe' };
const NONCE = 'run-nonce';
const VERDICT_TEXT = JSON.stringify({
  nonce: NONCE,
  verdict: 'PASS',
  severity: 'NONE',
  findings: [],
  summary: 'clean',
});
const STDOUT = JSON.stringify({ type: 'result', result: VERDICT_TEXT });

function stubGateway({ port = 5555 } = {}) {
  const calls = { created: [], closed: 0 };
  return {
    calls,
    create: async (options) => {
      calls.created.push(options);
      return {
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        async close() {
          calls.closed += 1;
        },
      };
    },
  };
}

function runWith({ env, gatewayDeps, gateway, runResult }) {
  const adapter = createClaudeAdapter({
    binName: 'claude',
    resolveBinary: () => PLAN,
    runProcess: async (plan, options) => {
      gatewayDeps.captured = options;
      return runResult ?? { code: 0, signal: null, stdout: STDOUT, stderr: '', timedOut: false };
    },
    env,
    createGateway: gatewayDeps.createGateway,
    cryptoImpl: undefined,
  });
  void gateway;
  return adapter.run({ spec: 'spec', diffRedacted: 'diff', probe: 'appsec', author: 'hook', nonce: NONCE });
}

describe('runner: gateway lifecycle inside the spawn', () => {
  it('gives the child a token and a local base URL, never the real key', async () => {
    const stub = stubGateway();
    const captured = {};
    const adapter = createClaudeAdapter({
      binName: 'claude',
      resolveBinary: () => PLAN,
      runProcess: async (plan, options) => {
        captured.env = options.env;
        return { code: 0, signal: null, stdout: STDOUT, stderr: '', timedOut: false };
      },
      env: { ANTHROPIC_API_KEY: 'REAL-KEY', PATH: '/usr/bin' },
      gateway: { engine: 'claude', credential: 'REAL-KEY' },
      createGateway: stub.create,
    });

    const dictamen = await adapter.run({ spec: 'spec', diffRedacted: 'diff', probe: 'appsec', author: 'hook', nonce: NONCE });
    assert.equal(dictamen.verdict, 'PASS');
    assert.equal(captured.env.ANTHROPIC_API_KEY, captured.env.COLD_JURY_EPHEMERAL_TOKEN);
    assert.notEqual(captured.env.ANTHROPIC_API_KEY, 'REAL-KEY');
    assert.equal(captured.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:5555');
    assert.ok(captured.env.COLD_JURY_EPHEMERAL_TOKEN.length >= 43);
    assert.equal(stub.calls.created.length, 1);
    assert.equal(stub.calls.created[0].provider, PROVIDERS.claude);
    assert.equal(stub.calls.created[0].credential, 'REAL-KEY');
    assert.equal(stub.calls.closed, 1);
  });

  it('reads the credential from the environment when only the engine is given', async () => {
    const stub = stubGateway();
    const captured = {};
    const adapter = createClaudeAdapter({
      binName: 'claude',
      resolveBinary: () => PLAN,
      runProcess: async (plan, options) => {
        captured.env = options.env;
        return { code: 0, signal: null, stdout: STDOUT, stderr: '', timedOut: false };
      },
      env: { ANTHROPIC_API_KEY: 'FROM-ENV', PATH: '/usr/bin' },
      gateway: { engine: 'claude' },
      createGateway: stub.create,
    });
    await adapter.run({ spec: 'spec', diffRedacted: 'diff', probe: 'appsec', author: 'hook', nonce: NONCE });
    assert.equal(stub.calls.created[0].credential, 'FROM-ENV');
    assert.notEqual(captured.env.ANTHROPIC_API_KEY, 'FROM-ENV');
  });

  it('closes the gateway once even when the engine fails', async () => {
    const stub = stubGateway();
    const adapter = createClaudeAdapter({
      binName: 'claude',
      resolveBinary: () => PLAN,
      runProcess: async () => ({ code: 1, signal: null, stdout: '', stderr: 'boom', timedOut: false }),
      env: { ANTHROPIC_API_KEY: 'REAL-KEY', PATH: '/usr/bin' },
      gateway: { engine: 'claude', credential: 'REAL-KEY' },
      createGateway: stub.create,
    });
    const dictamen = await adapter.run({ spec: 'spec', diffRedacted: 'diff', probe: 'appsec', author: 'hook', nonce: NONCE });
    assert.equal(dictamen.verdict, 'ERROR');
    assert.equal(stub.calls.closed, 1);
  });

  it('a null credential skips the gateway and keeps the classic sanitized env', async () => {
    const stub = stubGateway();
    const captured = {};
    const adapter = createClaudeAdapter({
      binName: 'claude',
      resolveBinary: () => PLAN,
      runProcess: async (plan, options) => {
        captured.env = options.env;
        return { code: 0, signal: null, stdout: STDOUT, stderr: '', timedOut: false };
      },
      env: { ANTHROPIC_API_KEY: 'REAL-KEY', PATH: '/usr/bin' },
      gateway: { engine: 'claude', credential: null },
      createGateway: stub.create,
    });
    await adapter.run({ spec: 'spec', diffRedacted: 'diff', probe: 'appsec', author: 'hook', nonce: NONCE });
    assert.equal(stub.calls.created.length, 0);
    assert.equal(captured.env.ANTHROPIC_API_KEY, 'REAL-KEY');
    assert.equal('COLD_JURY_EPHEMERAL_TOKEN' in captured.env, false);
  });
});

describe('runner: gateway helpers', () => {
  it('buildGatewayEnv replaces the key and points the base URL at the gateway', () => {
    const env = buildGatewayEnv('claude', { ANTHROPIC_API_KEY: 'REAL', PATH: '/bin' }, { baseUrl: 'http://127.0.0.1:9' }, 'TOKEN');
    assert.equal(env.ANTHROPIC_API_KEY, 'TOKEN');
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9');
    assert.equal(env.COLD_JURY_EPHEMERAL_TOKEN, 'TOKEN');
    assert.equal(sanitizeEnv('claude', { ANTHROPIC_API_KEY: 'REAL' }).ANTHROPIC_BASE_URL, undefined);
  });

  it('ephemeralToken returns distinct 32-byte tokens', () => {
    const first = ephemeralToken();
    const second = ephemeralToken();
    assert.notEqual(first, second);
    assert.ok(first.length >= 43);
  });
});

describe('runner: gateway credential purge', () => {
  it('removes sibling credential variables before injecting the token', async () => {
    const stub = stubGateway();
    const captured = {};
    const adapter = createClaudeAdapter({
      binName: 'claude',
      resolveBinary: () => PLAN,
      runProcess: async (plan, options) => {
        captured.env = options.env;
        return { code: 0, signal: null, stdout: STDOUT, stderr: '', timedOut: false };
      },
      env: {
        ANTHROPIC_API_KEY: 'REAL-KEY',
        ANTHROPIC_AUTH_TOKEN: 'REAL-AUTH',
        GOOGLE_API_KEY: 'REAL-GOOGLE',
        GOOGLE_APPLICATION_CREDENTIALS: '/secrets/adc.json',
        GOOGLE_OAUTH_ACCESS_TOKEN: 'REAL-OAUTH',
        PATH: '/usr/bin',
      },
      gateway: { engine: 'claude', credential: 'REAL-KEY' },
      createGateway: stub.create,
    });

    await adapter.run({ spec: 'spec', diffRedacted: 'diff', probe: 'appsec', author: 'hook', nonce: NONCE });
    assert.equal('GOOGLE_API_KEY' in captured.env, false);
    assert.equal('GOOGLE_APPLICATION_CREDENTIALS' in captured.env, false);
    assert.equal('GOOGLE_OAUTH_ACCESS_TOKEN' in captured.env, false);
    assert.equal('ANTHROPIC_AUTH_TOKEN' in captured.env, false);
    assert.equal(captured.env.ANTHROPIC_API_KEY, captured.env.COLD_JURY_EPHEMERAL_TOKEN);
    assert.equal(captured.env.PATH, '/usr/bin');
  });
});
