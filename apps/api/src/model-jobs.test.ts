import { describe, expect, it } from 'vitest';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { ModelJobs } from './model-jobs.js';
import { Operation, markDispatching, reserveOperation } from './accounting.js';
import { FirestoreAccountingStore } from './firestore-accounting.js';
import { AdmissionRepository } from './admission.js';
import { MetaFailure } from './meta-client.js';
import { AuditCommands } from './audit-commands.js';
import { sha256 } from './hashing.js';

const now = '2026-10-28T00:00:00Z';
async function setup() {
  const docs = new TestDocuments();
  docs.documents.set('testers/alice', { active: true });
  const { audit } = await new FirestoreAuditRepository(docs).create(
    'alice',
    { schemaVersion: '1.0', domain: 'heat_diffusion', title: 'Job' },
    'create',
  );
  const revision = docs.documents.get(
    `audits/${audit.id}/revisions/${audit.currentRevisionId}`,
  )!;
  revision.status = 'running';
  revision.stage = 'inspecting';
  const pricing = {
    schemaVersion: '1.0',
    version: 'fixture',
    model: 'muse-wonder-1.0',
    mode: 'standard',
    verifiedAt: now,
    effectiveFrom: now,
    effectiveUntil: '2026-10-29T00:00:00Z',
    inputMicroUsdPerMillion: 4000000,
    cachedInputMicroUsdPerMillion: 200000,
    outputMicroUsdPerMillion: 20000000,
  };
  docs.documents.set('configuration/meta_pricing', pricing);
  const operation = Operation.parse({
    schemaVersion: '1.0',
    id: crypto.randomUUID(),
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    ownerUid: 'alice',
    inputDigest: revision.inputDigest,
    requestDigest: 'b'.repeat(64),
    fence: 0,
    outcome: 'reserved',
    usage: null,
    providerHandle: null,
    createdAt: now,
    updatedAt: now,
    charges: [
      {
        counterKey: 'global',
        unit: 'micro_usd',
        amount: 241,
        consumeOnDispatch: false,
      },
      {
        counterKey: 'revision',
        unit: 'micro_usd',
        amount: 241,
        consumeOnDispatch: false,
      },
      {
        counterKey: 'attempt',
        unit: 'attempts',
        amount: 1,
        consumeOnDispatch: true,
      },
    ],
  });
  for (const key of ['global', 'revision', 'attempt'])
    docs.documents.set(`budgets/${key}`, {
      schemaVersion: '1.0',
      limit: 10000,
      spent: 0,
      reserved: 0,
      halted: false,
    });
  const accounting = new FirestoreAccountingStore(docs);
  await reserveOperation(accounting, operation);
  await new AdmissionRepository(docs).acquire('alice', {
    auditId: operation.auditId,
    revisionId: operation.revisionId,
    generation: operation.fence,
    inputDigest: operation.inputDigest,
  });
  return {
    docs,
    operation,
    accounting,
    jobs: new ModelJobs(docs, () => new Date(now)),
    evidence: crypto.randomUUID(),
  };
}
describe('durable model pricing snapshots', () => {
  it('settles a late model response after cancellation and lets maintenance release its slot', async () => {
    const f = await setup();
    const fence = {
      auditId: f.operation.auditId,
      revisionId: f.operation.revisionId,
      generation: 0,
      inputDigest: f.operation.inputDigest,
    };
    const admission = new AdmissionRepository(f.docs);
    await f.jobs.bind(f.operation.id, 10, 10, f.evidence);
    await markDispatching(f.accounting, f.operation.id, 0, now);
    await new AuditCommands(f.docs).cancel(
      'alice',
      fence.auditId,
      fence.revisionId,
      'cancel',
    );
    f.docs.documents.set('testers/alice', { active: false });
    const maintenanceId = await sha256(
      `cancel_revision:${fence.auditId}:${fence.revisionId}`,
    );
    await expect(
      admission.releaseForMaintenance(maintenanceId),
    ).rejects.toMatchObject({ code: 'reconciliation_required' });
    await f.jobs.settle(f.operation.id, {
      kind: 'succeeded',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    expect(await admission.releaseForMaintenance(maintenanceId)).toBe(
      'released',
    );
    expect(
      f.docs.documents.get(
        `audits/${fence.auditId}/revisions/${fence.revisionId}`,
      )?.status,
    ).toBe('cancelled');
    expect(f.docs.documents.get('budgets/global')?.spent).toBe(140);
  });
  it('releases tracked capacity after model completion and does not recount a resumed revision', async () => {
    const f = await setup();
    const fence = {
      auditId: f.operation.auditId,
      revisionId: f.operation.revisionId,
      generation: 0,
      inputDigest: f.operation.inputDigest,
    };
    const admission = new AdmissionRepository(f.docs, () => new Date(now));
    const lease = await admission.acquire('alice', fence);
    await f.jobs.bind(f.operation.id, 10, 10, f.evidence);
    await markDispatching(f.accounting, f.operation.id, 0, now);
    await expect(
      admission.releaseReconciled('alice', fence, lease.id),
    ).rejects.toMatchObject({ code: 'reconciliation_required' });
    const completion = {
      kind: 'succeeded' as const,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    await f.jobs.settle(f.operation.id, completion);
    await f.jobs.settle(f.operation.id, completion);
    expect(
      f.docs.documents.get(`slotLeases/${lease.id}`)?.pendingOperations,
    ).toBe(0);
    await admission.releaseReconciled('alice', fence, lease.id);
    expect(f.docs.documents.get('slots/global')?.leaseIds).toEqual([]);
    // A late duplicate completion must not decrement the successor lease.
    const next = await admission.acquire('alice', fence);
    await f.jobs.settle(f.operation.id, completion);
    expect(next.id).not.toBe(lease.id);
    const operation = { ...f.operation, id: crypto.randomUUID() };
    await reserveOperation(f.accounting, operation);
    await f.jobs.bind(operation.id, 10, 10, crypto.randomUUID());
    await markDispatching(f.accounting, operation.id, 0, now);
    expect(f.docs.documents.get('dailyQuotas/global_2026-10-28')?.count).toBe(
      1,
    );
    expect(
      f.docs.documents.get(`slotLeases/${next.id}`)?.pendingOperations,
    ).toBe(1);
  });

  it('retains capacity for ambiguous model completion and resolves it on a later response', async () => {
    const f = await setup();
    const fence = {
      auditId: f.operation.auditId,
      revisionId: f.operation.revisionId,
      generation: 0,
      inputDigest: f.operation.inputDigest,
    };
    const admission = new AdmissionRepository(f.docs);
    const lease = await admission.acquire('alice', fence);
    await f.jobs.bind(f.operation.id, 10, 10, f.evidence);
    await markDispatching(f.accounting, f.operation.id, 0, now);
    await f.jobs.settle(f.operation.id, {
      kind: 'failed',
      failure: new MetaFailure('transport_unknown', null),
    });
    expect(
      f.docs.documents.get(`slotLeases/${lease.id}`)?.pendingOperations,
    ).toBe(1);
    await expect(
      admission.releaseReconciled('alice', fence, lease.id),
    ).rejects.toMatchObject({ code: 'reconciliation_required' });
    await f.jobs.settle(f.operation.id, {
      kind: 'failed',
      failure: new MetaFailure('invalid_response', {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      }),
    });
    await admission.releaseReconciled('alice', fence, lease.id);
  });

  it('cannot release a lease while another tracked operation is still pending', async () => {
    const f = await setup();
    const fence = {
      auditId: f.operation.auditId,
      revisionId: f.operation.revisionId,
      generation: 0,
      inputDigest: f.operation.inputDigest,
    };
    const admission = new AdmissionRepository(f.docs);
    const lease = await admission.acquire('alice', fence);
    const second = { ...f.operation, id: crypto.randomUUID() };
    await reserveOperation(f.accounting, second);
    for (const operation of [f.operation, second]) {
      await f.jobs.bind(operation.id, 10, 10, crypto.randomUUID());
      await markDispatching(f.accounting, operation.id, 0, now);
    }
    const completion = {
      kind: 'succeeded' as const,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    await f.jobs.settle(f.operation.id, completion);
    await expect(
      admission.releaseReconciled('alice', fence, lease.id),
    ).rejects.toMatchObject({ code: 'reconciliation_required' });
    await f.jobs.settle(second.id, completion);
    await admission.releaseReconciled('alice', fence, lease.id);
  });
  it('halts on an input-token overrun even below the reserved monetary amount', async () => {
    const f = await setup();
    await f.jobs.bind(f.operation.id, 10, 10, f.evidence);
    await markDispatching(f.accounting, f.operation.id, 0, now);
    const completion = {
      kind: 'succeeded' as const,
      usage: { prompt_tokens: 11, completion_tokens: 0, total_tokens: 11 },
    };
    await f.jobs.settle(f.operation.id, completion);
    await f.jobs.settle(f.operation.id, completion);
    expect(f.docs.documents.get('budgets/global')).toMatchObject({
      spent: 44,
      reserved: 0,
      halted: true,
    });
    expect(f.docs.documents.get('budgets/revision')?.halted).toBe(true);
    expect(f.docs.documents.get(`operations/${f.operation.id}`)?.outcome).toBe(
      'failed',
    );
    expect(
      f.docs.documents.get(`modelIncidents/${f.operation.id}`),
    ).toMatchObject({ code: 'token_bound_exceeded', observedInputTokens: 11 });
  });
  it('does not mutate counters for malformed usage', async () => {
    const f = await setup();
    await f.jobs.bind(f.operation.id, 10, 10, f.evidence);
    await expect(
      f.jobs.settle(f.operation.id, {
        kind: 'succeeded',
        usage: {
          prompt_tokens: 11,
          completion_tokens: 0,
          total_tokens: 2,
        },
      }),
    ).rejects.toThrow();
    expect(f.docs.documents.get('budgets/global')).toMatchObject({
      halted: false,
      reserved: 241,
    });
  });
  it('binds once and settles from the original price after live configuration changes', async () => {
    const f = await setup();
    const one = await f.jobs.bind(f.operation.id, 10, 10, f.evidence);
    expect(await f.jobs.bind(f.operation.id, 10, 10, f.evidence)).toEqual(one);
    f.docs.documents.get(
      'configuration/meta_pricing',
    )!.outputMicroUsdPerMillion = 90000000;
    await markDispatching(f.accounting, f.operation.id, 0, now);
    await f.jobs.settle(f.operation.id, {
      kind: 'succeeded',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    expect(f.docs.documents.get('budgets/global')).toMatchObject({
      spent: 140,
      reserved: 0,
    });
  });
  it('rejects altered bindings and reservations that do not cover the bound request', async () => {
    const f = await setup();
    await expect(
      f.jobs.bind(f.operation.id, 11, 10, f.evidence),
    ).rejects.toThrow('Reservation');
    await f.jobs.bind(f.operation.id, 10, 10, f.evidence);
    await expect(
      f.jobs.bind(f.operation.id, 10, 10, crypto.randomUUID()),
    ).rejects.toThrow('conflict');
  });
  it('cannot manufacture a price snapshot after dispatch', async () => {
    const f = await setup();
    await markDispatching(f.accounting, f.operation.id, 0, now);
    await expect(
      f.jobs.bind(f.operation.id, 10, 10, f.evidence),
    ).rejects.toThrow('after dispatch');
  });
  it('rejects corrupted price records before settlement', async () => {
    const f = await setup();
    await f.jobs.bind(f.operation.id, 10, 10, f.evidence);
    const job = f.docs.documents.get(`modelJobs/${f.operation.id}`)!;
    job.pricingDigest = 'c'.repeat(64);
    await expect(
      f.jobs.settle(f.operation.id, {
        kind: 'succeeded',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    ).rejects.toThrow('integrity');
    expect(f.docs.documents.get('budgets/global')?.reserved).toBe(241);
  });
});
