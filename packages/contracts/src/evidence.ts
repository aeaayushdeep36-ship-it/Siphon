import { z } from 'zod';
import { CheckId, Digest, Finite, Id, SchemaVersion } from './common.js';

const magnitude = Finite.nonnegative();
const support = z
  .strictObject({
    value: magnitude,
    unit: z.string().min(1).max(80),
    justification: z.string().min(1).max(2000),
    evidenceIds: z.array(Id).min(1).max(20),
  })
  .refine(
    (item) => new Set(item.evidenceIds).size === item.evidenceIds.length,
    { message: 'Duplicate support reference' },
  );

/** Output of a trusted, released check evaluator, never model-authored evidence.
 * Runtime validation cannot establish reference ownership or scientific truth.
 */
export const MetricEvidence = z
  .strictObject({
    schemaVersion: SchemaVersion,
    id: Id,
    auditId: Id,
    revisionId: Id,
    checkId: CheckId,
    checkVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    inputDigest: Digest,
    contextDigest: Digest,
    adapterDigest: Digest,
    planDigest: Digest,
    experimentIds: z.array(Id).min(1).max(8),
    metric: z.strictObject({
      name: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
      value: magnitude,
      unit: z.string().min(1).max(80),
      normalization: z.literal('absolute'),
    }),
    target: support.nullable(),
    uncertainty: support.nullable(),
    interval: z.strictObject({ lower: magnitude, upper: magnitude }).nullable(),
    status: z.enum(['passed_within_tolerance', 'flagged', 'inconclusive']),
    reason: z.enum([
      'whole_interval_within_target',
      'whole_interval_exceeds_target',
      'interval_overlaps_target',
      'missing_target',
      'missing_uncertainty_bound',
      'unrepresentable_interval',
    ]),
    limitations: z.array(z.string().min(1).max(1000)).min(1).max(20),
  })
  .superRefine((item, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: 'custom', message });
    if (new Set(item.experimentIds).size !== item.experimentIds.length)
      issue('Duplicate experiment reference');
    for (const supporting of [item.target, item.uncertainty])
      if (supporting && supporting.unit !== item.metric.unit)
        issue('Metric and support units must match');
    if (!item.target || !item.uncertainty) {
      if (
        item.status !== 'inconclusive' ||
        item.interval !== null ||
        item.reason !==
          (!item.target ? 'missing_target' : 'missing_uncertainty_bound')
      )
        issue('Missing support must be inconclusive without an interval');
      return;
    }
    if (!item.interval) {
      if (
        item.status !== 'inconclusive' ||
        item.reason !== 'unrepresentable_interval' ||
        item.metric.value + item.uncertainty.value < Number.MAX_VALUE ||
        item.uncertainty.value === 0
      )
        issue('Missing interval requires an unrepresentable upper bound');
      return;
    }
    const { lower, upper } = item.interval;
    const rawLower = Math.max(0, item.metric.value - item.uncertainty.value);
    const rawUpper = item.metric.value + item.uncertainty.value;
    if (
      item.uncertainty.value > 0 &&
      (upper <= rawUpper || (rawLower > 0 && lower >= rawLower))
    )
      issue('Nonzero uncertainty requires outward-rounded endpoints');
    if (
      lower > upper ||
      lower > rawLower ||
      upper < rawUpper ||
      lower > item.metric.value ||
      upper < item.metric.value
    )
      issue('Interval cannot understate metric uncertainty');
    if (
      item.uncertainty.value === 0 &&
      (lower !== item.metric.value || upper !== item.metric.value)
    )
      issue('Zero-bound interval must equal metric');
    const expected =
      upper <= item.target.value
        ? ['passed_within_tolerance', 'whole_interval_within_target']
        : lower > item.target.value
          ? ['flagged', 'whole_interval_exceeds_target']
          : ['inconclusive', 'interval_overlaps_target'];
    if (item.status !== expected[0] || item.reason !== expected[1])
      issue('Verdict contradicts interval and target');
  });
export type MetricEvidence = z.infer<typeof MetricEvidence>;
