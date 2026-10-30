import { describe, expect, it } from 'vitest';
import { type ReserveUpload } from '@siphon/contracts';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { UploadRepository } from './uploads.js';

async function setup(limit = 1000) {
  const store = new TestDocuments();
  store.documents.set('testers/alice', { active: true });
  store.documents.set('testers/bob', { active: true });
  store.documents.set('budgets/r2_storage_bytes', {
    schemaVersion: '1.0',
    limit,
    reserved: 0,
    spent: 0,
    halted: false,
  });
  const audits = new FirestoreAuditRepository(store);
  const { audit } = await audits.create(
    'alice',
    { schemaVersion: '1.0', title: 'Heat', domain: 'heat_diffusion' },
    'create',
  );
  const revisionPath = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
  const input: ReserveUpload = {
    schemaVersion: '1.0',
    path: 'model.py',
    bytes: 600,
    sha256: 'a'.repeat(64),
    expectedGeneration: 0,
    expectedInputDigest: String(store.documents.get(revisionPath)!.inputDigest),
  };
  return {
    store,
    audit,
    input,
    revisionPath,
    uploads: new UploadRepository(
      store,
      () => new Date('2026-10-28T00:00:00Z'),
    ),
  };
}

describe('upload reservations', () => {
  it('atomically reserves storage and immutable metadata once, without making bytes ready', async () => {
    const { store, audit, input, revisionPath, uploads } = await setup();
    const results = await Promise.all([
      uploads.reserve(
        'alice',
        audit.id,
        audit.currentRevisionId,
        input,
        'same',
      ),
      uploads.reserve(
        'alice',
        audit.id,
        audit.currentRevisionId,
        input,
        'same',
      ),
    ]);
    expect(results[0]?.reservation).toEqual(results[1]?.reservation);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(store.documents.get('budgets/r2_storage_bytes')).toMatchObject({
      reserved: 600,
      spent: 0,
    });
    const reservation = results[0]!.reservation;
    expect(reservation).toMatchObject({
      lifecycle: 'reserved',
      generation: 1,
      uploadExpiresAt: '2026-10-29T00:00:00.000Z',
      expiresAt: '2026-11-04T00:00:00.000Z',
    });
    expect(store.documents.get(revisionPath)?.inputDigest).toBe(
      reservation.inputDigest,
    );
    expect(
      store.documents.get(`reservations/${reservation.artifactId}`),
    ).toMatchObject({ disposition: 'reserved', measuredUsage: null });
  });
  it('rejects stale and conflicting retries without changing storage', async () => {
    const { store, audit, input, uploads } = await setup();
    await uploads.reserve(
      'alice',
      audit.id,
      audit.currentRevisionId,
      input,
      'same',
    );
    await expect(
      uploads.reserve(
        'alice',
        audit.id,
        audit.currentRevisionId,
        { ...input, bytes: 601 },
        'same',
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(
      uploads.reserve(
        'alice',
        audit.id,
        audit.currentRevisionId,
        { ...input, path: 'other.py' },
        'other',
      ),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    expect(store.documents.get('budgets/r2_storage_bytes')?.reserved).toBe(600);
  });
  it('enforces global remaining storage before any metadata commit', async () => {
    const { store, audit, input, uploads } = await setup(599);
    await expect(
      uploads.reserve('alice', audit.id, audit.currentRevisionId, input, 'key'),
    ).rejects.toMatchObject({ code: 'budget_exhausted' });
    expect(
      [...store.documents.keys()].some((key) => key.includes('/artifacts/')),
    ).toBe(false);
    expect(store.documents.get('budgets/r2_storage_bytes')?.reserved).toBe(0);
  });
  it('rejects cross-owner, frozen revision and unconfigured budget', async () => {
    const { store, audit, input, revisionPath, uploads } = await setup();
    await expect(
      uploads.reserve('bob', audit.id, audit.currentRevisionId, input, 'key'),
    ).rejects.toMatchObject({ status: 404 });
    store.documents.delete('budgets/r2_storage_bytes');
    await expect(
      uploads.reserve('alice', audit.id, audit.currentRevisionId, input, 'key'),
    ).rejects.toMatchObject({ code: 'budget_unverified' });
    Object.assign(store.documents.get(revisionPath)!, {
      stage: 'inspecting',
      status: 'running',
    });
    await expect(
      uploads.reserve('alice', audit.id, audit.currentRevisionId, input, 'key'),
    ).rejects.toMatchObject({ code: 'revision_frozen' });
  });
  it('rejects case-colliding names and combined source size despite sufficient storage', async () => {
    const { audit, input, uploads } = await setup(1000000);
    const first = await uploads.reserve(
      'alice',
      audit.id,
      audit.currentRevisionId,
      input,
      'first',
    );
    const next = {
      ...input,
      expectedGeneration: first.reservation.generation,
      expectedInputDigest: first.reservation.inputDigest,
    };
    await expect(
      uploads.reserve(
        'alice',
        audit.id,
        audit.currentRevisionId,
        { ...next, path: 'MODEL.py' },
        'duplicate',
      ),
    ).rejects.toMatchObject({ code: 'invalid_upload_manifest' });
    await expect(
      uploads.reserve(
        'alice',
        audit.id,
        audit.currentRevisionId,
        { ...next, path: 'large.py', bytes: 131072 },
        'large',
      ),
    ).rejects.toMatchObject({ code: 'invalid_upload_manifest' });
  });
});
