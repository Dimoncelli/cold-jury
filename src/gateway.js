import http from 'node:http';
import https from 'node:https';

/**
 * Local, ephemeral credential-injection gateway.
 *
 * The child engine gets a fake base URL + a random token. Every request comes
 * here, is checked against a host allowlist, and only then does the gateway add
 * the real credential and forward it over TLS. The secret never enters the
 * child's environment, argv or stdin, and never leaves this process.
 */
export const MAX_GATEWAY_BODY_BYTES = 2_000_000;

export const PROVIDERS = Object.freeze({
  claude: {
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    keyEnv: 'ANTHROPIC_API_KEY',
    upstream: 'https://api.anthropic.com',
    allowlistHosts: ['api.anthropic.com'],
    auth: 'bearer',
  },
  codex: {
    baseUrlEnv: 'OPENAI_BASE_URL',
    keyEnv: 'OPENAI_API_KEY',
    upstream: 'https://api.openai.com',
    allowlistHosts: ['api.openai.com'],
    auth: 'bearer',
  },
  gemini: {
    baseUrlEnv: 'GEMINI_BASE_URL',
    keyEnv: 'GEMINI_API_KEY',
    upstream: 'https://generativelanguage.googleapis.com',
    allowlistHosts: ['generativelanguage.googleapis.com'],
    auth: 'x-goog-api-key',
  },
  opencode: {
    baseUrlEnv: 'OPENCODE_BASE_URL',
    keyEnv: 'OPENCODE_API_KEY',
    upstream: 'https://api.openai.com',
    allowlistHosts: ['api.openai.com', 'api.anthropic.com'],
    auth: 'bearer',
  },
  ollama: {
    baseUrlEnv: null,
    keyEnv: null,
    upstream: null,
    allowlistHosts: [],
    auth: null,
  },
});

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'host',
  'content-length',
  'authorization',
  'x-goog-api-key',
  'x-api-key',
]);

export function providerFor(engine) {
  const provider = PROVIDERS[engine];
  if (!provider) throw new Error(`unknown_engine: ${engine}`);
  return provider;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function sendJson(res, status, body) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function forwardedHeaders(headers, provider, credential) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  if (credential) {
    if (provider.auth === 'x-goog-api-key') out['x-goog-api-key'] = credential;
    else out.authorization = `Bearer ${credential}`;
  }
  return out;
}

export async function createGateway(options = {}) {
  const provider = options.provider;
  if (!provider) throw new Error('provider_required');
  const credential = typeof options.credential === 'string' && options.credential ? options.credential : null;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const httpImpl = options.httpImpl ?? http;
  const httpsImpl = options.httpsImpl ?? https;
  const allowlist = new Set((provider.allowlistHosts ?? []).map((host) => host.toLowerCase()));
  const sockets = new Set();

  const server = httpImpl.createServer((req, res) => {
    let target;
    try {
      const raw = String(req.url ?? '');
      const absolute = /^https?:\/\//i.test(raw);
      const parsed = absolute ? new URL(raw) : new URL(raw, provider.upstream ?? 'https://127.0.0.1');
      target = {
        hostname: parsed.hostname.toLowerCase(),
        path: `${parsed.pathname}${parsed.search}`,
      };
    } catch {
      req.resume();
      sendJson(res, 403, { error: 'FORBIDDEN_HOST' });
      return;
    }

    // Anti-exfiltration: a host outside the allowlist never reaches the credential.
    if (!allowlist.has(target.hostname)) {
      req.resume();
      sendJson(res, 403, { error: 'FORBIDDEN_HOST' });
      return;
    }
    if (!credential) {
      req.resume();
      sendJson(res, 503, { error: 'NO_CREDENTIAL' });
      return;
    }

    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_GATEWAY_BODY_BYTES) {
      req.resume();
      sendJson(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
      return;
    }

    const headers = forwardedHeaders(req.headers, provider, credential);
    headers.host = target.hostname;

    let upstreamReq;
    try {
      upstreamReq = httpsImpl.request(
        {
          hostname: target.hostname,
          port: 443,
          path: target.path,
          method: req.method,
          headers,
        },
        (upstreamRes) => {
          const responseHeaders = {};
          for (const [key, value] of Object.entries(upstreamRes.headers ?? {})) {
            if (HOP_BY_HOP.has(key.toLowerCase())) continue;
            if (value !== undefined) responseHeaders[key] = value;
          }
          res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
          upstreamRes.pipe(res);
        },
      );
    } catch (error) {
      req.resume();
      onError(error);
      sendJson(res, 502, { error: 'UPSTREAM_ERROR' });
      return;
    }

    let received = 0;
    let aborted = false;
    upstreamReq.on('error', (error) => {
      if (aborted) return;
      onError(error);
      if (!res.headersSent) sendJson(res, 502, { error: 'UPSTREAM_ERROR' });
      else res.destroy();
    });
    // Streamed limit for chunked bodies without content-length.
    req.on('data', (chunk) => {
      received += chunk.length;
      if (aborted || received <= MAX_GATEWAY_BODY_BYTES) return;
      aborted = true;
      req.unpipe(upstreamReq);
      upstreamReq.destroy();
      if (!res.headersSent) sendJson(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
      req.resume();
    });
    req.on('error', () => upstreamReq.destroy());
    req.pipe(upstreamReq);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  if (typeof server.on === 'function') {
    server.on('error', (error) => onError(error));
  }

  await new Promise((resolve, reject) => {
    const onListenError = (error) => reject(error);
    server.once('error', onListenError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onListenError);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      // Destroy first: one idle keep-alive socket would block server.close() forever.
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          /* already closed */
        }
      }
      sockets.clear();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export { hostnameOf };
