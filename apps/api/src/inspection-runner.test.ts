import { describe, expect, it, vi } from 'vitest';
import {
  InspectionRunner,
  type InspectionSession,
} from './inspection-runner.js';
import { InspectionJobRequest } from '@siphon/contracts';

const request = {
  schemaVersion: '1.0',
  operationId: crypto.randomUUID(),
  inputDigest: 'a'.repeat(64),
  maximumSourceBytes: 131072,
  sources: [
    {
      artifactId: crypto.randomUUID(),
      sourceBase64: '',
      sourceDigest:
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
  ],
};
function setup() {
  const response = {
    schemaVersion: '1.0',
    operationId: request.operationId,
    inputDigest: request.inputDigest,
    sources: [
      {
        artifactId: request.sources[0]!.artifactId,
        inspection: {
          schemaVersion: '1.0',
          sourceDigest: request.sources[0]!.sourceDigest,
          parsed: true,
          truncated: false,
          dependencies: [],
          definitions: [],
          findings: [],
        },
      },
    ],
  };
  const gate = {
    claim: vi.fn(async () => {}),
    authorizeResult: vi.fn(async () => {}),
  };
  const session: InspectionSession = {
    sandboxId: 'inspection-fixture',
    writeRequest: vi.fn(async () => {}),
    run: vi.fn(async () => 0),
    readResult: vi.fn(async () => new Response(JSON.stringify(response)).body!),
  };
  return {
    response,
    gate,
    session,
    runner: new InspectionRunner(session, gate),
  };
}
describe('isolated inspection runner (offline)', () => {
  it('claims once before remote I/O and validates bound results after execution', async () => {
    const f = setup();
    expect(await f.runner.run(request)).toEqual(f.response);
    expect(f.gate.claim).toHaveBeenCalledWith(
      request,
      expect.stringMatching(/^[a-f0-9]{64}$/),
      'inspection-fixture',
    );
    expect(f.gate.authorizeResult).toHaveBeenCalledWith(request.operationId);
  });
  it('rejects corrupted source before claiming a paid sandbox', async () => {
    const f = setup();
    await expect(
      f.runner.run({
        ...request,
        sources: [{ ...request.sources[0], sourceDigest: 'b'.repeat(64) }],
      }),
    ).rejects.toThrow('digest');
    expect(f.gate.claim).not.toHaveBeenCalled();
    expect(f.session.writeRequest).not.toHaveBeenCalled();
  });
  it.each(['identity', 'exit', 'cancelled_result', 'oversize'])(
    'discards %s failures without exposing raw output',
    async (kind) => {
      const f = setup();
      if (kind === 'identity') f.response.inputDigest = 'c'.repeat(64);
      if (kind === 'exit') f.session.run = async () => 2;
      if (kind === 'cancelled_result')
        f.gate.authorizeResult.mockRejectedValueOnce(
          new Error('private provider error'),
        );
      if (kind === 'oversize')
        f.session.readResult = async () =>
          new Response('x'.repeat(1000001)).body!;
      await expect(f.runner.run(request)).rejects.toThrow(
        'inspection_execution_failed',
      );
    },
  );
  it('rejects noncanonical base64 and duplicate artifact identities at the shared boundary', () => {
    expect(
      InspectionJobRequest.safeParse({
        ...request,
        sources: [{ ...request.sources[0], sourceBase64: 'Zh==' }],
      }).success,
    ).toBe(false);
    expect(
      InspectionJobRequest.safeParse({
        ...request,
        sources: [request.sources[0], request.sources[0]],
      }).success,
    ).toBe(false);
  });
});
