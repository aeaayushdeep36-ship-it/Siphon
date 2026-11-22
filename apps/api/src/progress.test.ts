import { describe, expect, it, vi } from 'vitest';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { ProgressRepository } from './progress.js';
import { AuditCommands } from './audit-commands.js';

async function setup() {
  const store = new TestDocuments();
  store.documents.set('testers/alice', { active: true });
  store.documents.set('testers/bob', { active: true });
  const { audit } = await new FirestoreAuditRepository(store).create(
    'alice',
    { schemaVersion: '1.0', title: 'Heat', domain: 'heat_diffusion' },
    'create',
  );
  const path = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
  const revision = store.documents.get(path)!;
  Object.assign(revision, { stage: 'executing', status: 'running' });
  const fence = {
    revisionId: audit.currentRevisionId,
    generation: 0,
    inputDigest: String(revision.inputDigest),
  };
  let time = Date.parse('2026-10-28T00:00:00Z');
  const repository = new ProgressRepository(store, () => new Date(time));
  const publish = (completed: number) =>
    repository.publish('alice', audit.id, fence, {
      activity: 'running_experiment',
      experiments: { completed, planned: 8 },
    });
  return {
    store,
    audit,
    path,
    revision,
    fence,
    repository,
    publish,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('durable bounded progress', () => {
  it('reads only public summary fields without modifying state or inventing progress', async () => {
    const f = await setup();
    f.store.documents.get(f.path)!.privateContext = 'not public';
    const before = structuredClone(f.store.documents);
    const initial = await f.repository.get(
      'alice',
      f.audit.id,
      f.fence.revisionId,
    );
    expect(initial.progress).toBeNull();
    expect(initial.pollAfterSeconds).toBe(5);
    expect(JSON.stringify(initial)).not.toContain('not public');
    expect(f.store.documents).toEqual(before);
    await f.publish(2);
    const current = await f.repository.get(
      'alice',
      f.audit.id,
      f.fence.revisionId,
    );
    expect(current.progress?.experiments).toEqual({ completed: 2, planned: 8 });
  });
  it('suppresses an obsolete running activity after cancellation and stops polling', async () => {
    const f = await setup();
    await f.publish(2);
    await new AuditCommands(f.store).cancel(
      'alice',
      f.audit.id,
      f.fence.revisionId,
      'cancel',
    );
    const result = await f.repository.get(
      'alice',
      f.audit.id,
      f.fence.revisionId,
    );
    expect(result).toMatchObject({
      status: 'cancelled',
      stage: 'finished',
      progress: null,
      pollAfterSeconds: null,
    });
  });
  it('does not open a write transaction on read-only get', async () => {
    const f = await setup();
    const transactionSpy = vi.spyOn(f.store, 'transaction');
    const result = await f.repository.get(
      'alice',
      f.audit.id,
      f.fence.revisionId,
    );
    expect(result.status).toBe('running');
    expect(transactionSpy).not.toHaveBeenCalled();
    transactionSpy.mockRestore();
  });
  it('denies other owners, inactive invitations and deleted audits', async () => {
    const f = await setup();
    await expect(
      f.repository.get('bob', f.audit.id, f.fence.revisionId),
    ).rejects.toMatchObject({ status: 404 });
    f.store.documents.set('testers/alice', { active: false });
    await expect(
      f.repository.get('alice', f.audit.id, f.fence.revisionId),
    ).rejects.toMatchObject({ status: 403 });
    f.store.documents.set('testers/alice', { active: true });
    await new AuditCommands(f.store).remove('alice', f.audit.id, 'delete');
    await expect(
      f.repository.get('alice', f.audit.id, f.fence.revisionId),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('labels historical snapshots and rejects mismatched summary identities', async () => {
    const f = await setup();
    await f.publish(1);
    f.store.documents.get(`audits/${f.audit.id}`)!.currentRevisionId =
      crypto.randomUUID();
    expect(
      await f.repository.get('alice', f.audit.id, f.fence.revisionId),
    ).toMatchObject({ isCurrentRevision: false, pollAfterSeconds: null });
    const progress = f.store.documents.get(f.path)!.progress as Record<
      string,
      unknown
    >;
    progress.revisionId = crypto.randomUUID();
    await expect(
      f.repository.get('alice', f.audit.id, f.fence.revisionId),
    ).rejects.toThrow('identity');
  });
  it('coalesces activity writes and records only real counts, without changing dispatch fences', async () => {
    const { publish, advance, store, path } = await setup();
    expect((await publish(0)).published).toBe(true);
    expect((await publish(1)).published).toBe(false);
    advance(5000);
    expect((await publish(1)).published).toBe(true);
    expect((await publish(1)).published).toBe(false);
    expect(store.documents.get(path)?.generation).toBe(0);
    expect(
      [...store.documents.keys()].filter((key) => key.includes('/events/')),
    ).toHaveLength(2);
  });
  it('serializes concurrent updates without duplicate event sequences', async () => {
    const { publish, store } = await setup();
    const results = await Promise.all([publish(0), publish(0), publish(0)]);
    expect(results.filter((result) => result.published)).toHaveLength(1);
    expect(
      [...store.documents.keys()].filter((key) =>
        key.endsWith('/events/000001'),
      ),
    ).toHaveLength(1);
  });
  it('preserves final status after reaching the event cap', async () => {
    const {
      publish,
      advance,
      store,
      path,
      revision,
      repository,
      audit,
      fence,
    } = await setup();
    (revision.policy as Record<string, unknown>).progressEvents = 2;
    await publish(0);
    advance(5000);
    await publish(1);
    advance(5000);
    const capped = await publish(2);
    expect(capped.summary).toMatchObject({
      eventCount: 2,
      timelineCapped: true,
      experiments: { completed: 2 },
    });
    Object.assign(store.documents.get(path)!, {
      stage: 'finished',
      status: 'partial',
      generation: 1,
    });
    const final = await repository.publish(
      'alice',
      audit.id,
      { ...fence, generation: 1 },
      { activity: 'finished', experiments: { completed: 2, planned: 8 } },
    );
    expect(final.summary).toMatchObject({
      status: 'partial',
      eventCount: 2,
      timelineCapped: true,
    });
    expect(
      [...store.documents.keys()].filter((key) => key.includes('/events/')),
    ).toHaveLength(2);
  });
  it('rejects invented activities, regressing counts and stale generation', async () => {
    const { publish, repository, audit, fence } = await setup();
    await publish(2);
    await expect(publish(1)).rejects.toMatchObject({
      code: 'invalid_progress',
    });
    await expect(
      repository.publish('alice', audit.id, fence, {
        activity: 'rendering_report',
        experiments: null,
      }),
    ).rejects.toMatchObject({ code: 'invalid_progress' });
    await expect(
      repository.publish(
        'alice',
        audit.id,
        { ...fence, generation: 1 },
        { activity: 'running_experiment', experiments: null },
      ),
    ).rejects.toThrow('Stale');
  });
  it('rejects cross-user, revoked invitation and deleted audit progress', async () => {
    const { store, audit, fence, repository, publish } = await setup();
    await expect(
      repository.publish('bob', audit.id, fence, {
        activity: 'running_experiment',
        experiments: null,
      }),
    ).rejects.toMatchObject({ status: 404 });
    store.documents.set('testers/alice', { active: false });
    await expect(publish(0)).rejects.toMatchObject({ status: 403 });
    store.documents.set('testers/alice', { active: true });
    store.documents.get(`audits/${audit.id}`)!.deletionRequestedAt =
      '2026-10-28T00:00:00Z';
    await expect(publish(0)).rejects.toMatchObject({ status: 404 });
  });
});
