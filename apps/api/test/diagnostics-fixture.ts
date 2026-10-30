import {
  DiagnosticJobRequest,
  type DiagnosticJobResult,
} from '@siphon/contracts';
import { sha256 } from '../src/hashing.js';

/** Deliberately transport-only bytes; real NPY arithmetic is covered by parity. */
export async function diagnosticsFixture() {
  const bytes = new TextEncoder().encode('authored-numeric-transport');
  const hash = await sha256('authored-numeric-transport');
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
          bytes: bytes.length,
          sha256: hash,
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
  const result: DiagnosticJobResult = {
    schemaVersion: '1.0',
    auditId: request.auditId,
    revisionId: request.revisionId,
    operationId: request.operationId,
    validationOperationId: request.validation.evaluationOperationId,
    sourceOperationId,
    inputDigest: request.validation.inputDigest,
    contextDigest: request.contextDigest,
    adapterDigest: request.validation.adapterDigest,
    profile: request.profile,
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
    limitations: ['Authored transport fixture, no scientific verdict.'],
  };
  return {
    request,
    result,
    payloads: request.validation.manifest.observations.map((item) => ({
      filename: item.filename,
      bytes: new Uint8Array(bytes),
    })),
  };
}
