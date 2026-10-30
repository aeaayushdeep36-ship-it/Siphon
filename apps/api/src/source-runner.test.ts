import { describe, expect, it, vi } from 'vitest';
import { SourceRunner, type SourceSession } from './source-runner.js';
import { sha256 } from './hashing.js';

async function setup() {
  const artifactId = crypto.randomUUID();
  const payload = 'unvalidated-output';
  const request = {
    schemaVersion: '1.0',
    operationId: crypto.randomUUID(),
    inputDigest: 'a'.repeat(64),
    adapterDigest: 'b'.repeat(64),
    entryArtifactId: artifactId,
    files: [
      {
        schemaVersion: '1.0',
        artifactId,
        path: 'fixture.py',
        bytes: 0,
        sha256: await sha256(''),
        dataBase64: '',
      },
    ],
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
    maximumOutputBytes: 4096,
    maximumElements: 100,
  };
  const manifest = {
    schemaVersion: '1.0',
    operationId: request.operationId,
    inputDigest: request.inputDigest,
    adapterDigest: request.adapterDigest,
    executionProfile: 'runpy_main_root_v1',
    observations: [
      {
        key: 'times',
        filename: 'obs_times.npy',
        bytes: payload.length,
        sha256: await sha256(payload),
        shape: [2],
        dtype: 'float64',
        declaredUnit: 's',
      },
    ],
  };
  const session: SourceSession = {
    sandboxId: 'authored-source',
    writeRequest: vi.fn(async () => {}),
    run: vi.fn(async () => 0),
    readManifest: vi.fn(
      async () => new Response(JSON.stringify(manifest)).body!,
    ),
    readObservation: vi.fn(async () => new Response(payload).body!),
  };
  const gate = {
    claim: vi.fn(async () => {}),
    authorizeCollection: vi.fn(async () => {}),
  };
  return {
    request,
    manifest,
    session,
    gate,
    runner: new SourceRunner(session, gate),
  };
}
describe('source sandbox transport (offline)', () => {
  it('claims once and labels returned bytes as requiring trusted numeric validation', async () => {
    const f = await setup();
    const result = await f.runner.run(f.request);
    expect(result.validation).toBe('unvalidated_numeric_bytes');
    expect(new TextDecoder().decode(result.payloads[0]!.bytes)).toBe(
      'unvalidated-output',
    );
    expect(f.gate.claim).toHaveBeenCalledWith(
      f.request,
      expect.stringMatching(/^[a-f0-9]{64}$/),
      'authored-source',
      'adapter_v1',
    );
    expect(f.session.readObservation).toHaveBeenCalledWith(
      'times',
      expect.any(AbortSignal),
    );
  });
  it('rejects input corruption before source-sandbox I/O or execution claim', async () => {
    const f = await setup();
    f.request.files[0]!.sha256 = 'c'.repeat(64);
    await expect(f.runner.run(f.request)).rejects.toThrow('input digest');
    expect(f.gate.claim).not.toHaveBeenCalled();
    expect(f.session.run).not.toHaveBeenCalled();
  });
  it.each(['exit', 'identity', 'hash', 'bytes', 'manifest_size', 'cancelled'])(
    'rejects %s output without returning collected evidence',
    async (kind) => {
      const f = await setup();
      if (kind === 'exit') f.session.run = async () => 2;
      if (kind === 'identity') f.manifest.adapterDigest = 'd'.repeat(64);
      if (kind === 'hash')
        f.session.readObservation = async () =>
          new Response('x'.repeat(18)).body!;
      if (kind === 'bytes') f.manifest.observations[0]!.bytes = 1;
      if (kind === 'manifest_size')
        f.session.readManifest = async () =>
          new Response('x'.repeat(32769)).body!;
      if (kind === 'cancelled')
        f.gate.authorizeCollection.mockRejectedValueOnce(
          new Error('stale_revision'),
        );
      await expect(f.runner.run(f.request)).rejects.toThrow(
        'source_execution_or_collection_failed',
      );
    },
  );
});
