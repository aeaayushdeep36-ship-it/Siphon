import { describe, expect, it } from 'vitest';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { UploadRepository } from './uploads.js';
import { UploadContentService } from './upload-content.js';
import { R2UploadStore } from './r2-upload.js';
import { sha256 } from './hashing.js';

async function setup(mode: 'ok' | 'timeout' | 'delete' = 'ok') {
  const store = new TestDocuments();
  const now = () => new Date('2026-10-28T00:00:00Z');
  store.documents.set('testers/alice', { active: true });
  store.documents.set('budgets/r2_storage_bytes', {
    schemaVersion: '1.0',
    limit: 10000,
    reserved: 0,
    spent: 0,
    halted: false,
  });
  store.documents.set('budgets/r2_a_oct', {
    schemaVersion: '1.0',
    limit: 100,
    reserved: 0,
    spent: 0,
    halted: false,
  });
  store.documents.set('configuration/r2_class_a_period', {
    counterKey: 'r2_a_oct',
    startsAt: '2026-10-01T00:00:00Z',
    endsAt: '2026-11-01T00:00:00Z',
  });
  const { audit } = await new FirestoreAuditRepository(store, now).create(
    'alice',
    { schemaVersion: '1.0', title: 'Test', domain: 'heat_diffusion' },
    'create',
  );
  const revision = store.documents.get(
    `audits/${audit.id}/revisions/${audit.currentRevisionId}`,
  )!;
  const digest = await sha256('hello');
  const { reservation } = await new UploadRepository(store, now).reserve(
    'alice',
    audit.id,
    audit.currentRevisionId,
    {
      schemaVersion: '1.0',
      path: 'model.py',
      bytes: 5,
      sha256: digest,
      expectedGeneration: 0,
      expectedInputDigest: String(revision.inputDigest),
    },
    'reserve',
  );
  let calls = 0;
  const service = new UploadContentService(
    store,
    {
      putOnce: async (_key, bytes, hash) => {
        calls++;
        if (mode === 'timeout') throw new Error('Unknown provider completion');
        if (mode === 'delete')
          store.documents.get(`audits/${audit.id}`)!.deletionRequestedAt =
            now().toISOString();
        return { size: bytes.length, sha256: hash };
      },
    },
    now,
  );
  const put = (text = 'hello') =>
    service.put(
      'alice',
      audit.id,
      audit.currentRevisionId,
      reservation.artifactId,
      new Request('https://test.example/content', {
        method: 'PUT',
        headers: { 'Content-Length': '5', 'X-Content-SHA256': digest },
        body: text,
      }),
    );
  return { store, audit, reservation, put, calls: () => calls };
}

describe('upload content commit', () => {
  it('verifies bytes, writes once and settles reserved storage only after success', async () => {
    const { store, reservation, put, calls } = await setup();
    expect(await put()).toMatchObject({ lifecycle: 'ready', bytes: 5 });
    expect(await put()).toMatchObject({ lifecycle: 'ready' });
    expect(calls()).toBe(1);
    expect(store.documents.get('budgets/r2_storage_bytes')).toMatchObject({
      spent: 5,
      reserved: 0,
    });
    expect(store.documents.get('budgets/r2_a_oct')?.spent).toBe(1);
    expect(
      store.documents.get(`reservations/${reservation.artifactId}`)
        ?.disposition,
    ).toBe('settled');
  });
  it('rejects corrupt bytes before any R2 accounting or write', async () => {
    const { put, calls, store } = await setup();
    await expect(put('wrong')).rejects.toMatchObject({
      code: 'digest_mismatch',
    });
    expect(calls()).toBe(0);
    expect(store.documents.get('budgets/r2_a_oct')?.spent).toBe(0);
  });
  it('keeps uncertain writes fenced and reserves bytes conservatively', async () => {
    const { put, calls, store, reservation } = await setup('timeout');
    await expect(put()).rejects.toMatchObject({
      code: 'upload_outcome_unknown',
    });
    await expect(put()).rejects.toMatchObject({
      code: 'upload_outcome_pending',
    });
    expect(calls()).toBe(1);
    expect(
      store.documents.get(`operations/upload_${reservation.artifactId}`)
        ?.outcome,
    ).toBe('unknown');
    expect(store.documents.get('budgets/r2_storage_bytes')).toMatchObject({
      reserved: 5,
      spent: 0,
    });
  });
  it('cannot publish a late write after audit deletion', async () => {
    const { put, store, reservation, audit } = await setup('delete');
    await expect(put()).rejects.toMatchObject({
      code: 'upload_outcome_unknown',
    });
    expect(
      store.documents.get(
        `audits/${audit.id}/artifacts/${reservation.artifactId}`,
      )?.lifecycle,
    ).toBe('reserved');
  });
  it('enforces write allowance before provider dispatch', async () => {
    const { put, store, calls } = await setup();
    store.documents.get('budgets/r2_a_oct')!.limit = 0;
    await expect(put()).rejects.toMatchObject({ code: 'budget_exhausted' });
    expect(calls()).toBe(0);
  });
  it('allows at most one write when identical uploads race', async () => {
    const { put, calls } = await setup();
    const outcomes = await Promise.allSettled([put(), put()]);
    expect(outcomes.some((value) => value.status === 'fulfilled')).toBe(true);
    expect(calls()).toBe(1);
  });
  it('uses create-only R2 conditions and a provider-verified checksum', async () => {
    const hash = await sha256('hello');
    const storage = new R2UploadStore({
      put: async (_key, bytes, options) => {
        expect(new TextDecoder().decode(bytes)).toBe('hello');
        expect(options.onlyIf.get('If-None-Match')).toBe('*');
        expect(options.storageClass).toBe('Standard');
        return { size: 5, checksums: { sha256: options.sha256 } };
      },
    });
    expect(
      await storage.putOnce(
        'generated-key',
        new TextEncoder()
          .encode('private-prefixhelloprivate-suffix')
          .subarray(14, 19),
        hash,
      ),
    ).toEqual({ size: 5, sha256: hash });
  });
});
