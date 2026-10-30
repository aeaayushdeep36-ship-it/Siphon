import { describe, expect, it } from 'vitest';
import { reserveMetaCost, settleMetaCost } from './meta-pricing.js';

// Explicit authored price fixture; this does not configure a live account.
const pricing = {
  schemaVersion: '1.0',
  version: 'fixture',
  model: 'muse-wonder-1.0',
  mode: 'standard',
  verifiedAt: '2026-10-28T00:00:00Z',
  effectiveFrom: '2026-10-28T00:00:00Z',
  effectiveUntil: '2026-10-29T00:00:00Z',
  inputMicroUsdPerMillion: 4_000_000,
  cachedInputMicroUsdPerMillion: 200_000,
  outputMicroUsdPerMillion: 20_000_000,
};
const now = new Date('2026-10-28T01:00:00Z');
describe('dated Meta price accounting', () => {
  it('reserves uncached input and all billable output at exact integer cost', () => {
    expect(reserveMetaCost(pricing, 24000, 4000, now)).toEqual({
      pricingVersion: 'fixture',
      microUsd: 176001,
    });
  });
  it('settles observed cache discounts without counting reasoning twice', () => {
    expect(
      settleMetaCost(pricing, {
        prompt_tokens: 1000,
        completion_tokens: 100,
        total_tokens: 1100,
        prompt_tokens_details: { cached_tokens: 500 },
      }),
    ).toBe(4100);
  });
  it('rounds fractional micro-USD upward per category', () => {
    expect(
      settleMetaCost(pricing, {
        prompt_tokens: 1,
        completion_tokens: 0,
        total_tokens: 1,
        prompt_tokens_details: { cached_tokens: 1 },
      }),
    ).toBe(1);
  });
  it('denies expired/future pricing while preserving settlement of prior work', () => {
    for (const date of ['2026-10-27T00:00:00Z', '2026-10-29T00:00:00Z'])
      expect(() => reserveMetaCost(pricing, 1, 1, new Date(date))).toThrow();
    expect(
      settleMetaCost(pricing, {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      }),
    ).toBe(24);
  });
  it('rejects inconsistent usage and invalid rates rather than producing negative costs', () => {
    expect(() =>
      settleMetaCost(pricing, {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        prompt_tokens_details: { cached_tokens: 2 },
      }),
    ).toThrow();
    expect(() =>
      reserveMetaCost({ ...pricing, inputMicroUsdPerMillion: -1 }, 1, 1, now),
    ).toThrow();
    expect(() => reserveMetaCost(pricing, 1.5, 1, now)).toThrow();
  });
  it('covers independently rounded cache categories and rejects aggregate overflow', () => {
    const fractional = {
      ...pricing,
      inputMicroUsdPerMillion: 100001,
      cachedInputMicroUsdPerMillion: 100001,
      outputMicroUsdPerMillion: 100001,
    };
    const bound = reserveMetaCost(fractional, 2, 1, now).microUsd;
    expect(
      settleMetaCost(fractional, {
        prompt_tokens: 2,
        completion_tokens: 1,
        total_tokens: 3,
        prompt_tokens_details: { cached_tokens: 1 },
      }),
    ).toBeLessThanOrEqual(bound);
    expect(() =>
      reserveMetaCost(
        pricing,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
        now,
      ),
    ).toThrow();
  });
});
