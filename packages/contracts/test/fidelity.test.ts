import { describe, expect, it } from 'vitest';
import { BaselineComparison } from '../src/index.js';

const matched = {
  schemaVersion: '1.0',
  status: 'matched',
  comparedElements: 1,
  observations: [{ key: 'time', status: 'matched', reason: null }],
};
describe('baseline comparison contract', () => {
  it('accepts consistent comparisons and rejects contradictory aggregate status', () => {
    expect(BaselineComparison.safeParse(matched).success).toBe(true);
    expect(
      BaselineComparison.safeParse({ ...matched, status: 'mismatched' })
        .success,
    ).toBe(false);
    expect(
      BaselineComparison.safeParse({
        ...matched,
        observations: [
          { key: 'time', status: 'matched', reason: 'value_mismatch' },
        ],
      }).success,
    ).toBe(false);
  });
  it('rejects empty/duplicate observations and empty successful comparisons', () => {
    for (const value of [
      { ...matched, observations: [] },
      {
        ...matched,
        observations: [...matched.observations, ...matched.observations],
      },
      { ...matched, comparedElements: 0 },
    ])
      expect(BaselineComparison.safeParse(value).success).toBe(false);
  });
  it('does not accept generated source or unbounded raw numeric output', () => {
    expect(
      BaselineComparison.safeParse({ ...matched, replacementCode: 'x=1' })
        .success,
    ).toBe(false);
    expect(
      BaselineComparison.safeParse({
        ...matched,
        observations: [{ ...matched.observations[0], values: [1] }],
      }).success,
    ).toBe(false);
  });
});
