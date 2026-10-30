import { describe, expect, it, vi } from 'vitest';
import { ValidationPipeline } from './validation-pipeline.js';
import {
  SandboxControlFailure,
  type SandboxRequest,
  type E2bClient,
} from './e2b-client.js';
import { type ValidationSession } from './validation-runner.js';
import { ObservationValidationRequest } from '@siphon/contracts';
import { sha256 } from './hashing.js';

async function setup() {
  // Transport-only fixture; actual NPY decoding is tested in Python/parity.
  const bytes = new TextEncoder().encode('authored-numeric-transport');
  const sandbox: SandboxRequest = {
    operationId: crypto.randomUUID(),
    auditId: crypto.randomUUID(),
    revisionId: crypto.randomUUID(),
    inputDigest: 'a'.repeat(64),
    role: 'evaluation',
    templateId: 'fixture-evaluator',
    templateEvidenceId: crypto.randomUUID(),
    lifetimeSeconds: 60,
  };
  const sourceOperationId = crypto.randomUUID();
  const descriptor = {
    key: 'times',
    filename: 'obs_times.npy',
    bytes: bytes.length,
    sha256: await sha256('authored-numeric-transport'),
    shape: [2],
    dtype: 'float64',
    declaredUnit: 's',
  };
  const request = ObservationValidationRequest.parse({
    schemaVersion: '1.0',
    evaluationOperationId: sandbox.operationId,
    sourceOperationId,
    inputDigest: sandbox.inputDigest,
    adapterDigest: 'b'.repeat(64),
    manifest: {
      schemaVersion: '1.0',
      operationId: sourceOperationId,
      inputDigest: sandbox.inputDigest,
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
  });
  const report = {
    schemaVersion: '1.0',
    evaluationOperationId: sandbox.operationId,
    sourceOperationId,
    inputDigest: sandbox.inputDigest,
    adapterDigest: request.adapterDigest,
    validation: 'validated_numeric_structure',
    totalBytes: bytes.length,
    totalElements: 2,
    observations: [
      {
        key: 'times',
        sha256: descriptor.sha256,
        bytes: bytes.length,
        shape: [2],
        dtype: 'float64',
        declaredUnit: 's',
        originalDtype: '<f8',
        conversion: 'none',
        elements: 2,
      },
    ],
  };
  const observations = {
    load: vi.fn(async () => ({
      request,
      payloads: [{ filename: descriptor.filename, bytes }],
    })),
  };
  const executions = {
    bind: vi.fn(async () => {}),
    claim: vi.fn(async () => {}),
    authorizeResult: vi.fn(async () => {}),
    recordCandidate: vi.fn(async () => ({
      reportDigest: 'c'.repeat(64),
      replayed: false,
    })),
    publish: vi.fn(async () => ({
      reportDigest: 'c'.repeat(64),
      replayed: false,
    })),
  };
  const session: ValidationSession = {
    sandboxId: 'fresh-evaluator',
    writeRequest: async () => {},
    writeObservation: async () => {},
    run: vi.fn(async () => 0),
    readResult: async () => new Response(JSON.stringify(report)).body!,
  };
  const sandboxes = {
    createValidation: vi.fn(async () => ({
      sandboxId: session.sandboxId,
      session,
    })),
    kill: vi.fn<E2bClient['kill']>(async () => 'killed'),
  };
  const pipeline = new ValidationPipeline(observations, executions, sandboxes);
  const fence = {
    auditId: sandbox.auditId,
    revisionId: sandbox.revisionId,
    generation: 0,
    inputDigest: sandbox.inputDigest,
  };
  const run = (signal?: AbortSignal) =>
    pipeline.run('alice', sourceOperationId, sandbox, fence, signal);
  return {
    pipeline,
    observations,
    executions,
    sandboxes,
    session,
    sandbox,
    report,
    run,
  };
}

describe('durable data-only validation orchestration (offline)', () => {
  it('reserves before creation, journals before termination and publishes from the durable candidate', async () => {
    const f = await setup();
    expect(await f.run()).toMatchObject({ status: 'published' });
    expect(f.executions.bind.mock.invocationCallOrder[0]).toBeLessThan(
      f.sandboxes.createValidation.mock.invocationCallOrder[0]!,
    );
    expect(f.executions.recordCandidate).toHaveBeenCalledWith(
      f.sandbox.operationId,
      f.report,
    );
    expect(
      f.executions.recordCandidate.mock.invocationCallOrder[0],
    ).toBeLessThan(f.sandboxes.kill.mock.invocationCallOrder[0]!);
    expect(f.sandboxes.kill.mock.invocationCallOrder[0]).toBeLessThan(
      f.executions.publish.mock.invocationCallOrder[0]!,
    );
    expect(f.executions.publish).toHaveBeenCalledWith(f.sandbox.operationId);
  });
  it('retains a private candidate on uncertain termination and recovers without loading or executing again', async () => {
    const f = await setup();
    f.sandboxes.kill.mockRejectedValueOnce(new Error('kill_unknown'));
    expect(await f.run()).toEqual({
      status: 'awaiting_termination',
      reportDigest: 'c'.repeat(64),
    });
    expect(f.executions.publish).not.toHaveBeenCalled();
    expect(await f.pipeline.recover(f.sandbox.operationId)).toMatchObject({
      status: 'published',
    });
    expect(f.observations.load).toHaveBeenCalledOnce();
    expect(f.sandboxes.createValidation).toHaveBeenCalledOnce();
    expect(f.session.run).toHaveBeenCalledOnce();
  });
  it.each(['load', 'bind', 'snapshot'])(
    'does not create an evaluator when %s fails',
    async (kind) => {
      const f = await setup();
      if (kind === 'load')
        f.observations.load.mockRejectedValueOnce(new Error('denied'));
      if (kind === 'bind')
        f.executions.bind.mockRejectedValueOnce(new Error('denied'));
      if (kind === 'snapshot') f.sandbox.role = 'source';
      await expect(f.run()).rejects.toThrow();
      expect(f.sandboxes.createValidation).not.toHaveBeenCalled();
    },
  );
  it('terminates after candidate persistence failure without publishing a result', async () => {
    const f = await setup();
    f.executions.recordCandidate.mockRejectedValueOnce(
      new Error('journal failed'),
    );
    await expect(f.run()).rejects.toThrow('journal failed');
    expect(f.sandboxes.kill).toHaveBeenCalledOnce();
    expect(f.executions.publish).not.toHaveBeenCalled();
  });
  it('uses an independent termination signal after cancellation interrupts execution', async () => {
    const f = await setup();
    const controller = new AbortController();
    f.session.run = async () => {
      controller.abort();
      throw new Error('cancelled');
    };
    f.sandboxes.kill.mockImplementationOnce(
      async (_operationId, _sandboxId, signal) => {
        expect(signal?.aborted).toBe(false);
        return 'killed';
      },
    );
    await expect(f.run(controller.signal)).rejects.toThrow(
      'trusted_numeric_validation_failed',
    );
    expect(f.sandboxes.kill).toHaveBeenCalledOnce();
    expect(f.executions.recordCandidate).not.toHaveBeenCalled();
  });
  it('attempts cleanup of a known handle after failed session handoff', async () => {
    const f = await setup();
    f.sandboxes.createValidation.mockRejectedValueOnce(
      new SandboxControlFailure('handle_unrecorded', 'known-evaluator'),
    );
    await expect(f.run()).rejects.toMatchObject({ code: 'handle_unrecorded' });
    expect(f.sandboxes.kill).toHaveBeenCalledWith(
      f.sandbox.operationId,
      'known-evaluator',
      expect.any(AbortSignal),
    );
  });
  it('retains the candidate when final publication fails and retries only publication', async () => {
    const f = await setup();
    f.executions.publish.mockRejectedValueOnce(new Error('transaction failed'));
    await expect(f.run()).rejects.toThrow('transaction failed');
    expect(await f.pipeline.recover(f.sandbox.operationId)).toMatchObject({
      status: 'published',
    });
    expect(f.sandboxes.createValidation).toHaveBeenCalledOnce();
    expect(f.executions.recordCandidate).toHaveBeenCalledOnce();
  });
});
