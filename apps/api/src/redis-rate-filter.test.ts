import { describe, expect, it, vi } from 'vitest';
import { RedisRateFilter } from './redis-rate-filter.js';
import { DEFAULT_POLICY } from '@siphon/contracts';

describe('optional Redis rate prefilter', () => {
  it('hashes user identity, sends one atomic command, and retains the Firestore gate', async () => {
    const downstream = { consume: vi.fn(async () => {}) },
      transport = vi.fn<typeof fetch>(async () => Response.json({ result: 1 }));
    const gate = new RedisRateFilter(
      'https://fixture.upstash.io',
      'authored-key',
      downstream,
      transport,
      () => 120000,
    );
    await gate.consume('private-user', true);
    const call = transport.mock.calls[0]!;
    const body = JSON.parse(String(call[1]?.body));
    expect(body[0]).toBe('EVAL');
    expect(body[3]).not.toContain('private-user');
    expect(body[3]).toMatch(/^siphon:rate:v1:[a-f0-9]{64}:2$/);
    expect(downstream.consume).toHaveBeenCalledWith('private-user', true);
  });
  it('fails closed for over-limit, unavailable or oversized responses without invoking downstream', async () => {
    for (const response of [
      Response.json({ result: DEFAULT_POLICY.requestsPerMinute + 1 }),
      new Response('private error', { status: 503 }),
      new Response('x'.repeat(1025)),
    ]) {
      const downstream = { consume: vi.fn(async () => {}) },
        gate = new RedisRateFilter(
          'https://fixture.upstash.io',
          'authored-key',
          downstream,
          async () => response,
        );
      await expect(gate.consume('alice', false)).rejects.toMatchObject({
        status:
          response.status === 200 &&
          response.headers.get('content-type')?.includes('json')
            ? 429
            : 503,
      });
      expect(downstream.consume).not.toHaveBeenCalled();
    }
  });
  it('rejects arbitrary or credential-bearing origins before network access', () => {
    for (const url of [
      'http://fixture.upstash.io',
      'https://evil.example',
      'https://user:pass@fixture.upstash.io',
      'https://fixture.upstash.io/path',
    ])
      expect(
        () => new RedisRateFilter(url, 'key', { consume: async () => {} }),
      ).toThrow();
  });
});
