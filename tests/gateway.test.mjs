import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { describe, it } from 'node:test';
import { PROVIDERS, createGateway, providerFor } from '../src/gateway.js';

/** Minimal https stand-in: records the forwarded request and answers with a fake upstream. */
function fakeHttps({ status = 200, body = '{"ok":true}' } = {}) {
  const calls = [];
  return {
    calls,
    request(options, onResponse) {
      const request = new EventEmitter();
      const chunks = [];
      request.chunks = chunks;
      request.write = (chunk) => {
        chunks.push(Buffer.from(chunk));
        return true;
      };
      request.end = () => {
        calls.push({ options, body: Buffer.concat(chunks).toString('utf8') });
        const upstream = new EventEmitter();
        upstream.statusCode = status;
        upstream.headers = { 'content-type': 'application/json', 'transfer-encoding': 'chunked' };
        upstream.pipe = (res) => {
          res.write(body);
          res.end();
          return res;
        };
        onResponse(upstream);
      };
      request.destroy = () => {};
      return request;
    },
  };
}

function rawRequest(port, { method = 'GET', path = '/', body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('gateway: credential injection behind a host allowlist', () => {
  it('forwards origin-form requests to the provider upstream with the real credential', async () => {
    const https = fakeHttps();
    const gateway = await createGateway({ provider: PROVIDERS.claude, credential: 'REAL-KEY', httpsImpl: https });
    try {
      const response = await rawRequest(gateway.port, {
        method: 'POST',
        path: '/v1/messages',
        body: '{"prompt":"hi"}',
        headers: { authorization: 'Bearer CHILD-TOKEN', 'content-type': 'application/json' },
      });
      assert.equal(response.status, 200);
      assert.equal(https.calls.length, 1);
      const [{ options, body }] = https.calls;
      assert.equal(options.hostname, 'api.anthropic.com');
      assert.equal(options.path, '/v1/messages');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.authorization, 'Bearer REAL-KEY');
      assert.equal(options.headers.host, 'api.anthropic.com');
      assert.equal(body, '{"prompt":"hi"}');
    } finally {
      await gateway.close();
    }
  });

  it('refuses an absolute URL outside the allowlist without contacting the upstream', async () => {
    const https = fakeHttps();
    const gateway = await createGateway({ provider: PROVIDERS.claude, credential: 'REAL-KEY', httpsImpl: https });
    try {
      const response = await rawRequest(gateway.port, { path: 'http://evil.example/x' });
      assert.equal(response.status, 403);
      assert.deepEqual(JSON.parse(response.text), { error: 'FORBIDDEN_HOST' });
      assert.equal(https.calls.length, 0);
    } finally {
      await gateway.close();
    }
  });

  it('answers 503 when no credential is available', async () => {
    const https = fakeHttps();
    const gateway = await createGateway({ provider: PROVIDERS.codex, credential: null, httpsImpl: https });
    try {
      const response = await rawRequest(gateway.port, { path: '/v1/chat/completions' });
      assert.equal(response.status, 503);
      assert.deepEqual(JSON.parse(response.text), { error: 'NO_CREDENTIAL' });
      assert.equal(https.calls.length, 0);
    } finally {
      await gateway.close();
    }
  });

  it('close() stops listening', async () => {
    const gateway = await createGateway({ provider: PROVIDERS.gemini, credential: 'REAL', httpsImpl: fakeHttps() });
    const { port } = gateway;
    await gateway.close();
    await assert.rejects(() => rawRequest(port, { path: '/v1/models' }), (error) => error.code === 'ECONNREFUSED');
  });

  it('providerFor resolves a provider and rejects unknown engines', () => {
    assert.equal(providerFor('claude').baseUrlEnv, 'ANTHROPIC_BASE_URL');
    assert.throws(() => providerFor('nope'), /unknown_engine/);
    assert.equal(PROVIDERS.ollama.keyEnv, null);
  });
});

describe('gateway: close with an open connection', () => {
  it('destroys idle sockets so close() resolves instead of hanging', async () => {
    const gateway = await createGateway({ provider: PROVIDERS.codex, credential: 'REAL', httpsImpl: fakeHttps() });
    const socket = net.connect(gateway.port, '127.0.0.1');
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });

    const closed = new Promise((resolve) => socket.once('close', resolve));
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 1500));
    const outcome = await Promise.race([gateway.close().then(() => 'closed'), timeout]);
    assert.equal(outcome, 'closed');
    await closed;
  });
});

describe('gateway: header hygiene and body cap', () => {
  it('never forwards the child x-api-key together with the real credential', async () => {
    const https = fakeHttps();
    const gateway = await createGateway({ provider: PROVIDERS.claude, credential: 'REAL', httpsImpl: https });
    try {
      await rawRequest(gateway.port, {
        method: 'POST',
        path: '/v1/messages',
        body: '{}',
        headers: { 'x-api-key': 'CHILD-FAKE', authorization: 'Bearer CHILD' },
      });
      const [{ options }] = https.calls;
      assert.equal(options.headers['x-api-key'], undefined);
      assert.equal(options.headers.authorization, 'Bearer REAL');
    } finally {
      await gateway.close();
    }
  });

  it('answers 413 for an oversized body and never calls the upstream', async () => {
    const https = fakeHttps();
    const gateway = await createGateway({ provider: PROVIDERS.claude, credential: 'REAL', httpsImpl: https });
    try {
      const response = await rawRequest(gateway.port, {
        method: 'POST',
        path: '/v1/messages',
        body: 'x'.repeat(2_000_001),
        headers: { 'content-type': 'application/json' },
      });
      assert.equal(response.status, 413);
      assert.deepEqual(JSON.parse(response.text), { error: 'PAYLOAD_TOO_LARGE' });
      assert.equal(https.calls.length, 0);
    } finally {
      await gateway.close();
    }
  });
});

describe('gateway: chunked body cap', () => {
  it('answers 413 for a chunked body over the cap without content-length', async () => {
    const https = fakeHttps();
    const gateway = await createGateway({ provider: PROVIDERS.claude, credential: 'REAL', httpsImpl: https });
    try {
      const status = await new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: gateway.port, method: 'POST', path: '/v1/messages', headers: { 'transfer-encoding': 'chunked' } },
          (res) => resolve(res.statusCode),
        );
        req.on('error', reject);
        req.write('x'.repeat(1024 * 1024));
        req.write('x'.repeat(1024 * 1024));
        req.write('x'.repeat(16));
        req.end();
      });
      assert.equal(status, 413);
      assert.equal(https.calls.length, 0);
    } finally {
      await gateway.close();
    }
  });
});
