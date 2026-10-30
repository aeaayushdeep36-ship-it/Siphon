import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importPKCS8, importX509, jwtVerify, SignJWT } from 'jose';
import worker, {
  createWorkerRuntime,
  type WorkerEnvironment,
} from './worker.js';
import { WorkerConfiguration } from './worker-config.js';
import { decodeValue, encodeValue, type FirestoreValue } from './firestore.js';

let directory: string, privateKeyPem: string, certificate: string;
let signingKey: CryptoKey, publicKey: CryptoKey;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'siphon-worker-auth-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'cert.pem'),
      '-subj',
      '/CN=Siphon-offline-fixture',
      '-days',
      '1',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  privateKeyPem = readFileSync(join(directory, 'key.pem'), 'utf8');
  certificate = readFileSync(join(directory, 'cert.pem'), 'utf8');
  signingKey = await importPKCS8(privateKeyPem, 'RS256');
  publicKey = await importX509(certificate, 'RS256');
});
afterAll(() => {
  if (!directory) return;
  // Remove only the two generated fixture files, without recursive deletion.
  unlinkSync(join(directory, 'key.pem'));
  unlinkSync(join(directory, 'cert.pem'));
  rmdirSync(directory);
});

function environment(): WorkerEnvironment {
  return {
    SIPHON_API_ENABLED: 'true',
    FIREBASE_PROJECT_ID: 'siphon-test',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: 'api@siphon-test.iam.gserviceaccount.com',
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKeyPem,
    SIPHON_ALLOWED_ORIGINS: '["https://siphon.example"]',
    SIPHON_ARTIFACTS: {
      put: vi.fn(async () => null),
      get: vi.fn(async () => null),
    },
    SIPHON_EDGE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
  };
}

async function identityToken() {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: 'alice',
    iss: 'https://securetoken.google.com/siphon-test',
    aud: 'siphon-test',
    iat: now - 10,
    auth_time: now - 10,
    exp: now + 3600,
    firebase: { sign_in_provider: 'google.com' },
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'offline-cert' })
    .sign(signingKey);
}

function firestoreTransport() {
  const documents = new Map<string, unknown>([
    ['testers/alice', { active: true }],
  ]);
  let certificateCalls = 0,
    oauthCalls = 0,
    assertionsVerified = 0,
    firestoreCalls = 0;
  const transport: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('https://www.googleapis.com/robot/')) {
      certificateCalls++;
      return Response.json(
        { 'offline-cert': certificate },
        { headers: { 'cache-control': 'public, max-age=3600' } },
      );
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      oauthCalls++;
      const assertion = new URLSearchParams(String(init.body)).get(
        'assertion',
      )!;
      const verified = await jwtVerify(assertion, publicKey, {
        algorithms: ['RS256'],
        issuer: 'api@siphon-test.iam.gserviceaccount.com',
        audience: url,
      });
      expect(verified.payload.scope).toBe(
        'https://www.googleapis.com/auth/datastore',
      );
      assertionsVerified++;
      return Response.json({
        access_token: 'offline-access-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    if (
      !url.startsWith(
        'https://firestore.googleapis.com/v1/projects/siphon-test/databases/(default)/documents',
      )
    )
      throw new Error('Unexpected offline destination');
    firestoreCalls++;
    expect(new Headers(init.headers).get('authorization')).toBe(
      'Bearer offline-access-token',
    );
    if (url.endsWith(':beginTransaction'))
      return Response.json({ transaction: 'offline-transaction' });
    if (url.endsWith(':rollback')) return Response.json({});
    if (url.endsWith(':batchGet')) {
      const body = JSON.parse(String(init.body)) as { documents: string[] };
      return Response.json(
        body.documents
          .map((name) => {
            const record = documents.get(name.split('/documents/')[1]!);
            if (!record) return { missing: name };
            const encoded = encodeValue(record);
            if (!('mapValue' in encoded))
              throw new Error('Invalid fixture record');
            return { found: { name, fields: encoded.mapValue.fields } };
          })
          .reverse(),
      );
    }
    if (url.endsWith(':commit')) {
      const body = JSON.parse(String(init.body)) as {
        writes: Array<{
          update?: { name: string; fields: Record<string, FirestoreValue> };
          delete?: string;
        }>;
      };
      for (const write of body.writes) {
        const path = (write.update?.name ?? write.delete!).split(
          '/documents/',
        )[1]!;
        if (write.update)
          documents.set(
            path,
            decodeValue({ mapValue: { fields: write.update.fields } }),
          );
        else documents.delete(path);
      }
      return Response.json({ writeResults: [] });
    }
    const path = new URL(url).pathname.split('/documents/')[1]!;
    const record = documents.get(path);
    if (!record) return new Response(null, { status: 404 });
    const encoded = encodeValue(record);
    if (!('mapValue' in encoded)) throw new Error('Invalid fixture record');
    return Response.json({ fields: encoded.mapValue.fields });
  };
  return {
    transport,
    documents,
    counts: () => ({
      certificateCalls,
      oauthCalls,
      assertionsVerified,
      firestoreCalls,
    }),
  };
}

