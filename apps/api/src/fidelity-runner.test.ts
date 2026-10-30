import { describe, expect, it, vi } from 'vitest';
import { FidelityRunner } from './fidelity-runner.js';
import { sha256 } from './hashing.js';

async function fixture() {
  const bytes = new TextEncoder().encode('authored-data'),
    hash = await sha256('authored-data');
  const mapping = {
    key: 'times',
    root: 't',
    steps: [],
    expectedShape: [2],
    axisOrder: [0],
    declaredUnit: 's',
  };
  const job = () => {
    const sourceOperationId = crypto.randomUUID();
    return {
      schemaVersion: '1.0',
      evaluationOperationId: crypto.randomUUID(),
      sourceOperationId,
      inputDigest: 'a'.repeat(64),
      adapterDigest: 'b'.repeat(64),
      manifest: {
        schemaVersion: '1.0',
        operationId: sourceOperationId,
        inputDigest: 'a'.repeat(64),
        adapterDigest: 'b'.repeat(64),
        executionProfile: 'runpy_main_root_v1',
        observations: [
          {
            key: 'times',
            filename: 'obs_times.npy',
            sha256: hash,
            bytes: bytes.length,
            shape: [2],
            dtype: 'float64',
            declaredUnit: 's',
          },
        ],
      },
      mappings: [mapping],
      maximumBytes: 1000,
      maximumElements: 10,
    };
  };
  const request = {
      schemaVersion: '1.0',
      operationId: crypto.randomUUID(),
      original: job(),
      adapted: job(),
    },
    gate = {
      claim: vi.fn(async () => {}),
      authorizeResult: vi.fn(async () => {}),
    },
    session = {
      sandboxId: 'authored',
      writeRequest: vi.fn(async () => {}),
      writeObservation: vi.fn(async () => {}),
      run: vi.fn(async () => 0),
      readResult: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              schemaVersion: '1.0',
              status: 'matched',
              comparedElements: 2,
              observations: [{ key: 'times', status: 'matched', reason: null }],
            }),
          ).body!,
      ),
    };
  return {
    request,
    gate,
    session,
    runner: new FidelityRunner(session, gate),
    payload: [{ filename: 'obs_times.npy', bytes }],
  };
}
describe('fidelity data transport', () => {
  it('requires authorization and sends only the two verified numeric sets', async () => {
    const f = await fixture();
    expect(await f.runner.run(f.request, f.payload, f.payload)).toMatchObject({
      status: 'matched',
      comparedElements: 2,
    });
    expect(f.gate.claim).toHaveBeenCalledOnce();
    expect(f.session.writeObservation).toHaveBeenCalledTimes(2);
    expect(f.gate.authorizeResult).toHaveBeenCalledTimes(5);
  });
  it('rejects changed bytes before claiming or writing a sandbox', async () => {
    const f = await fixture();
    await expect(
      f.runner.run(f.request, f.payload, [
        {
          filename: 'obs_times.npy',
          bytes: new TextEncoder().encode('tampered-data'),
        },
      ]),
    ).rejects.toThrow();
    expect(f.gate.claim).not.toHaveBeenCalled();
    expect(f.session.writeRequest).not.toHaveBeenCalled();
  });
  it('rejects results for observations absent from the request', async () => {
    const f = await fixture();
    f.session.readResult.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          schemaVersion: '1.0',
          status: 'matched',
          comparedElements: 2,
          observations: [
            { key: 'temperature', status: 'matched', reason: null },
          ],
        }),
      ).body!,
    );
    await expect(f.runner.run(f.request, f.payload, f.payload)).rejects.toThrow(
      'trusted_baseline_comparison_failed',
    );
  });
  it('rejects a fabricated missing observation or incomplete count after both inputs were validated', async () => {
    const f = await fixture();
    f.session.readResult.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          schemaVersion: '1.0',
          status: 'mismatched',
          comparedElements: 0,
          observations: [
            { key: 'times', status: 'mismatched', reason: 'missing_original' },
          ],
        }),
      ).body!,
    );
    await expect(f.runner.run(f.request, f.payload, f.payload)).rejects.toThrow(
      'trusted_baseline_comparison_failed',
    );
  });
});
