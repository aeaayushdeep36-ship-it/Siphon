import { describe, expect, it, vi } from 'vitest';
import { fidelityExecutionFixture } from '../test/fidelity-execution-fixture.js';
import { FidelityPipeline } from './fidelity-pipeline.js';
import { type E2bClient } from './e2b-client.js';
import { ObservationValidationRequest } from '@siphon/contracts';

async function fixture() {
  const f = await fidelityExecutionFixture(),
    sandbox = f.docs.documents.get(
      `sandboxJobs/${f.request.operationId}`,
    )!.request;
  const payload = new TextEncoder().encode(
    'authored unvalidated numeric transport',
  );
  const observations = {
    load: vi.fn(async (_uid: string, sourceId: string) => {
      const request = ObservationValidationRequest.parse(
        sourceId === f.request.original.sourceOperationId
          ? f.request.original
          : f.request.adapted,
      );
      return {
        request,
        payloads: request.manifest.observations.map((item) => ({
          filename: item.filename,
          bytes: payload,
        })),
      };
    }),
  };
  const session = {
    sandboxId: 'authored-comparison',
    writeRequest: async () => {},
    writeObservation: async () => {},
    run: async () => 0,
    readResult: async () => new Response(JSON.stringify(f.result)).body!,
  };
  const createFidelity = vi.fn(async () => {
    f.dispatch();
    return { sandboxId: session.sandboxId, session };
  });
  const kill = vi.fn<E2bClient['kill']>(async () => {
    f.terminate();
    return 'killed';
  });
  const pipeline = new FidelityPipeline(observations, f.executions, {
    createFidelity,
    kill,
  });
  const run = () =>
    pipeline.run(
      'alice',
      {
        sourceOperationId: f.request.original.sourceOperationId,
        validationOperationId: f.request.original.evaluationOperationId,
      },
      {
        sourceOperationId: f.request.adapted.sourceOperationId,
        validationOperationId: f.request.adapted.evaluationOperationId,
      },
      sandbox,
      f.fence,
    );
  return { ...f, run, pipeline, createFidelity, kill };
}
describe('comparison pipeline and durable gates', () => {
  it('publishes only after creating, running and terminating the evaluator', async () => {
    const f = await fixture();
    expect(await f.run()).toMatchObject({
      status: 'published',
      replayed: false,
    });
    expect(f.createFidelity).toHaveBeenCalledOnce();
    expect(f.kill).toHaveBeenCalledOnce();
    expect(
      f.docs.documents.get(
        `${f.base}/baselineComparisons/${f.request.operationId}`,
      ),
    ).toMatchObject({ result: { status: 'matched' } });
    expect(f.docs.documents.has(`${f.base}/adapters/current`)).toBe(false);
  });
  it('retains a candidate after ambiguous cleanup and recovers without rerunning', async () => {
    const f = await fixture();
    f.kill.mockRejectedValueOnce(new Error('authored timeout'));
    expect(await f.run()).toMatchObject({ status: 'awaiting_termination' });
    expect(
      f.docs.documents.has(
        `${f.base}/baselineComparisons/${f.request.operationId}`,
      ),
    ).toBe(false);
    f.terminate();
    expect(await f.pipeline.recover(f.request.operationId)).toMatchObject({
      status: 'published',
      replayed: false,
    });
    expect(f.createFidelity).toHaveBeenCalledOnce();
  });
});
