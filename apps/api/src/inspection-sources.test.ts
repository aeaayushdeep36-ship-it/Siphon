import { describe, expect, it, vi } from 'vitest';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { AuditCommands } from './audit-commands.js';
import { InspectionSourceLoader } from './inspection-sources.js';
import { sha256 } from './hashing.js';

async function setup() {
  const store = new TestDocuments();
  store.documents.set('testers/alice', { active: true });
  const { audit } = await new FirestoreAuditRepository(store).create(
    'alice',
    {
      schemaVersion: '1.0',
      domain: 'heat_diffusion',
      title: 'Sources',
    },
    'create',
  );
  const path = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
  const revision = store.documents.get(path)!;
  const source = 'raise RuntimeError("this is data")\n';
  const artifactId = crypto.randomUUID();
  Object.assign(revision, {
    stage: 'inspecting',
    status: 'running',
    sourceManifest: [
      {
        schemaVersion: '1.0',
        artifactId,
        path: 'fixture.py',
        bytes: source.length,
        sha256: await sha256(source),
      },
      {
        schemaVersion: '1.0',
        artifactId: crypto.randomUUID(),
        path: 'data.csv',
        bytes: 4,
        sha256: 'b'.repeat(64),
      },
    ],
  });
  const operationId = crypto.randomUUID();
  store.documents.set(`operations/${operationId}`, {
    schemaVersion: '1.0',
    id: operationId,
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest: revision.inputDigest,
    ownerUid: 'alice',
    requestDigest: 'c'.repeat(64),
    fence: 0,
    outcome: 'reserved',
    usage: null,
    providerHandle: null,
    charges: [
      {
        counterKey: 'fixture',
        amount: 1,
        unit: 'seconds',
        consumeOnDispatch: false,
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const downloads = {
    readBatch: vi.fn(async () => [
      {
        artifactId,
        bytes: new TextEncoder().encode(source),
        sha256: await sha256(source),
      },
    ]),
  };
  const fence = {
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    generation: 0,
    inputDigest: revision.inputDigest,
  };
  return {
    store,
    audit,
    path,
    source,
    artifactId,
    operationId,
    downloads,
    fence,
    loader: new InspectionSourceLoader(store, downloads),
  };
}
describe('private inspection source loading', () => {
  it('retrieves only declared Python sources, rehashes bytes and preserves exact binary payload', async () => {
    const f = await setup();
    const request = await f.loader.load('alice', f.operationId, f.fence);
    expect(request.sources).toHaveLength(1);
    expect(atob(request.sources[0]!.sourceBase64)).toBe(f.source);
    expect(f.downloads.readBatch).toHaveBeenCalledTimes(1);
  });
  it.each(['short', 'corrupt', 'oversize', 'foreign_identity'])(
    'rejects %s retrieval without returning an inspection payload',
    async (kind) => {
      const f = await setup();
      f.downloads.readBatch.mockImplementationOnce(async () => [
        {
          artifactId:
            kind === 'foreign_identity' ? crypto.randomUUID() : f.artifactId,
          sha256: await sha256(f.source),
          bytes: new TextEncoder().encode(
            kind === 'short'
              ? ''
              : kind === 'oversize'
                ? f.source + 'x'
                : 'x'.repeat(f.source.length),
          ),
        },
      ]);
      await expect(
        f.loader.load('alice', f.operationId, f.fence),
      ).rejects.toThrow();
    },
  );
  it('discards bytes when cancellation arrives during retrieval', async () => {
    const f = await setup();
    f.downloads.readBatch.mockImplementationOnce(async () => {
      await new AuditCommands(f.store).cancel(
        'alice',
        f.audit.id,
        f.audit.currentRevisionId,
        'cancel',
      );
      return [
        {
          artifactId: f.artifactId,
          bytes: new TextEncoder().encode(f.source),
          sha256: await sha256(f.source),
        },
      ];
    });
    await expect(
      f.loader.load('alice', f.operationId, f.fence),
    ).rejects.toMatchObject({ code: 'stale_revision' });
  });
  it('rejects stale and malformed identities before any object retrieval', async () => {
    const f = await setup();
    await expect(f.loader.load('alice', '../bad', f.fence)).rejects.toThrow();
    await expect(
      f.loader.load('alice', f.operationId, { ...f.fence, generation: 1 }),
    ).rejects.toThrow();
    expect(f.downloads.readBatch).not.toHaveBeenCalled();
  });
});
