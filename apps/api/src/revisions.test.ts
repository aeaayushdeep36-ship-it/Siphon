import { describe, expect, it } from 'vitest';
import { type CreateRevision } from '@siphon/contracts';
import { RevisionRepository } from './revisions.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { TestDocuments } from '../test/document-store.js';
import { canonicalJson, sha256 } from './hashing.js';

async function setup() {
  const store = new TestDocuments();
  store.documents.set('testers/alice', { active: true });
  store.documents.set('testers/bob', { active: true });
  const audits = new FirestoreAuditRepository(store);
  const { audit } = await audits.create(
    'alice',
    { schemaVersion: '1.0', domain: 'orbital_dynamics', title: 'Orbit' },
    'create',
  );
  const path = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
  const parent = store.documents.get(path)!;
  const input: CreateRevision = {
    schemaVersion: '1.0',
    parentRevisionId: audit.currentRevisionId,
    expectedGeneration: 0,
    expectedInputDigest: String(parent.inputDigest),
    reuseArtifactIds: [],
  };
  return {
    store,
    audit,
    path,
    parent,
    input,
    revisions: new RevisionRepository(store),
  };
}

describe('immutable successor revisions', () => {
  it('creates one successor for concurrent duplicate submissions without changing parent evidence', async () => {
    const { store, audit, path, parent, input, revisions } = await setup();
    parent.reportPointer = 'old-report';
    const snapshot = structuredClone(parent);
    const results = await Promise.all([
      revisions.create('alice', audit.id, input, 'same'),
      revisions.create('alice', audit.id, input, 'same'),
    ]);
    expect(results[0]?.receipt).toEqual(results[1]?.receipt);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(store.documents.get(path)).toEqual(snapshot);
    const next = store.documents.get(
      `audits/${audit.id}/revisions/${results[0]!.receipt.revisionId}`,
    )!;
    expect(next.reportPointer).toBeUndefined();
    expect(next).toMatchObject({
      status: 'idle',
      stage: 'draft',
      generation: 0,
      cancellationRequestedAt: null,
    });
  });
  it('allows only one competing successor and rejects same-key payload conflicts', async () => {
    const { audit, input, revisions } = await setup();
    const results = await Promise.allSettled([
      revisions.create('alice', audit.id, input, 'one'),
      revisions.create('alice', audit.id, input, 'two'),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    await expect(
      revisions.create(
        'alice',
        audit.id,
        { ...input, expectedGeneration: 1 },
        results[0]?.status === 'fulfilled' ? 'one' : 'two',
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
  it('rejects active/stale parents and cross-user requests', async () => {
    const { store, audit, path, input, revisions } = await setup();
    await expect(
      revisions.create('bob', audit.id, input, 'key'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      revisions.create(
        'alice',
        audit.id,
        { ...input, expectedGeneration: 1 },
        'key',
      ),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    Object.assign(store.documents.get(path)!, {
      status: 'running',
      stage: 'inspecting',
    });
    await expect(
      revisions.create('alice', audit.id, input, 'key'),
    ).rejects.toMatchObject({ code: 'revision_active' });
  });
  it('reuses only ready unchanged parent artifacts without extending retention', async () => {
    const { store, audit, parent, input, revisions } = await setup();
    const artifactId = crypto.randomUUID();
    const entry = {
      schemaVersion: '1.0',
      artifactId,
      path: 'orbit.py',
      bytes: 120,
      sha256: 'a'.repeat(64),
    };
    parent.sourceManifest = [entry];
    parent.inputDigest = await sha256(
      canonicalJson({ uploads: [entry], answers: [] }),
    );
    input.expectedInputDigest = String(parent.inputDigest);
    const artifactPath = `audits/${audit.id}/artifacts/${artifactId}`;
    const artifact = {
      ...entry,
      ownerUid: 'alice',
      lifecycle: 'ready',
      expiresAt: '2099-01-01T00:00:00Z',
    };
    store.documents.set(artifactPath, artifact);
    const result = await revisions.create(
      'alice',
      audit.id,
      { ...input, reuseArtifactIds: [artifactId] },
      'reuse',
    );
    expect(store.documents.get(artifactPath)).toEqual(artifact);
    expect(
      store.documents.get(
        `audits/${audit.id}/revisions/${result.receipt.revisionId}`,
      )?.sourceManifest,
    ).toEqual([entry]);
    expect(result.receipt.inputDigest).toBe(input.expectedInputDigest);
  });
  it.each(['expired', 'wrong_owner', 'wrong_hash', 'reserved'])(
    'rejects unavailable or tampered artifacts: %s',
    async (mode) => {
      const { store, audit, parent, input, revisions } = await setup();
      const artifactId = crypto.randomUUID();
      const entry = {
        schemaVersion: '1.0',
        artifactId,
        path: 'orbit.py',
        bytes: 120,
        sha256: 'a'.repeat(64),
      };
      parent.sourceManifest = [entry];
      parent.inputDigest = await sha256(
        canonicalJson({ uploads: [entry], answers: [] }),
      );
      input.expectedInputDigest = String(parent.inputDigest);
      store.documents.set(`audits/${audit.id}/artifacts/${artifactId}`, {
        ...entry,
        ownerUid: mode === 'wrong_owner' ? 'bob' : 'alice',
        lifecycle: mode === 'reserved' ? 'reserved' : 'ready',
        expiresAt:
          mode === 'expired' ? '2000-01-01T00:00:00Z' : '2099-01-01T00:00:00Z',
        sha256: mode === 'wrong_hash' ? 'b'.repeat(64) : entry.sha256,
      });
      await expect(
        revisions.create(
          'alice',
          audit.id,
          { ...input, reuseArtifactIds: [artifactId] },
          'reuse',
        ),
      ).rejects.toBeDefined();
      expect(store.documents.get(`audits/${audit.id}`)?.currentRevisionId).toBe(
        input.parentRevisionId,
      );
    },
  );
});
