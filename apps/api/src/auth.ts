import {
  decodeProtectedHeader,
  importX509,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import { z } from 'zod';
import { readJsonBounded } from './http.js';

const certificatesUrl =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
export class IdentityError extends Error {
  constructor(
    public readonly code: 'invalid_credentials' | 'identity_unavailable',
  ) {
    super(code);
  }
}
export type Identity = { uid: string; authTime: number };

/** Cache is only for public signing certificates, never for invitations or authorization. */
export function firebaseCertificateResolver(
  transport: typeof fetch = fetch,
  clock: () => number = Date.now,
): JWTVerifyGetKey {
  let cached: Record<string, string> = {};
  let expiresAt = 0;
  let loading: Promise<void> | null = null;
  const keys = new Map<string, CryptoKey>();
  async function refresh(): Promise<void> {
    let phase = 'fetch';
    try {
      const response = await transport(certificatesUrl, {
        signal: AbortSignal.timeout(5000),
        redirect: 'follow',
      });
      if (response.redirected) {
        phase = 'redirect';
        const finalUrl = new URL(response.url);
        if (
          finalUrl.origin !== 'https://www.googleapis.com' ||
          finalUrl.pathname !==
            '/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com' ||
          finalUrl.search
        ) {
          await response.body?.cancel();
          throw new Error('Unexpected certificate redirect');
        }
      }
      if (!response.ok) {
        phase = `http_${response.status}`;
        await response.body?.cancel();
        throw new Error('Key service unavailable');
      }
      phase = 'parse';
      const certificates = z
        .record(z.string().min(1).max(200), z.string().min(1).max(10000))
        .parse(await readJsonBounded(response, 64 * 1024));
      if (
        !Object.keys(certificates).length ||
        Object.keys(certificates).length > 20
      )
        throw new Error('Invalid certificate count');
      phase = 'cache';
      const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(
        response.headers.get('cache-control') ?? '',
      );
      const seconds = maxAge?.[1] ? Number(maxAge[1]) : 0;
      const age = Number(response.headers.get('age') ?? '0');
      if (!Number.isFinite(seconds) || !Number.isFinite(age) || age < 0)
        throw new Error('Invalid key cache age');
      cached = certificates;
      keys.clear();
      expiresAt = clock() + Math.max(0, Math.min(seconds - age, 86400)) * 1000;
    } catch (error) {
      const kind =
        error instanceof Error &&
        ['TypeError', 'TimeoutError', 'AbortError'].includes(error.name)
          ? error.name
          : 'other';
      const cause = error instanceof Error ? error.cause : undefined;
      const causeKind =
        cause instanceof Error &&
        ['TypeError', 'TimeoutError', 'AbortError'].includes(cause.name)
          ? cause.name
          : 'none';
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      const safeMessage = message.includes('redirect')
        ? 'redirect'
        : message.includes('timeout') || message.includes('timed out')
          ? 'timeout'
          : message.includes('abort')
            ? 'abort'
            : message.includes('network') || message.includes('connect')
              ? 'network'
              : message.includes('fetch')
                ? 'fetch'
                : 'unavailable';
      console.error(
        'firebase_certificate_refresh_failed',
        phase,
        kind,
        causeKind,
        safeMessage,
      );
      throw new IdentityError('identity_unavailable');
    }
  }
  return async (header) => {
    if (header.alg !== 'RS256' || !header.kid || header.kid.length > 200)
      throw new IdentityError('invalid_credentials');
    if (clock() >= expiresAt) {
      loading ??= refresh().finally(() => {
        loading = null;
      });
      await loading;
    }
    const certificate = Object.hasOwn(cached, header.kid)
      ? cached[header.kid]
      : undefined;
    if (!certificate) throw new IdentityError('invalid_credentials');
    let key = keys.get(header.kid);
    if (!key) {
      try {
        key = await importX509(certificate, 'RS256');
      } catch {
        console.error('firebase_certificate_import_failed');
        throw new IdentityError('identity_unavailable');
      }
      keys.set(header.kid, key);
    }
    return key;
  };
}

const claimsSchema = z.object({
  sub: z.string().min(1).max(128),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  auth_time: z.number().int().nonnegative(),
  firebase: z.object({ sign_in_provider: z.literal('google.com') }),
});

export async function verifyFirebaseIdentity(
  token: string,
  projectId: string,
  resolveKey: JWTVerifyGetKey,
  currentDate = new Date(),
): Promise<Identity> {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId))
    throw new IdentityError('identity_unavailable');
  try {
    if (token.length > 16 * 1024)
      throw new IdentityError('invalid_credentials');
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'RS256' || !header.kid)
      throw new IdentityError('invalid_credentials');
    const { payload } = await jwtVerify(token, resolveKey, {
      algorithms: ['RS256'],
      audience: projectId,
      issuer: `https://securetoken.google.com/${projectId}`,
      requiredClaims: ['sub', 'iat', 'exp', 'auth_time'],
      currentDate,
      clockTolerance: 0,
    });
    const claims = claimsSchema.parse(payload);
    const now = Math.floor(currentDate.getTime() / 1000);
    if (
      claims.iat > now ||
      claims.auth_time > now ||
      claims.auth_time > claims.iat ||
      claims.exp <= claims.iat
    )
      throw new IdentityError('invalid_credentials');
    return { uid: claims.sub, authTime: claims.auth_time };
  } catch (error) {
    if (error instanceof IdentityError) throw error;
    throw new IdentityError('invalid_credentials');
  }
}
