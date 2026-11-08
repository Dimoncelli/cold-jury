import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SECRET_LEAK_FINDING_ID,
  SECRET_PATTERNS,
  redactText,
  secretLeakFinding,
  shield,
} from '../src/shield.js';
import { secretLeakVerdict } from '../src/verdict.js';

const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEA0000000000000000000000000000000000000000000000',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

const SECRETS = {
  pem: PEM,
  jwt: `${'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'}.${'c2VjcmV0cGF5bG9hZA'}.${'c2lnbmF0dXJldmFsdWU'}`,
  anthropic: `sk-ant-${'a'.repeat(24)}`,
  githubPat: `github_pat_${'b'.repeat(30)}`,
  github: `ghp_${'c'.repeat(36)}`,
  githubOauth: `gho_${'d'.repeat(36)}`,
  gitlab: `glpat-${'e'.repeat(24)}`,
  slack: 'xoxb-1234567890-abcdefghij',
  sendgrid: `SG.${'f'.repeat(20)}.${'g'.repeat(20)}`,
  googleOauth: `GOCSPX-${'h'.repeat(24)}`,
  npm: `npm_${'i'.repeat(32)}`,
  aws: `AKIA${'J'.repeat(16)}`,
  awsTemp: `ASIA${'K'.repeat(16)}`,
  google: `AIza${'L'.repeat(35)}`,
  stripe: `sk_live_${'m'.repeat(24)}`,
  stripeRestricted: `rk_live_${'n'.repeat(24)}`,
  webhook: `whsec_${'o'.repeat(24)}`,
  apiKey: `sk-${'p'.repeat(24)}`,
  databaseUrl: 'postgres://appuser:s3cretpass@db.internal:5432/app',
  dbPassword: 'DB_PASSWORD=hunter2hunter2',
  awsSecret: 'AWS_SECRET_ACCESS_KEY=abc123def456ghi',
  camelToken: 'const apiToken = "abcdef123456"',
  clientSecret: 'clientSecret: "shhh-very-secret"',
};

const DIFF = [
  'diff --git a/.env b/.env',
  '+++ b/.env',
  `+ANTHROPIC=${SECRETS.anthropic}`,
  `+GH_PAT=${SECRETS.githubPat}`,
  `+GITHUB=${SECRETS.github}`,
  `+GITHUB_OAUTH=${SECRETS.githubOauth}`,
  `+GITLAB=${SECRETS.gitlab}`,
  `+SLACK=${SECRETS.slack}`,
  `+SENDGRID=${SECRETS.sendgrid}`,
  `+GOOGLE_OAUTH=${SECRETS.googleOauth}`,
  `+NPM=${SECRETS.npm}`,
  `+AWS=${SECRETS.aws}`,
  `+AWS_TEMP=${SECRETS.awsTemp}`,
  `+GOOGLE=${SECRETS.google}`,
  `+STRIPE_KEY=${SECRETS.stripe}`,
  `+STRIPE_RESTRICTED=${SECRETS.stripeRestricted}`,
  `+WEBHOOK=${SECRETS.webhook}`,
  `+JWT=${SECRETS.jwt}`,
  `+API=${SECRETS.apiKey}`,
  `+DATABASE_URL=${SECRETS.databaseUrl}`,
  `+${SECRETS.dbPassword}`,
  `+${SECRETS.awsSecret}`,
  `+${SECRETS.camelToken}`,
  `+${SECRETS.clientSecret}`,
  `+${PEM.split('\n').join('\n+')}`,
].join('\n');

const P0_IDS = [
  'ANTHROPIC',
  'AWS',
  'GITHUB',
  'GITHUB_PAT',
  'GITLAB',
  'GOOGLE',
  'GOOGLE_OAUTH',
  'JWT',
  'NPM',
  'PEM',
  'SENDGRID',
  'SLACK',
  'STRIPE',
  'URI_CREDENTIALS',
  'WEBHOOK',
];

describe('shield: pattern catalog', () => {
  it('covers fifteen or more credential families', () => {
    assert.ok(SECRET_PATTERNS.length >= 15, `only ${SECRET_PATTERNS.length} patterns`);
    const ids = SECRET_PATTERNS.map((pattern) => pattern.id);
    for (const id of P0_IDS) assert.ok(ids.includes(id), `missing pattern ${id}`);
    for (const id of ['APIKEY', 'ENV']) assert.ok(ids.includes(id), `missing pattern ${id}`);
  });

  it('keeps blocking patterns at P0 and noisy ones at P1', () => {
    const severity = Object.fromEntries(SECRET_PATTERNS.map((pattern) => [pattern.id, pattern.severity]));
    for (const id of P0_IDS) assert.equal(severity[id], 'P0', `${id} must be P0`);
    assert.equal(severity.APIKEY, 'P1');
    assert.equal(severity.ENV, 'P1');
  });
});

