import { DEFAULT_POLICY } from '@siphon/contracts';
import { z } from 'zod';
import { sha256 } from './hashing.js';
import { ApiError } from './errors.js';
import { type UserRateGate } from './rate-limit.js';
import { readJsonBounded } from './http.js';

// Atomic, stricter supplementary fixed-minute filter. Firestore remains the
// authoritative rolling-window gate and all financial/job state stays there.
const script = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],120) end; return n`;
export class RedisRateFilter implements UserRateGate {
  private readonly origin: string;
  constructor(
    url: string,
    private readonly token: string,
    private readonly downstream: UserRateGate,
    private readonly transport: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      !/^[a-z0-9-]+\.upstash\.io$/.test(parsed.hostname) ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      !/^[\x21-\x7e]{1,512}$/.test(token)
    )
      throw new Error('Invalid Redis service configuration');
    this.origin = parsed.origin;
  }
  async consume(uid: string, mutation: boolean) {
    const now = this.clock(),
      minute = Math.floor(now / 60000),
      key = `siphon:rate:v1:${await sha256(uid)}:${minute}`;
    let response: Response;
    try {
      const deadline = AbortSignal.timeout(3000);
      response = await this.transport(this.origin, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(['EVAL', script, 1, key]),
        signal: deadline,
        redirect: 'error',
      });
      if (!response.ok) throw new Error('unavailable');
      const count = z
        .strictObject({
          result: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        })
        .parse(await readJsonBounded(response, 1024, deadline)).result;
      if (count > DEFAULT_POLICY.requestsPerMinute)
        throw new ApiError(
          429,
          'rate_limited',
          'Request limit reached. Try again shortly.',
          true,
        );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        503,
        'rate_limit_unavailable',
        'Request protection is temporarily unavailable.',
        true,
      );
    }
    await this.downstream.consume(uid, mutation);
  }
}