describe('Cloudflare API composition (offline)', () => {
  it('verifies a signed Firebase token, signs OAuth and creates/replays a private audit through real service wiring', async () => {
    const f = firestoreTransport();
    const env = environment();
    const runtime = createWorkerRuntime(env, f.transport);
    const token = await identityToken();
    const create = () =>
      runtime.request('/api/v1/audits', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'offline-create',
          Origin: 'https://siphon.example',
          'CF-Connecting-IP': '192.0.2.1',
        },
        body: JSON.stringify({
          schemaVersion: '1.0',
          title: 'Runtime composition',
          domain: 'orbital_dynamics',
        }),
      });
    const first = await create();
    expect(first.status).toBe(201);
    const body = (await first.json()) as {
      audit: { id: string; ownerUid: string };
    };
    expect(body.audit.ownerUid).toBe('alice');
    expect((await create()).status).toBe(200);
    expect(f.counts()).toMatchObject({
      certificateCalls: 1,
      oauthCalls: 1,
      assertionsVerified: 1,
    });
    const limiter = vi.mocked(env.SIPHON_EDGE_LIMITER.limit);
    expect(limiter.mock.calls[0]![0].key).toMatch(
      /^siphon-edge-v1:[a-f0-9]{64}$/,
    );
    expect(JSON.stringify(limiter.mock.calls)).not.toContain('192.0.2.1');
    f.documents.set('testers/alice', { active: false });
    expect(
      (
        await runtime.request(`/api/v1/audits/${body.audit.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);
  });
  it('denies edge traffic and disallowed origins before certificate/OAuth/database requests', async () => {
    const env = environment();
    const transport = vi.fn<typeof fetch>(async () => {
      throw new Error('must not contact provider');
    });
    const runtime = createWorkerRuntime(env, transport);
    vi.mocked(env.SIPHON_EDGE_LIMITER.limit).mockResolvedValueOnce({
      success: false,
    });
    expect(
      (await runtime.request('/api/v1/audits', { method: 'POST' })).status,
    ).toBe(429);
    expect(
      (
        await runtime.request('/api/v1/audits', {
          headers: {
            Origin: 'https://attacker.example',
            Authorization: 'Bearer forged',
          },
        })
      ).status,
    ).toBe(403);
    expect(transport).not.toHaveBeenCalled();
  });
  it('permits only configured preflight origins and never calls Google or storage for OPTIONS', async () => {
    const env = environment();
    const transport = vi.fn<typeof fetch>(async () => {
      throw new Error('must not contact provider');
    });
    const result = await createWorkerRuntime(env, transport).request(
      '/api/v1/audits',
      { method: 'OPTIONS', headers: { Origin: 'https://siphon.example' } },
    );
    expect(result.status).toBe(204);
    expect(result.headers.get('access-control-allow-origin')).toBe(
      'https://siphon.example',
    );
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'origins', 'project', 'binding', 'private_key'])(
    'fails closed for %s without exposing configuration or secret values',
    async (kind) => {
      const env = environment();
      if (kind === 'disabled') env.SIPHON_API_ENABLED = 'false';
      if (kind === 'origins') env.SIPHON_ALLOWED_ORIGINS = '*';
      if (kind === 'project') env.FIREBASE_PROJECT_ID = 'wrong/project';
      if (kind === 'binding') delete env.SIPHON_ARTIFACTS;
      if (kind === 'private_key')
        env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = 'private-marker';
      const response = await worker.fetch(
        new Request('https://siphon.example/api/v1/audits'),
        env,
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const text = await response.text();
      expect(text).not.toContain('private-marker');
      expect(text).not.toContain('siphon-test');
      expect(text).not.toContain('BEGIN PRIVATE KEY');
    },
  );
  it.each([
    'https://siphon.example/',
    'https://siphon.example/path',
    'http://public.example',
    '*',
    'null',
  ])('rejects unsafe origin configuration %s', (value) => {
    expect(
      WorkerConfiguration.safeParse({
        ...environment(),
        SIPHON_ALLOWED_ORIGINS: JSON.stringify([value]),
      }).success,
    ).toBe(false);
  });
});
