import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@siphon/contracts';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { AdmissionRepository } from './admission.js';
import { FirestoreAccountingStore } from './firestore-accounting.js';
import {
  Operation,
  markDispatching,
  reserveOperation,
  settleOperation,
} from './accounting.js';

const now = '2026-10-28T12:00:00.000Z';
async function setup() {
  const store = new TestDocuments();
  store.documents.set('testers/alice', { active: true });
  const { audit } = await new FirestoreAuditRepository(store).create(
    'alice',
    {
      schemaVersion: '1.0',
      title: 'Dispatch boundary',
      domain: 'orbital_dynamics',
    },
    'create',
  );
  const path = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
  const record = store.documents.get(path)!;
  Object.assign(record, { stage: 'inspecting', status: 'running' });
  const operation = Operation.parse({
    schemaVersion: '1.0',
    id: crypto.randomUUID(),
    ownerUid: 'alice',
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    fence: 0,
    inputDigest: record.inputDigest,
    requestDigest: 'a'.repeat(64),
    outcome: 'reserved',
    usage: null,
    providerHandle: null,
    createdAt: now,
    updatedAt: now,
    charges: [
      {
        counterKey: 'meta',
        amount: 100,
        unit: 'micro_usd',
        consumeOnDispatch: false,
      },
      {
        counterKey: 'attempt',
        amount: 1,
        unit: 'attempts',
        consumeOnDispatch: true,
      },
    ],
  });
  for (const key of ['meta', 'attempt'])
    store.documents.set(`budgets/${key}`, {
      schemaVersion: '1.0',
      limit: 1000,
      reserved: 0,
      spent: 0,
      halted: false,
    });
  const accounting = new FirestoreAccountingStore(store);
  await reserveOperation(accounting, operation);
  const fence = {
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    generation: 0,
    inputDigest: operation.inputDigest,
  };
  const admission = new AdmissionRepository(store, () => new Date(now));
  return {
    store,
    operation,
    accounting,
    admission,
    fence,
    path,
    dispatch: () => markDispatching(accounting, operation.id, 0, now),
  };
}

describe('atomic dispatch admission boundary', () => {
  it('does not treat generic financial settlement as execution termination', async () => {
    const f = await setup();
    const lease = await f.admission.acquire('alice', f.fence);
    await f.dispatch();
    await settleOperation(
      f.accounting,
      f.operation.id,
      0,
      { meta: 80, attempt: 1 },
      'succeeded',
      now,
    );
    await expect(
      f.admission.releaseReconciled('alice', f.fence, lease.id),
    ).rejects.toMatchObject({ code: 'reconciliation_required' });
    expect(
      f.store.documents.get(`leaseOperations/${f.operation.id}`)?.status,
    ).toBe('pending');
  });
  it('refuses direct dispatch without capacity and leaves reservations untouched', async () => {
    const f = await setup();
    const before = structuredClone(f.store.documents);
    await expect(f.dispatch()).rejects.toMatchObject({
      code: 'capacity_required',
    });
    expect(f.store.documents).toEqual(before);
  });

  it('commits quota, lease dispatch flag and attempt together exactly once', async () => {
    const f = await setup();
    const lease = await f.admission.acquire('alice', f.fence);
    const results = await Promise.allSettled([f.dispatch(), f.dispatch()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.store.documents.get('dailyQuotas/global_2026-10-28')?.count).toBe(
      1,
    );
    expect(f.store.documents.get('budgets/attempt')).toMatchObject({
      spent: 1,
      reserved: 0,
    });
    expect(
      f.store.documents.get(`slotLeases/${lease.id}`)?.dispatchMayHaveStarted,
    ).toBe(true);
    expect(f.store.documents.get(`operations/${f.operation.id}`)?.outcome).toBe(
      'dispatching',
    );
    await expect(
      f.admission.releaseUnused('alice', f.fence, lease.id),
    ).rejects.toMatchObject({ code: 'reconciliation_required' });
  });

  it.each(['quota', 'budget'])(
    'retains unused lease and reservations when %s prevents dispatch',
    async (reason) => {
      const f = await setup();
      const lease = await f.admission.acquire('alice', f.fence);
      if (reason === 'quota')
        f.store.documents.set('dailyQuotas/global_2026-10-28', {
          schemaVersion: '1.0',
          count: DEFAULT_POLICY.globalDailyAdmissions,
          updatedAt: now,
        });
      else f.store.documents.get('budgets/meta')!.halted = true;
      const before = structuredClone(f.store.documents);
      await expect(f.dispatch()).rejects.toMatchObject({
        code: reason === 'quota' ? 'admission_exhausted' : 'budget_exhausted',
      });
      expect(f.store.documents).toEqual(before);
      await f.admission.releaseUnused('alice', f.fence, lease.id);
    },
  );

  it.each(['release', 'dispatch'])(
    'serializes a slot release racing with dispatch when %s wins',
    async (first) => {
      const f = await setup();
      const lease = await f.admission.acquire('alice', f.fence);
      const release = () =>
        f.admission.releaseUnused('alice', f.fence, lease.id);
      const results = await Promise.allSettled(
        first === 'release'
          ? [release(), f.dispatch()]
          : [f.dispatch(), release()],
      );
      expect(results[0]?.status).toBe('fulfilled');
      expect(results[1]?.status).toBe('rejected');
      expect(
        f.store.documents.get(`operations/${f.operation.id}`)?.outcome,
      ).toBe(first === 'release' ? 'reserved' : 'dispatching');
      expect(f.store.documents.get('slots/global')?.leaseIds).toHaveLength(
        first === 'release' ? 0 : 1,
      );
    },
  );
});
