import { beforeAll, describe, expect, it } from 'vitest';
import { exportPKCS8, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { firebaseCertificateResolver, verifyFirebaseIdentity } from './auth.js';
import { googleAccessTokenProvider } from './google-oauth.js';

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
const date = new Date('2026-10-28T00:00:00Z');
const epoch = date.getTime() / 1000;
beforeAll(async () => {
  keys = await generateKeyPair('RS256', { extractable: true });
});

async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({
    sub: 'alice',
    iss: 'https://securetoken.google.com/siphon-test',
    aud: 'siphon-test',
    iat: epoch - 60,
    auth_time: epoch - 60,
    exp: epoch + 60,
    firebase: { sign_in_provider: 'google.com' },
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .sign(keys.privateKey);
}

describe('Firebase ID verification', () => {
  it('accepts a genuinely signed Google identity for the configured project', async () => {
    expect(
      await verifyFirebaseIdentity(
        await token(),
        'siphon-test',
        async () => keys.publicKey,
        date,
      ),
    ).toEqual({ uid: 'alice', authTime: epoch - 60 });
  });
  it.each([
    { aud: 'another-project' },
    { iss: 'https://attacker.example' },
    { sub: '' },
    { exp: epoch - 1 },
    { iat: epoch + 1 },
    { auth_time: epoch + 1 },
    { firebase: { sign_in_provider: 'password' } },
    { auth_time: epoch - 10 },
  ])('rejects invalid signed claims %j', async (overrides) => {
    await expect(
      verifyFirebaseIdentity(
        await token(overrides),
        'siphon-test',
        async () => keys.publicKey,
        date,
      ),
    ).rejects.toThrow('invalid_credentials');
  });
  it('rejects forged signature and unsigned JWT', async () => {
    const otherKeys = await generateKeyPair('RS256');
    await expect(
      verifyFirebaseIdentity(
        await token(),
        'siphon-test',
        async () => otherKeys.publicKey,
        date,
      ),
    ).rejects.toThrow('invalid_credentials');
    await expect(
      verifyFirebaseIdentity(
        'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhbGljZSJ9.',
        'siphon-test',
        async () => keys.publicKey,
        date,
      ),
    ).rejects.toThrow('invalid_credentials');
  });
  it('does not refresh keys for each attacker-controlled unknown kid', async () => {
    let calls = 0;
    const resolver = firebaseCertificateResolver(
      async () => {
        calls++;
        return Response.json(
          { known: 'not-imported-by-this-test' },
          { headers: { 'cache-control': 'public, max-age=3600' } },
        );
      },
      () => date.getTime(),
    );
    for (let n = 0; n < 3; n++) {
      await expect(
        verifyFirebaseIdentity(await token(), 'siphon-test', resolver, date),
      ).rejects.toThrow('invalid_credentials');
    }
    expect(calls).toBe(1);
  });
  it('fails closed when certificate service is unavailable', async () => {
    const resolver = firebaseCertificateResolver(
      async () => new Response('', { status: 503 }),
    );
    await expect(
      verifyFirebaseIdentity(await token(), 'siphon-test', resolver, date),
    ).rejects.toThrow('identity_unavailable');
  });
});

describe('Google service authorization', () => {
  it('signs a scoped assertion and coalesces concurrent access-token refresh', async () => {
    let calls = 0;
    const provider = googleAccessTokenProvider(
      {
        projectId: 'siphon-test',
        clientEmail: 'backend@siphon-test.iam.gserviceaccount.com',
        privateKey: await exportPKCS8(keys.privateKey),
      },
      async (input, init) => {
        calls++;
        expect(String(input)).toBe('https://oauth2.googleapis.com/token');
        const params = init?.body as URLSearchParams;
        const assertion = params.get('assertion');
        expect(assertion).not.toBeNull();
        const result = await jwtVerify(assertion!, keys.publicKey, {
          currentDate: date,
          audience: 'https://oauth2.googleapis.com/token',
        });
        expect(result.payload.scope).toBe(
          'https://www.googleapis.com/auth/datastore',
        );
        return Response.json({
          access_token: 'test-only-token',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      },
      () => date.getTime(),
    );
    expect(await Promise.all([provider(), provider(), provider()])).toEqual([
      'test-only-token',
      'test-only-token',
      'test-only-token',
    ]);
    expect(await provider()).toBe('test-only-token');
    expect(calls).toBe(1);
  });
  it('rejects credentials belonging to an unrelated project', () => {
    expect(() =>
      googleAccessTokenProvider({
        projectId: 'siphon-test',
        clientEmail: 'backend@other.iam.gserviceaccount.com',
        privateKey: 'not-a-key',
      }),
    ).toThrow('configured');
  });
});