describe('shield: redaction', () => {
  it('redacts every secret family and reports a P0 leak', () => {
    const result = shield(DIFF);
    assert.equal(result.leak, true);
    assert.ok(result.redactions >= 20, `expected 20+ redactions, got ${result.redactions}`);
    for (const [name, secret] of Object.entries(SECRETS)) {
      if (name === 'dbPassword' || name === 'awsSecret' || name === 'camelToken' || name === 'clientSecret') {
        continue;
      }
      if (name === 'databaseUrl') {
        assert.ok(!result.diffRedacted.includes('s3cretpass'), 'uri password leaked');
        continue;
      }
      assert.ok(!result.diffRedacted.includes(secret), `${name} leaked through the shield`);
    }
    assert.ok(result.diffRedacted.includes('[REDACTED_CREDENTIALS]@db.internal'));
    const p0 = result.hits.filter((hit) => hit.severity === 'P0').map((hit) => hit.id).sort();
    assert.deepEqual(p0, [...P0_IDS].sort());
  });

  it('catches identifiers with prefixes and camelCase assignments', () => {
    const assignments = [
      'DB_PASSWORD=hunter2hunter2',
      'AWS_SECRET_ACCESS_KEY=abc123def456ghi',
      'STRIPE_SECRET=whatever-value-123',
      'API_TOKEN=token-value-123',
      'const apiToken = "abcdef123456"',
      'clientSecret: "shhh-very-secret"',
    ];
    for (const line of assignments) {
      const result = shield(line);
      assert.equal(result.redactions, 1, `missed ${line}`);
      assert.equal(result.leak, false, 'assignment patterns are P1');
      assert.ok(!result.diffRedacted.includes('hunter2hunter2'));
    }
  });

  it('catches credentials inside a connection URI', () => {
    for (const uri of [
      'postgres://appuser:s3cretpass@db.internal:5432/app',
      'mysql://root:rootpass123@127.0.0.1/db',
      'mongodb+srv://admin:adminpass99@cluster.example.net/db',
    ]) {
      const result = shield(uri);
      assert.equal(result.leak, true, `missed ${uri}`);
      assert.ok(!result.diffRedacted.includes('@'.repeat(1) + '@'));
      assert.ok(result.diffRedacted.includes('[REDACTED_CREDENTIALS]@'));
    }
  });

  it('reports a clean diff as clean', () => {
    const clean = 'diff --git a/src/app.js b/src/app.js\n+console.log("hello")\n';
    const result = shield(clean);
    assert.equal(result.leak, false);
    assert.equal(result.redactions, 0);
    assert.deepEqual(result.hits, []);
    assert.equal(result.diffRedacted, clean);
  });

  it('never echoes the original secret in the findings payload', () => {
    const finding = secretLeakFinding();
    const serialized = JSON.stringify(finding);
    assert.equal(finding.id, SECRET_LEAK_FINDING_ID);
    assert.equal(finding.severity, 'P0');
    for (const secret of Object.values(SECRETS)) {
      assert.ok(!serialized.includes(secret));
    }
  });

  it('keeps the redacted text stable when applied twice', () => {
    const once = shield(DIFF).diffRedacted;
    assert.equal(shield(once).diffRedacted, once);
  });

  it('redacts a lone text payload through redactText', () => {
    assert.equal(redactText(`token ${SECRETS.github}`).includes(SECRETS.github), false);
  });
});

describe('shield: short circuit verdict', () => {
  it('forces BLOCK, exit 1 and a single P0 finding without running jurors', () => {
    const verdict = secretLeakVerdict({
      author: 'claude',
      jurors: [],
      probes: ['appsec'],
      redactions: 3,
      version: '0.1.0',
      durationMs: 12,
    });
    assert.equal(verdict.gate, 'BLOCK');
    assert.equal(verdict.exitCode, 1);
    assert.deepEqual(verdict.counts, { P0: 1, P1: 0, P2: 0 });
    assert.equal(verdict.secretShield.leak, true);
    assert.equal(verdict.secretShield.redactions, 3);
    assert.equal(verdict.findings.length, 1);
    assert.equal(verdict.findings[0].id, 'SL-001');
    assert.equal(verdict.findings[0].severity, 'P0');
    assert.equal(verdict.findings[0].cwe, 'CWE-798');
    assert.deepEqual(verdict.errors, []);
  });
});
