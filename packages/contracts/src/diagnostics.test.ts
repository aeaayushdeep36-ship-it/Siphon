import { describe, expect, it } from 'vitest';
import {
  DiagnosticJobRequest,
  DiagnosticJobResult,
  validateDiagnosticJobResult,
} from './diagnostics.js';

function fixture() {
  const sourceOperationId = crypto.randomUUID();
  const specs = [
    ['times', [2], 's'],
    ['positions', [2, 1, 2], 'm'],
    ['velocities', [2, 1, 2], 'm/s'],
    ['central_mu', [], 'm^3/s^2'],
  ] as const;
  const request = DiagnosticJobRequest.parse({
    schemaVersion: '1.0',
    auditId: crypto.randomUUID(),
    revisionId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    contextDigest: 'c'.repeat(64),
    profile: { kind: 'central_orbit_si' },
    validation: {
      schemaVersion: '1.0',
      evaluationOperationId: crypto.randomUUID(),
      sourceOperationId,
      inputDigest: 'a'.repeat(64),
      adapterDigest: 'b'.repeat(64),
      maximumBytes: 10000,
      maximumElements: 1000,
      manifest: {
        schemaVersion: '1.0',
        operationId: sourceOperationId,
        inputDigest: 'a'.repeat(64),
        adapterDigest: 'b'.repeat(64),
        executionProfile: 'runpy_main_root_v1',
        observations: specs.map(([key, shape, declaredUnit]) => ({
          key,
          shape,
          declaredUnit,
          filename: `obs_${key}.npy`,
          dtype: 'float64',
          bytes: 128 + shape.reduce<number>((a, b) => a * b, 1) * 8,
          sha256: 'd'.repeat(64),
        })),
      },
      mappings: specs.map(([key, expectedShape, declaredUnit]) => ({
        key,
        expectedShape,
        declaredUnit,
        root: 'fixture',
        steps: [],
        axisOrder: expectedShape.map((_, index) => index),
      })),
    },
  });
  const result = {
    schemaVersion: '1.0',
    auditId: request.auditId,
    revisionId: request.revisionId,
    operationId: request.operationId,
    validationOperationId: request.validation.evaluationOperationId,
    sourceOperationId,
    inputDigest: request.validation.inputDigest,
    contextDigest: request.contextDigest,
    adapterDigest: request.validation.adapterDigest,
    profile: { kind: 'central_orbit_si' },
    kind: 'numeric_diagnostics',
    methodVersion: '0.1.0',
    sampleCount: 2,
    timeRangeSeconds: [0, 1],
    metrics: [
      {
        name: 'specific_energy_drift',
        value: 0.105,
        unit: 'm^2/s^2',
        normalization: 'absolute',
        status: 'inconclusive',
        reason: 'measurement_only',
        arithmetic: null,
      },
      {
        name: 'specific_angular_momentum_drift',
        value: 0.1,
        unit: 'm^2/s',
        normalization: 'absolute',
        status: 'inconclusive',
        reason: 'measurement_only',
        arithmetic: null,
      },
    ],
    limitations: ['No verified accuracy or applicability claim.'],
  };
  return { request, result };
}

describe('data-only SI diagnostic boundary', () => {
  it('accepts scoped measurements with explicit inconclusive status', () => {
    const f = fixture();
    expect(validateDiagnosticJobResult(f.result, f.request)).toEqual(f.result);
  });
  it.each([
    'source',
    'same_operation',
    'unit',
    'shape',
    'missing',
    'profile',
    'tolerance',
  ])('rejects invalid request %s before dispatch', (kind) => {
    const { request } = fixture();
    const changed: Record<string, unknown> = structuredClone(request);
    if (kind === 'source') changed.sourceCode = 'must never execute';
    if (kind === 'same_operation')
      changed.operationId = request.validation.sourceOperationId;
    if (kind === 'unit') request.validation.mappings[1]!.declaredUnit = 'km';
    if (kind === 'shape')
      request.validation.mappings[1]!.expectedShape = [2, 2, 2];
    if (kind === 'missing') request.validation.mappings.pop();
    if (kind === 'profile') changed.profile = { kind: 'drag_orbit' };
    if (kind === 'tolerance')
      changed.profile = { kind: 'central_orbit_si', tolerance: 0.01 };
    expect(() =>
      DiagnosticJobRequest.parse(
        ['unit', 'shape', 'missing'].includes(kind) ? request : changed,
      ),
    ).toThrow();
  });
  it.each([
    'verdict',
    'identity',
    'samples',
    'unit',
    'extra_metric',
    'time',
    'nonfinite',
  ])('rejects invalid diagnostic result %s', (kind) => {
    const f = fixture();
    if (kind === 'verdict')
      f.result.metrics[0]!.status = 'passed_within_tolerance';
    if (kind === 'identity') f.result.contextDigest = 'f'.repeat(64);
    if (kind === 'samples') f.result.sampleCount = 3;
    if (kind === 'unit') f.result.metrics[0]!.unit = 'J';
    if (kind === 'extra_metric')
      f.result.metrics.push({
        ...f.result.metrics[0]!,
        name: 'linear_momentum_drift',
      });
    if (kind === 'time') f.result.timeRangeSeconds = [1, 0];
    if (kind === 'nonfinite') f.result.metrics[0]!.value = Infinity;
    expect(() => validateDiagnosticJobResult(f.result, f.request)).toThrow();
  });
  it('requires heat material values and never accepts a caller-supplied error tolerance', () => {
    const f = fixture();
    expect(() =>
      DiagnosticJobRequest.parse({
        ...f.request,
        profile: { kind: 'heat_energy_si' },
      }),
    ).toThrow();
    expect(
      DiagnosticJobResult.safeParse({ ...f.result, tolerance: 1e-8 }).success,
    ).toBe(false);
  });
  it('accepts explicit formula-only enclosures without promoting them into a verdict', () => {
    const f = fixture();
    const result = {
      ...f.result,
      metrics: f.result.metrics.map((metric) => ({
        ...metric,
        arithmetic: {
          method: 'decimal50_interval_v1',
          scope: 'sampled_formula_roundoff',
          lower: Math.max(0, metric.value - 0.001),
          upper: metric.value + 0.001,
          absoluteUncertaintyBound: 0.002,
        },
      })),
    };
    expect(
      validateDiagnosticJobResult(result, f.request).metrics[0]?.status,
    ).toBe('inconclusive');
  });
  it.each([
    'inward_radius',
    'reversed',
    'negative',
    'nonfinite',
    'physical_scope',
    'missing',
  ])('rejects %s arithmetic metadata', (kind) => {
    const f = fixture();
    const arithmetic: Record<string, unknown> = {
      method: 'decimal50_interval_v1',
      scope: 'sampled_formula_roundoff',
      lower: 0.1,
      upper: 0.11,
      absoluteUncertaintyBound: 0.02,
    };
    if (kind === 'inward_radius') arithmetic.absoluteUncertaintyBound = 0;
    if (kind === 'reversed') arithmetic.lower = 0.12;
    if (kind === 'negative') arithmetic.lower = -1;
    if (kind === 'nonfinite') arithmetic.upper = Infinity;
    if (kind === 'physical_scope')
      arithmetic.scope = 'all_physical_uncertainty';
    if (kind === 'missing') delete arithmetic.absoluteUncertaintyBound;
    expect(() =>
      validateDiagnosticJobResult(
        {
          ...f.result,
          metrics: f.result.metrics.map((metric, index) =>
            index ? metric : { ...metric, arithmetic },
          ),
        },
        f.request,
      ),
    ).toThrow();
  });
});
