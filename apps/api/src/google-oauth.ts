import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import { readJsonBounded } from './http.js';

const serviceAccount = z.strictObject({
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  clientEmail: z.email(),
  privateKey: z.string().min(1),
});
const tokenEndpoint = 'https://oauth2.googleapis.com/token';

/** OAuth credentials remain in the Worker. Returned access tokens never enter a sandbox. */
export function googleAccessTokenProvider(
  input: z.infer<typeof serviceAccount>,
  transport: typeof fetch = fetch,
  clock: () => number = Date.now,
): () => Promise<string> {
  const config = serviceAccount.parse(input);
  if (
    !config.clientEmail.endsWith(`@${config.projectId}.iam.gserviceaccount.com`)
  )
    throw new Error(
      'Service account must belong to the configured Firebase project',
    );
  let privateKey: Promise<CryptoKey> | null = null;
  let cached: { token: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;
  async function exchange(): Promise<string> {
    try {
      privateKey ??= importPKCS8(config.privateKey, 'RS256');
      const issued = Math.floor(clock() / 1000);
      const assertion = await new SignJWT({
        scope: 'https://www.googleapis.com/auth/datastore',
      })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .setIssuer(config.clientEmail)
        .setAudience(tokenEndpoint)
        .setIssuedAt(issued)
        .setExpirationTime(issued + 3600)
        .sign(await privateKey);
      const response = await transport(tokenEndpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('OAuth exchange failed');
      }
      const result = z
        .object({
          access_token: z.string().min(1).max(10000),
          token_type: z.literal('Bearer'),
          expires_in: z.number().int().positive().max(3600),
        })
        .parse(await readJsonBounded(response, 16 * 1024));
      // Anchor expiration to request creation, not delayed response arrival.
      cached = {
        token: result.access_token,
        expiresAt: (issued + result.expires_in - 60) * 1000,
      };
      return cached.token;
    } catch {
      throw new Error('Google service authorization unavailable');
    }
  }
  return async () => {
    if (cached && clock() < cached.expiresAt) return cached.token;
    pending ??= exchange().finally(() => {
      pending = null;
    });
    return pending;
  };
}
