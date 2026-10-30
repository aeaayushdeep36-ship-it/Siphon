import { describe, expect, it } from 'vitest';
import { MetricEvidence } from '../src/index.js';

function fixture() {
  const support = {
    value: 1,
    unit: 'J',
    justification: 'Authored test target.',
    evidenceIds: [crypto.randomUUID()],
  };
  return {
    schemaVersion: '1.0',
    id: crypto.randomUUID(),
    auditId: crypto.randomUUID(),
    revisionId: crypto.randomUUID(),
    checkId: 'H_ENERGY',
    checkVersion: '0.1.0',
    inputDigest: 'a'.repeat(64),
    contextDigest: 'b'.repeat(64),
    adapterDigest: 'c'.repeat(64),
    planDigest: 'd'.repeat(64),
    experimentIds: [crypto.randomUUID()],
    metric: {
      name: 'maximum_energy_change',
      value: 0.5,
      unit: 'J',
      normalization: 'absolute',
    },
    target: support,
    uncertainty: { ...support, value: 0.1 },
    interval: { lower: 0.399, upper: 0.601 },
    status: 'passed_within_tolerance',
    reason: 'whole_interval_within_target',
    limitations: ['Does not establish trajectory accuracy.'],
  };
}
describe('scientific metric evidence boundary', () => {
  it('accepts supported absolute intervals and rejects an unsupported pass', () => {
    expect(MetricEvidence.safeParse(fixture()).success).toBe(true);
    expect(
      MetricEvidence.safeParse({ ...fixture(), uncertainty: null }).success,
    ).toBe(false);
    expect(
      MetricEvidence.safeParse({ ...fixture(), target: null }).success,
    ).toBe(false);
  });
  it('requires matching units, references and stated limitations', () => {
    const f = fixture();
    for (const invalid of [
      { ...f, uncertainty: { ...f.uncertainty, unit: 'K' } },
      { ...f, target: { ...f.target, evidenceIds: [] } },
      { ...f, limitations: [] },
    ])
      expect(MetricEvidence.safeParse(invalid).success).toBe(false);
  });
  it('rejects understated uncertainty and verdicts contrary to interval', () => {
    expect(
      MetricEvidence.safeParse({
        ...fixture(),
        interval: { lower: 0.5, upper: 0.5 },
      }).success,
    ).toBe(false);
    expect(
      MetricEvidence.safeParse({
        ...fixture(),
        status: 'flagged',
        reason: 'whole_interval_exceeds_target',
      }).success,
    ).toBe(false);
  });
  it('accepts missing support only as explicitly inconclusive', () => {
    expect(
      MetricEvidence.safeParse({
        ...fixture(),
        target: null,
        interval: null,
        status: 'inconclusive',
        reason: 'missing_target',
      }).success,
    ).toBe(true);
  });
  it('rejects duplicate experiments, arbitrary scores and nonfinite metrics', () => {
    const f = fixture();
    for (const invalid of [
      { ...f, experimentIds: [...f.experimentIds, ...f.experimentIds] },
      { ...f, score: 100 },
      { ...f, metric: { ...f.metric, value: NaN } },
    ])
      expect(MetricEvidence.safeParse(invalid).success).toBe(false);
  });
});
