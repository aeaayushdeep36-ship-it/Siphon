import { z } from 'zod';
import { Count, SchemaVersion } from './common.js';

const ObservationComparison = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  status: z.enum(['matched', 'mismatched']),
  reason: z
    .enum([
      'missing_both',
      'missing_original',
      'missing_adapted',
      'shape_mismatch',
      'value_mismatch',
    ])
    .nullable(),
});

/** Numerical comparison only, not complete adapter verification/authorization. */
export const BaselineComparison = z
  .strictObject({
    schemaVersion: SchemaVersion,
    status: z.enum(['matched', 'mismatched']),
    comparedElements: Count,
    observations: z.array(ObservationComparison).min(1).max(64),
  })
  .superRefine((result, ctx) => {
    if (
      new Set(result.observations.map((item) => item.key)).size !==
      result.observations.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Duplicate observation identifier',
      });
    for (const item of result.observations)
      if ((item.status === 'matched') !== (item.reason === null))
        ctx.addIssue({
          code: 'custom',
          message: 'Observation status contradicts reason',
        });
    if (
      (result.status === 'matched') !==
      result.observations.every((item) => item.status === 'matched')
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Aggregate comparison contradicts observations',
      });
    if (
      result.status === 'matched' &&
      result.comparedElements < result.observations.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Matched observations must contain elements',
      });
  });
export type BaselineComparison = z.infer<typeof BaselineComparison>;
