import { z } from 'zod';
import { Count, Digest, Finite, Id, SchemaVersion } from './common.js';
import { ObservationValidationRequest } from './source-job.js';
import { DEFAULT_POLICY } from './policy.js';

export const DiagnosticProfile = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('central_orbit_si') }),
  z.strictObject({ kind: z.literal('isolated_orbits_si') }),
  ...(['heat_energy_si', 'heat_balance_si'] as const).map((kind) =>
    z.strictObject({
      kind: z.literal(kind),
      densityKgM3: Finite.positive(),
      heatCapacityJKgK: Finite.positive(),
    }),
  ),
]);
export type DiagnosticProfile = z.infer<typeof DiagnosticProfile>;

/** Internal measurement request. This is not check eligibility or dispatch permission. */
export const DiagnosticJobRequest = z
  .strictObject({
    schemaVersion: SchemaVersion,
    auditId: Id,
    revisionId: Id,
    operationId: Id,
    contextDigest: Digest,
    validation: ObservationValidationRequest,
    profile: DiagnosticProfile,
  })
  .superRefine((request, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const validation = request.validation;
    if (
      [validation.evaluationOperationId, validation.sourceOperationId].includes(
        request.operationId,
      )
    )
      fail('Diagnostics require a distinct operation');
    const shape = (key: string, unit: string): number[] => {
      const item = validation.mappings.find((entry) => entry.key === key);
      if (!item || item.declaredUnit !== unit) {
        fail(`Missing diagnostic observation or explicit SI unit: ${key}`);
        return [];
      }
      return item.expectedShape;
    };
    const times = shape('times', 's');
    if (times.length !== 1 || (times[0] ?? 0) < 2)
      fail('At least two time samples required');
    const same = (a: number[], b: number[]) =>
      JSON.stringify(a) === JSON.stringify(b);
    if (request.profile.kind.startsWith('heat_')) {
      const temperature = shape('temperature', 'K');
      const weights = shape('thermal_weights', 'm^3');
      if (
        ![2, 3].includes(temperature.length) ||
        temperature[0] !== times[0] ||
        !same(weights, temperature.slice(1)) ||
        weights.reduce((a, b) => a * b, 1) > DEFAULT_POLICY.heatCells
      )
        fail('Heat diagnostic shape or cell limit mismatch');
      if (request.profile.kind === 'heat_balance_si')
        for (const key of ['source_power', 'outward_power'])
          if (!same(shape(key, 'W'), times))
            fail('Power samples must match times');
    } else {
      const positions = shape('positions', 'm');
      if (
        positions.length !== 3 ||
        positions[0] !== times[0] ||
        ![2, 3].includes(positions[2] ?? 0) ||
        !same(positions, shape('velocities', 'm/s'))
      )
        fail('Orbital diagnostic shape mismatch');
      if (request.profile.kind === 'central_orbit_si') {
        if (positions[1] !== 1 || !same(shape('central_mu', 'm^3/s^2'), []))
          fail('Central profile requires one body and scalar mu');
      } else if (
        (positions[1] ?? 0) < 2 ||
        (positions[1] ?? Infinity) > DEFAULT_POLICY.orbitalBodies ||
        !same(shape('masses', 'kg'), [positions[1] ?? 0]) ||
        !same(shape('gravity_constant', 'm^3/(kg*s^2)'), [])
      )
        fail(
          'Isolated profile requires matching masses, scalar G and body limits',
        );
    }
  });

export const DIAGNOSTIC_METRICS = {
  central_orbit_si: [
    ['specific_energy_drift', 'm^2/s^2'],
    ['specific_angular_momentum_drift', 'm^2/s'],
  ],
  isolated_orbits_si: [
    ['total_energy_drift', 'J'],
    ['angular_momentum_drift', 'kg*m^2/s'],
    ['linear_momentum_drift', 'kg*m/s'],
  ],
  heat_energy_si: [['thermal_energy_change', 'J']],
  heat_balance_si: [['heat_balance_residual', 'J']],
} as const;

export const DiagnosticJobResult = z
  .strictObject({
    schemaVersion: SchemaVersion,
    auditId: Id,
    revisionId: Id,
    operationId: Id,
    validationOperationId: Id,
    sourceOperationId: Id,
    inputDigest: Digest,
    contextDigest: Digest,
    adapterDigest: Digest,
    profile: DiagnosticProfile,
    kind: z.literal('numeric_diagnostics'),
    methodVersion: z.literal('0.1.0'),
    sampleCount: Count.min(2),
    timeRangeSeconds: z.tuple([Finite, Finite]),
    metrics: z
      .array(
        z.strictObject({
          name: z.string(),
          unit: z.string(),
          value: Finite.nonnegative(),
          normalization: z.literal('absolute'),
          status: z.literal('inconclusive'),
          reason: z.literal('measurement_only'),
          arithmetic: z
            .strictObject({
              method: z.literal('decimal50_interval_v1'),
              scope: z.literal('sampled_formula_roundoff'),
              lower: Finite.nonnegative(),
              upper: Finite.nonnegative(),
              absoluteUncertaintyBound: Finite.nonnegative(),
            })
            .nullable(),
        }),
      )
      .min(1)
      .max(3),
    limitations: z.array(z.string().min(1).max(1000)).min(1).max(10),
  })
  .superRefine((result, ctx) => {
    const expected = DIAGNOSTIC_METRICS[result.profile.kind];
    for (const metric of result.metrics) {
      const bounds = metric.arithmetic;
      if (
        bounds &&
        (bounds.lower > bounds.upper ||
          bounds.absoluteUncertaintyBound <
            Math.max(
              Math.abs(metric.value - bounds.lower),
              Math.abs(bounds.upper - metric.value),
            ))
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'Arithmetic interval or radius understates formula evaluation uncertainty',
        });
    }
    if (
      result.timeRangeSeconds[0] >= result.timeRangeSeconds[1] ||
      new Set([
        result.operationId,
        result.validationOperationId,
        result.sourceOperationId,
      ]).size !== 3 ||
      result.metrics.length !== expected.length ||
      expected.some(
        ([name, unit], index) =>
          result.metrics[index]?.name !== name ||
          result.metrics[index]?.unit !== unit,
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Diagnostic profile, identities or time range mismatch',
      });
  });

export type DiagnosticJobRequest = z.infer<typeof DiagnosticJobRequest>;
export type DiagnosticJobResult = z.infer<typeof DiagnosticJobResult>;

export function validateDiagnosticJobResult(
  value: unknown,
  requestValue: unknown,
) {
  const request = DiagnosticJobRequest.parse(requestValue);
  const result = DiagnosticJobResult.parse(value);
  if (
    result.auditId !== request.auditId ||
    result.revisionId !== request.revisionId ||
    result.operationId !== request.operationId ||
    result.contextDigest !== request.contextDigest ||
    result.validationOperationId !== request.validation.evaluationOperationId ||
    result.sourceOperationId !== request.validation.sourceOperationId ||
    result.inputDigest !== request.validation.inputDigest ||
    result.adapterDigest !== request.validation.adapterDigest ||
    JSON.stringify(result.profile) !== JSON.stringify(request.profile) ||
    result.sampleCount !==
      request.validation.mappings.find((item) => item.key === 'times')
        ?.expectedShape[0]
  )
    throw new Error('Diagnostic result snapshot mismatch');
  return result;
}
