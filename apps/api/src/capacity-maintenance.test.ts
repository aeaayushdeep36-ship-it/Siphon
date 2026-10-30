import { describe, expect, it } from 'vitest';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { AuditCommands } from './audit-commands.js';
import { AdmissionRepository } from './admission.js';
import { sha256 } from './hashing.js';

async function setup() {
  const docs = new TestDocuments();
  docs.documents.set('testers/alice', { active: true });
  const { audit } = await new FirestoreAuditRepository(docs).create(
    'alice',
    {
      schemaVersion: '1.0',
      domain: 'heat_diffusion',
      title: 'Cleanup',
    },
    'create',
  );
  const path = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
  const revision = docs.documents.get(path)!;
  Object.assign(revision, { stage: 'inspecting', status: 'running' });
  const fence = {
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    generation: 0,
    inputDigest: String(revision.inputDigest),
  };
  const admission = new AdmissionRepository(docs);
  const lease = await admission.acquire('alice', fence);
  return {
    docs,
    audit,
    path,
    fence,
    admission,
    lease,
    commands: new AuditCommands(docs),
    cancellationId: await sha256(
      `cancel_revision:${audit.id}:${audit.currentRevisionId}`,
    ),
    deletionId: await sha256(`delete_audit:${audit.id}`),
  };
}

describe('durable cancellation capacity cleanup', () => {
  it('releases unused capacity after cancellation and invitation revocation without claiming full cleanup', async () => {
    const f = await setup();
    await f.commands.cancel(
      'alice',
      f.audit.id,
      f.audit.currentRevisionId,
      'cancel',
    );
    f.docs.documents.set('testers/alice', { active: false });
    expect(await f.admission.releaseForMaintenance(f.cancellationId)).toBe(
      'released',
    );
    expect(await f.admission.releaseForMaintenance(f.cancellationId)).toBe(
      'no_lease',
    );
    expect(f.docs.documents.get('slots/global')?.leaseIds).toEqual([]);
    expect(f.docs.documents.get(f.path)?.status).toBe('cancelled');
    expect(
      f.docs.documents.get(`maintenance/${f.cancellationId}`),
    ).toMatchObject({ status: 'pending', phase: 'terminate_and_reconcile' });
    expect(
      f.docs.documents.get(`maintenance/${f.cancellationId}`)
        ?.capacityReleasedAt,
    ).toBeDefined();
  });

  it('serializes cancellation and deletion cleanup for the same slot', async () => {
    const f = await setup();
    await f.commands.cancel(
      'alice',
      f.audit.id,
      f.audit.currentRevisionId,
      'cancel',
    );
    await f.commands.remove('alice', f.audit.id, 'delete');
    const results = await Promise.all([
      f.admission.releaseForMaintenance(f.cancellationId),
      f.admission.releaseForMaintenance(f.deletionId),
    ]);
    expect(results.sort()).toEqual(['no_lease', 'released']);
    expect(f.docs.documents.get('slots/global')?.leaseIds).toEqual([]);
    expect(
      f.docs.documents.get(`audits/${f.audit.id}`)?.deletionRequestedAt,
    ).not.toBeNull();
  });

  it('retains possibly dispatched untracked capacity after cancellation', async () => {
    const f = await setup();
    await f.admission.markDispatching('alice', f.fence, f.lease.id);
    await f.commands.cancel(
      'alice',
      f.audit.id,
      f.audit.currentRevisionId,
      'cancel',
    );
    const before = structuredClone(f.docs.documents);
    await expect(
      f.admission.releaseForMaintenance(f.cancellationId),
    ).rejects.toMatchObject({ code: 'reconciliation_required' });
    expect(f.docs.documents).toEqual(before);
  });

  it.each(['owner', 'identity', 'not_cancelled', 'pending'])(
    'fails closed on %s inconsistency',
    async (kind) => {
      const f = await setup();
      await f.commands.cancel(
        'alice',
        f.audit.id,
        f.audit.currentRevisionId,
        'cancel',
      );
      if (kind === 'owner')
        f.docs.documents.get(`maintenance/${f.cancellationId}`)!.ownerUid =
          'bob';
      if (kind === 'identity')
        f.docs.documents.get(`maintenance/${f.cancellationId}`)!.revisionId =
          crypto.randomUUID();
      if (kind === 'not_cancelled')
        Object.assign(f.docs.documents.get(f.path)!, {
          stage: 'inspecting',
          status: 'running',
          cancellationRequestedAt: null,
        });
      if (kind === 'pending')
        f.docs.documents.get(`slotLeases/${f.lease.id}`)!.pendingOperations = 1;
      await expect(
        f.admission.releaseForMaintenance(f.cancellationId),
      ).rejects.toThrow();
      expect(f.docs.documents.get('slots/global')?.leaseIds).toEqual([
        f.lease.id,
      ]);
    },
  );
});
