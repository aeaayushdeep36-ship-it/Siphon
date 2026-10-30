import { describe, expect, it } from 'vitest';
import { TestDocuments } from '../test/document-store.js';
import { AuditCommands, requireActiveRevision } from './audit-commands.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { FirestoreAccountingStore } from './firestore-accounting.js';
import { AdmissionRepository } from './admission.js';
import {
  reserveOperation,
  markDispatching,
  markUnknown,
  settleOperation,
  type Operation,
} from './accounting.js';

async function setup() {
  const store = new TestDocuments();
  store.documents.set('testers/alice', { active: true });
  store.documents.set('testers/bob', { active: true });
  const repository = new FirestoreAuditRepository(store);
  const { audit } = await repository.create(
    'alice',
    { schemaVersion: '1.0', title: 'Test', domain: 'heat_diffusion' },
    'create',
  );
  const commands = new AuditCommands(store);
  const revisionPath = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
  return { store, repository, audit, commands, revisionPath };
}

describe('durable cancellation and deletion', () => {
  it('rechecks cancellation inside dispatch accounting while permitting late financial settlement', async () => {
    const { store, audit, commands, revisionPath } = await setup();
    const revision = store.documents.get(revisionPath)!;
    Object.assign(revision, { stage: 'executing', status: 'running' });
    store.documents.set('budgets/meta', {
      schemaVersion: '1.0',
      limit: 100,
      spent: 0,
      reserved: 0,
      halted: false,
    });
    const accounting = new FirestoreAccountingStore(store);
    const operation: Operation = {
      schemaVersion: '1.0',
      id: crypto.randomUUID(),
      revisionId: audit.currentRevisionId,
      auditId: audit.id,
      ownerUid: 'alice',
      inputDigest: String(revision.inputDigest),
      requestDigest: 'e'.repeat(64),
      fence: 0,
      outcome: 'reserved',
      usage: null,
      providerHandle: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      charges: [
        {
          counterKey: 'meta',
          amount: 40,
          unit: 'micro_usd',
          consumeOnDispatch: false,
        },
      ],
    };
    await reserveOperation(accounting, operation);
    const inFlight = { ...operation, id: crypto.randomUUID() };
    await reserveOperation(accounting, inFlight);
    await new AdmissionRepository(store).acquire('alice', {
      auditId: operation.auditId,
      revisionId: operation.revisionId,
      generation: operation.fence,
      inputDigest: operation.inputDigest,
    });
    await markDispatching(accounting, inFlight.id, 0, operation.createdAt);
    await markUnknown(accounting, inFlight.id, 0, operation.createdAt, null);
    await commands.cancel('alice', audit.id, audit.currentRevisionId, 'cancel');
    await expect(
      markDispatching(accounting, operation.id, 0, operation.createdAt),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    await expect(
      reserveOperation(accounting, { ...operation, id: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    await settleOperation(
      accounting,
      inFlight.id,
      0,
      { meta: 30 },
      'succeeded',
      operation.createdAt,
    );
    expect(store.documents.get('budgets/meta')).toMatchObject({
      spent: 30,
      reserved: 40,
    });
    expect(store.documents.get(revisionPath)?.status).toBe('cancelled');
  });
  it('atomically records cancellation and one cleanup job, preserving evidence and uncertain charges', async () => {
    const { store, audit, commands, revisionPath } = await setup();
    const revision = store.documents.get(revisionPath)!;
    Object.assign(revision, {
      status: 'running',
      stage: 'executing',
      evidencePointer: 'retained-evidence',
    });
    store.documents.set('budgets/meta', { reserved: 100 });
    store.documents.set('operations/unknown', { outcome: 'unknown' });
    const results = await Promise.all([
      commands.cancel('alice', audit.id, audit.currentRevisionId, 'one'),
      commands.cancel('alice', audit.id, audit.currentRevisionId, 'one'),
      commands.cancel('alice', audit.id, audit.currentRevisionId, 'two'),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0]?.cleanup).toBe('pending');
    expect(store.documents.get(revisionPath)).toMatchObject({
      status: 'cancelled',
      generation: 1,
      evidencePointer: 'retained-evidence',
    });
    expect(
      [...store.documents.keys()].filter((path) =>
        path.startsWith('maintenance/'),
      ),
    ).toHaveLength(1);
    expect(store.documents.get('budgets/meta')).toEqual({ reserved: 100 });
    expect(store.documents.get('operations/unknown')).toEqual({
      outcome: 'unknown',
    });
  });
  it('immediately denies reads after tombstoning and does not reset cleanup on repeated delete', async () => {
    const { store, audit, commands, repository } = await setup();
    const first = await commands.remove('alice', audit.id, 'delete');
    await expect(repository.getOwned('alice', audit.id)).rejects.toMatchObject({
      status: 404,
    });
    const jobKey = [...store.documents.keys()].find((key) =>
      key.startsWith('maintenance/'),
    )!;
    store.documents.get(jobKey)!.cursor = 'page-two';
    expect(await commands.remove('alice', audit.id, 'delete')).toEqual(first);
    expect(await commands.remove('alice', audit.id, 'new-delete')).toEqual(
      first,
    );
    expect(store.documents.get(jobKey)?.cursor).toBe('page-two');
    await expect(
      commands.cancel('alice', audit.id, audit.currentRevisionId, 'cancel'),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('checks ownership and renewed invitation on mutations and receipt replays', async () => {
    const { store, audit, commands } = await setup();
    await expect(
      commands.remove('bob', audit.id, 'delete'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      commands.cancel('bob', audit.id, audit.currentRevisionId, 'cancel'),
    ).rejects.toMatchObject({ status: 404 });
    await commands.cancel('alice', audit.id, audit.currentRevisionId, 'cancel');
    store.documents.set('testers/alice', { active: false });
    await expect(
      commands.cancel('alice', audit.id, audit.currentRevisionId, 'cancel'),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('does not relabel a completed audit as cancelled when deleting it', async () => {
    const { store, audit, commands, revisionPath } = await setup();
    Object.assign(store.documents.get(revisionPath)!, {
      status: 'completed',
      stage: 'finished',
    });
    await expect(
      commands.cancel('alice', audit.id, audit.currentRevisionId, 'cancel'),
    ).rejects.toMatchObject({ code: 'already_finished' });
    await commands.remove('alice', audit.id, 'delete');
    expect(store.documents.get(revisionPath)?.status).toBe('completed');
  });
  it('prevents stale publication after cancellation, deletion, changed input or invitation revocation', async () => {
    for (const change of ['cancel', 'delete', 'input', 'invite'] as const) {
      const { store, audit, commands, revisionPath } = await setup();
      const revision = store.documents.get(revisionPath)!;
      Object.assign(revision, { status: 'running', stage: 'executing' });
      const fence = {
        auditId: audit.id,
        revisionId: audit.currentRevisionId,
        generation: 0,
        inputDigest: String(revision.inputDigest),
      };
      await expect(
        store.transaction((tx) => requireActiveRevision(tx, 'alice', fence)),
      ).resolves.toBeDefined();
      if (change === 'cancel')
        await commands.cancel(
          'alice',
          audit.id,
          audit.currentRevisionId,
          'cancel',
        );
      if (change === 'delete')
        await commands.remove('alice', audit.id, 'delete');
      if (change === 'input')
        store.documents.get(revisionPath)!.inputDigest = 'f'.repeat(64);
      if (change === 'invite')
        store.documents.set('testers/alice', { active: false });
      await expect(
        store.transaction(async (tx) => {
          await requireActiveRevision(tx, 'alice', fence);
          tx.set(`${revisionPath}/evidence/late`, { published: true });
        }),
      ).rejects.toBeDefined();
      expect(store.documents.has(`${revisionPath}/evidence/late`)).toBe(false);
    }
  });
});
