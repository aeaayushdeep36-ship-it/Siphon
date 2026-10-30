import { describe, expect, it, vi } from 'vitest';
import {
  ValidationRunner,
  type ValidationSession,
} from './validation-runner.js';
import { sha256 } from './hashing.js';

async function setup() {
  const raw = new TextEncoder().encode('authored-format-fixture');
  const hash = await sha256('authored-format-fixture');
  const evaluationOperationId = crypto.randomUUID(),
    sourceOperationId = crypto.randomUUID();
  const descriptor = {
    key: 'times',
    filename: 'obs_times.npy',
    bytes: raw.length,
    sha256: hash,
    shape: [2],
    dtype: 'float64',
    declaredUnit: 's',
  };
  const request = {
    schemaVersion: '1.0',
    evaluationOperationId,
    sourceOperationId,
    inputDigest: 'a'.repeat(64),
    adapterDigest: 'b'.repeat(64),
    manifest: {
      schemaVersion: '1.0',
      operationId: sourceOperationId,
      inputDigest: 'a'.repeat(64),
      adapterDigest: 'b'.repeat(64),
      executionProfile: 'runpy_main_root_v1',
      observations: [descriptor],
    },
    mappings: [
      {
        key: 'times',
        root: 't',
        steps: [],
        expectedShape: [2],
        axisOrder: [0],
        declaredUnit: 's',
      },
    ],
    maximumBytes: 10000,
    maximumElements: 100,
  };
  const report = {
    schemaVersion: '1.0',
    evaluationOperationId,
    sourceOperationId,
    inputDigest: request.inputDigest,
    adapterDigest: request.adapterDigest,
    validation: 'validated_numeric_structure',
    totalBytes: raw.length,
    totalElements: 2,
    observations: [
      {
        key: 'times',
        sha256: hash,
        bytes: raw.length,
        shape: [2],
        dtype: 'float64',
        declaredUnit: 's',
        originalDtype: '<f8',
        conversion: 'none',
        elements: 2,
      },
    ],
  };
  const session: ValidationSession = {
    sandboxId: 'authored-evaluator',
    writeRequest: vi.fn(async () => {}),
    writeObservation: vi.fn(async () => {}),
    run: vi.fn(async () => 0),
    readResult: vi.fn(async () => new Response(JSON.stringify(report)).body!),
  };
  const gate = {
    claim: vi.fn(async () => {}),
    authorizeResult: vi.fn(async () => {}),
  };
  return {
    request,
    report,
    raw,
    session,
    gate,
    runner: new ValidationRunner(session, gate),
  };
}
describe('evaluation-role numeric validation transport (offline)', () => {
  it('stages only declared numeric bytes under a fresh claim and validates returned metadata', async () => {
    const f = await setup();
    expect(
      await f.runner.run(f.request, [
        { filename: 'obs_times.npy', bytes: f.raw },
      ]),
    ).toEqual(f.report);
    expect(f.gate.claim).toHaveBeenCalledWith(
      f.request,
      expect.stringMatching(/^[a-f0-9]{64}$/),
      'authored-evaluator',
    );
    expect(f.session.writeObservation).toHaveBeenCalledWith(
      'times',
      f.raw,
      expect.any(AbortSignal),
    );
  });
  it('refuses a corrupt input or extra source file before obtaining a claim', async () => {
    const f = await setup();
    const bad = new Uint8Array(f.raw);
    bad[0] = 1;
    await expect(
      f.runner.run(f.request, [{ filename: 'obs_times.npy', bytes: bad }]),
    ).rejects.toThrow('hash');
    await expect(
      f.runner.run(f.request, [
        { filename: 'obs_times.npy', bytes: f.raw },
        { filename: 'source.py', bytes: f.raw },
      ]),
    ).rejects.toThrow('input set');
    expect(f.gate.claim).not.toHaveBeenCalled();
  });
  it.each(['exit', 'count', 'identity', 'oversize', 'cancelled'])(
    'discards %s results without a validation receipt',
    async (kind) => {
      const f = await setup();
      if (kind === 'exit') f.session.run = async () => 2;
      if (kind === 'count') f.report.totalElements = 3;
      if (kind === 'identity') f.report.sourceOperationId = crypto.randomUUID();
      if (kind === 'oversize')
        f.session.readResult = async () =>
          new Response('x'.repeat(32769)).body!;
      if (kind === 'cancelled')
        f.gate.authorizeResult.mockRejectedValueOnce(new Error('stale'));
      await expect(
        f.runner.run(f.request, [{ filename: 'obs_times.npy', bytes: f.raw }]),
      ).rejects.toThrow('trusted_numeric_validation_failed');
    },
  );
});
