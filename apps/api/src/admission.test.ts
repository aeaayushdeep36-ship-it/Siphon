import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@siphon/contracts';
import { AdmissionRepository } from './admission.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { TestDocuments } from '../test/document-store.js';

async function revision(store: TestDocuments, uid = 'alice') {
  store.documents.set(`testers/${uid}`, { active: true });
  const { audit } = await new FirestoreAuditRepository(store).create(
    uid,
    {
      schemaVersion: '1.0',
      domain: 'heat_diffusion',
      title: 'Admission test',
    },
    crypto.randomUUID(),
  );
  const path = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
  const record = store.documents.get(path)!;
  record.stage = 'inspecting';
  record.status = 'running';
  return {
    uid,
    path,
    fence: {
      auditId: audit.id,
      revisionId: audit.currentRevisionId,
      generation: 0,
      inputDigest: String(record.inputDigest),
    },
  };
}

describe('transactional admission and execution capacity', () => {
  it('allows only one competing revision per user without consuming admission', async () => {
    const store = new TestDocuments();
    const a = await revision(store);
    const b = await revision(store);
    const service = new AdmissionRepository(store);
    const results = await Promise.allSettled([
      service.acquire(a.uid, a.fence),
      service.acquire(b.uid, b.fence),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(store.documents.get('slots/global')?.leaseIds).toHaveLength(1);
    expect(
      [...store.documents.keys()].some((key) => key.startsWith('dailyQuotas/')),
    ).toBe(false);
  });

  it('serializes requests for the last global slot across different users', async () => {
    const store = new TestDocuments();
    const service = new AdmissionRepository(store);
    const revisions = await Promise.all(
      ['alice', 'bob', 'carol', 'dan'].map((uid) => revision(store, uid)),
    );
    const results = await Promise.allSettled(
      revisions.map((r) => service.acquire(r.uid, r.fence)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(store.documents.get('slots/global')?.leaseIds).toHaveLength(3);
  });

  it('reuses a held lease and charges one admission across duplicate calls and UTC rollover', async () => {
    const store = new TestDocuments();
    const r = await revision(store);
    let now = new Date('2026-10-28T23:59:59Z');
    const service = new AdmissionRepository(store, () => now);
    const lease = await service.acquire(r.uid, r.fence);
    expect((await service.acquire(r.uid, r.fence)).id).toBe(lease.id);
    await Promise.all([
      service.markDispatching(r.uid, r.fence, lease.id),
      service.markDispatching(r.uid, r.fence, lease.id),
    ]);
    now = new Date('2026-10-29T00:00:01Z');
    await service.markDispatching(r.uid, r.fence, lease.id);
    await expect(
      service.releaseReconciled(r.uid, r.fence, lease.id),
    ).rejects.toMatchObject({ code: 'reconciliation_required' });
    expect(store.documents.get('dailyQuotas/global_2026-10-28')?.count).toBe(1);
    expect(store.documents.has('dailyQuotas/global_2026-10-29')).toBe(false);
    await expect(
      service.releaseUnused(r.uid, r.fence, lease.id),
    ).rejects.toMatchObject({ code: 'reconciliation_required' });
  });

  it('releases never-dispatched capacity without a quota charge, fencing the old lease', async () => {
    const store = new TestDocuments();
    const r = await revision(store);
    const service = new AdmissionRepository(store);
    const first = await service.acquire(r.uid, r.fence);
    await service.releaseUnused(r.uid, r.fence, first.id);
    const second = await service.acquire(r.uid, r.fence);
    expect(second.id).not.toBe(first.id);
    await service.releaseUnused(r.uid, r.fence, first.id);
    expect(store.documents.get('slots/global')?.leaseIds).toEqual([second.id]);
    await expect(
      service.markDispatching(r.uid, r.fence, first.id),
    ).rejects.toMatchObject({ code: 'stale_lease' });
    expect(store.documents.get('slots/global')?.leaseIds).toEqual([second.id]);
  });

  it.each(['global', 'user_alice'])(
    'rejects exhausted %s quota without partial writes',
    async (scope) => {
      const store = new TestDocuments();
      const r = await revision(store);
      const now = new Date('2026-10-28T12:00:00Z');
      const service = new AdmissionRepository(store, () => now);
      const lease = await service.acquire(r.uid, r.fence);
      store.documents.set(`dailyQuotas/${scope}_2026-10-28`, {
        schemaVersion: '1.0',
        count:
          scope === 'global'
            ? DEFAULT_POLICY.globalDailyAdmissions
            : DEFAULT_POLICY.userDailyAdmissions,
        updatedAt: now.toISOString(),
      });
      const before = structuredClone(store.documents);
      await expect(
        service.markDispatching(r.uid, r.fence, lease.id),
      ).rejects.toMatchObject({ code: 'admission_exhausted' });
      expect(store.documents).toEqual(before);
      await service.releaseUnused(r.uid, r.fence, lease.id);
    },
  );

  it('allows only one contender to consume the last daily admission', async () => {
    const store = new TestDocuments();
    const a = await revision(store, 'alice');
    const b = await revision(store, 'bob');
    const now = new Date('2026-10-28T12:00:00Z');
    const service = new AdmissionRepository(store, () => now);
    const leases = await Promise.all([
      service.acquire(a.uid, a.fence),
      service.acquire(b.uid, b.fence),
    ]);
    store.documents.set('dailyQuotas/global_2026-10-28', {
      schemaVersion: '1.0',
      count: 19,
      updatedAt: now.toISOString(),
    });
    const results = await Promise.allSettled([
      service.markDispatching(a.uid, a.fence, leases[0]!.id),
      service.markDispatching(b.uid, b.fence, leases[1]!.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(store.documents.get('dailyQuotas/global_2026-10-28')?.count).toBe(
      20,
    );
  });

  it('rejects stale, cancelled, uninvited and other-owner attempts', async () => {
    const store = new TestDocuments();
    const r = await revision(store);
    const service = new AdmissionRepository(store);
    const lease = await service.acquire(r.uid, r.fence);
    await expect(
      service.markDispatching(r.uid, { ...r.fence, generation: 1 }, lease.id),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    store.documents.set('testers/bob', { active: true });
    await expect(service.acquire('bob', r.fence)).rejects.toMatchObject({
      status: 404,
    });
    store.documents.set('testers/alice', { active: false });
    await expect(
      service.markDispatching(r.uid, r.fence, lease.id),
    ).rejects.toMatchObject({ status: 403 });
    store.documents.set('testers/alice', { active: true });
    Object.assign(store.documents.get(r.path)!, {
      stage: 'finished',
      status: 'cancelled',
      cancellationRequestedAt: new Date().toISOString(),
    });
    await expect(
      service.markDispatching(r.uid, r.fence, lease.id),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    expect(store.documents.get('slots/global')?.leaseIds).toEqual([lease.id]);
  });

  it('does not reclaim old possibly-running leases and fails closed on inconsistent ledgers', async () => {
    const store = new TestDocuments();
    const r = await revision(store);
    let now = new Date('2026-10-28T12:00:00Z');
    const service = new AdmissionRepository(store, () => now);
    const lease = await service.acquire(r.uid, r.fence);
    await service.markDispatching(r.uid, r.fence, lease.id);
    now = new Date('2026-11-28T12:00:00Z');
    const next = await revision(store);
    await expect(service.acquire(next.uid, next.fence)).rejects.toMatchObject({
      code: 'capacity_exhausted',
    });
    store.documents.get('slots/global')!.leaseIds = [];
    await expect(service.acquire(r.uid, r.fence)).rejects.toThrow(
      'inconsistent',
    );
  });

  it('applies tighter server policy even when the revision snapshot permits more work', async () => {
    const store = new TestDocuments();
    const a = await revision(store, 'alice');
    const b = await revision(store, 'bob');
    const service = new AdmissionRepository(store, undefined, {
      ...DEFAULT_POLICY,
      globalActiveRevisions: 1,
    });
    await service.acquire(a.uid, a.fence);
    await expect(service.acquire(b.uid, b.fence)).rejects.toMatchObject({
      code: 'capacity_exhausted',
    });
  });
});
