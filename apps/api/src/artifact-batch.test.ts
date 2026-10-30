import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY } from '@siphon/contracts';
import {
  ArtifactDownloadService,
  type DownloadObjectStore,
} from './artifact-download.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { AuditCommands } from './audit-commands.js';
import { TestDocuments } from '../test/document-store.js';
import { sha256 } from './hashing.js';

async function setup(count = 2) {
  const store = new TestDocuments();
  const now = new Date('2026-10-29T00:00:00Z');
  const clock = () => now;
  store.documents.set('testers/alice', { active: true });
  const { audit } = await new FirestoreAuditRepository(store, clock).create(
    'alice',
    {
      schemaVersion: '1.0',
      title: 'Private batch',
      domain: 'heat_diffusion',
    },
    'create',
  );
  const revisionPath = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
  const revision = store.documents.get(revisionPath)!;
  Object.assign(revision, { stage: 'inspecting', status: 'running' });
  const fence = {
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    generation: 0,
    inputDigest: revision.inputDigest,
  };
  const files = await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const artifactId = crypto.randomUUID();
      const source = `# authored fixture ${index}\nx = ${index}\n`;
      const bytes = new TextEncoder().encode(source);
      const key = `audits/alice/${audit.id}/artifacts/${artifactId}/content`;
      const path = `audits/${audit.id}/artifacts/${artifactId}`;
      const digest = await sha256(source);
      store.documents.set(path, {
        ownerUid: 'alice',
        auditId: audit.id,
        revisionId: audit.currentRevisionId,
        lifecycle: 'ready',
        expiresAt: '2026-10-30T00:00:00Z',
        bytes: bytes.length,
        sha256: digest,
        objectKey: key,
      });
      return { artifactId, bytes, key, path, sha256: digest };
    }),
  );
  store.documents.set('configuration/r2_class_b_period', {
    counterKey: 'batch_class_b',
    startsAt: '2026-10-01T00:00:00Z',
    endsAt: '2026-11-01T00:00:00Z',
  });
  store.documents.set('budgets/batch_class_b', {
    schemaVersion: '1.0',
    limit: 100,
    spent: 0,
    reserved: 0,
    halted: false,
  });
  const objects = {
    get: vi.fn<DownloadObjectStore['get']>(async (key) => {
      const file = files.find((entry) => entry.key === key);
      if (!file) throw new Error('Unexpected authored fixture key');
      return {
        size: file.bytes.length,
        sha256: file.sha256,
        body: new Response(file.bytes).body!,
      };
    }),
  };
  const service = new ArtifactDownloadService(store, objects, clock);
  const ids = files.map((file) => file.artifactId);
  const read = (signal?: AbortSignal) =>
    service.readBatch('alice', fence, ids, DEFAULT_POLICY.sourceBytes, signal);
  const journals = () =>
    [...store.documents.values()].filter(
      (value) => value.kind === 'artifact_get_batch',
    );
  return {
    store,
    now,
    audit,
    revisionPath,
    fence,
    files,
    ids,
    objects,
    service,
    read,
    journals,
  };
}

describe('private bounded artifact batch handoff', () => {
  it('verifies all ten files, preserves requested identity/order and charges every attempt once', async () => {
    const f = await setup(10);
    const files = await f.read();
    expect(files).toEqual(
      f.files.map((file) => ({
        artifactId: file.artifactId,
        bytes: file.bytes,
        sha256: file.sha256,
      })),
    );
    expect(f.objects.get).toHaveBeenCalledTimes(10);
    expect(f.store.documents.get('budgets/batch_class_b')).toMatchObject({
      spent: 10,
      reserved: 0,
    });
    expect(f.journals()).toHaveLength(1);
    expect(f.journals()[0]).toMatchObject({
      outcome: 'opened',
      generation: 0,
      totalBytes: f.files.reduce((sum, file) => sum + file.bytes.length, 0),
    });
    await f.read();
    expect(f.objects.get).toHaveBeenCalledTimes(20);
    expect(f.store.documents.get('budgets/batch_class_b')?.spent).toBe(20);
  });
  it.each([
    'empty',
    'duplicate',
    'excess_count',
    'bad_id',
    'excess_bytes',
    'zero_bytes',
  ])(
    'rejects %s arguments before database/accounting/provider work',
    async (mode) => {
      const f = await setup();
      const tx = vi.spyOn(f.store, 'transaction');
      const ids =
        mode === 'empty'
          ? []
          : mode === 'duplicate'
            ? [f.ids[0]!, f.ids[0]!]
            : mode === 'excess_count'
              ? Array.from({ length: 11 }, () => crypto.randomUUID())
              : mode === 'bad_id'
                ? ['../private']
                : f.ids;
      await expect(
        f.service.readBatch(
          'alice',
          f.fence,
          ids,
          mode === 'excess_bytes'
            ? DEFAULT_POLICY.uploadBytes + 1
            : mode === 'zero_bytes'
              ? 0
              : DEFAULT_POLICY.sourceBytes,
        ),
      ).rejects.toThrow();
      expect(tx).not.toHaveBeenCalled();
      expect(f.objects.get).not.toHaveBeenCalled();
      expect(f.journals()).toHaveLength(0);
    },
  );
  it.each([
    'owner',
    'expired',
    'not_ready',
    'object_key',
    'stale',
    'budget',
    'period',
    'policy_count',
    'byte_bound',
    'old_policy',
  ])('denies %s before any storage attempt or read charge', async (mode) => {
    const f = await setup();
    const artifact = f.store.documents.get(f.files[0]!.path)!;
    const revision = f.store.documents.get(f.revisionPath)!;
    if (mode === 'owner') artifact.ownerUid = 'bob';
    if (mode === 'expired') artifact.expiresAt = '2026-10-28T00:00:00Z';
    if (mode === 'not_ready') artifact.lifecycle = 'pending';
    if (mode === 'object_key') artifact.objectKey = f.files[1]!.key;
    if (mode === 'stale') revision.generation = 1;
    if (mode === 'budget')
      f.store.documents.get('budgets/batch_class_b')!.limit = 1;
    if (mode === 'period')
      f.store.documents.get('configuration/r2_class_b_period')!.endsAt =
        f.now.toISOString();
    if (mode === 'policy_count')
      revision.policy = {
        ...(revision.policy as Record<string, unknown>),
        uploadFiles: 1,
      };
    if (mode === 'byte_bound') artifact.bytes = DEFAULT_POLICY.sourceBytes;
    if (mode === 'old_policy') {
      const oldId = crypto.randomUUID();
      f.store.documents.set(`audits/${f.audit.id}/revisions/${oldId}`, {
        ...revision,
        revisionId: oldId,
        policy: {
          ...(revision.policy as Record<string, unknown>),
          monthlyClassB: 1,
        },
      });
      artifact.revisionId = oldId;
    }
    await expect(f.read()).rejects.toThrow();
    expect(f.objects.get).not.toHaveBeenCalled();
    expect(f.store.documents.get('budgets/batch_class_b')?.spent).toBe(0);
    expect(f.journals()).toHaveLength(0);
  });
  it.each([
    'cancel',
    'delete',
    'revoke',
    'metadata',
    'original_revision',
    'policy',
  ])(
    'discards the complete batch after %s during retrieval and retains read charges',
    async (mode) => {
      const f = await setup();
      const original = f.objects.get.getMockImplementation()!;
      let changed = false;
      f.objects.get.mockImplementation(async (key, signal) => {
        if (!changed) {
          changed = true;
          if (mode === 'cancel')
            await new AuditCommands(f.store, () => f.now).cancel(
              'alice',
              f.audit.id,
              f.audit.currentRevisionId,
              'cancel',
            );
          if (mode === 'delete')
            f.store.documents.get(`audits/${f.audit.id}`)!.deletionRequestedAt =
              f.now.toISOString();
          if (mode === 'revoke')
            f.store.documents.get('testers/alice')!.active = false;
          if (mode === 'metadata')
            f.store.documents.get(f.files[0]!.path)!.sha256 = 'a'.repeat(64);
          if (mode === 'original_revision')
            f.store.documents.get(f.revisionPath)!.ownerUid = 'bob';
          if (mode === 'policy') {
            const revision = f.store.documents.get(f.revisionPath)!;
            revision.policy = {
              ...(revision.policy as Record<string, unknown>),
              sourceBytes: 1024,
            };
          }
        }
        return original(key, signal);
      });
      await expect(f.read()).rejects.toThrow();
      expect(f.store.documents.get('budgets/batch_class_b')?.spent).toBe(2);
      expect(f.journals()).toHaveLength(1);
      expect(f.journals()[0]?.outcome).toBe('unknown');
    },
  );
  it.each(['bytes', 'length', 'checksum', 'missing', 'provider'])(
    'rejects %s failure without leaking partial bytes, private diagnostics or retrying',
    async (mode) => {
      const f = await setup();
      const file = f.files[0]!;
      f.objects.get.mockImplementationOnce(async () => {
        if (mode === 'provider')
          throw new Error('private provider diagnostic marker');
        if (mode === 'missing') return null;
        return {
          size: file.bytes.length,
          sha256: mode === 'checksum' ? 'b'.repeat(64) : file.sha256,
          body: new Response(
            mode === 'length'
              ? file.bytes.slice(1)
              : mode === 'bytes'
                ? new Uint8Array(file.bytes.length)
                : file.bytes,
          ).body!,
        };
      });
      await expect(f.read()).rejects.not.toThrow(
        'private provider diagnostic marker',
      );
      expect(f.objects.get).toHaveBeenCalledTimes(2);
      expect(f.store.documents.get('budgets/batch_class_b')?.spent).toBe(2);
      expect(f.journals()[0]?.outcome).toBe('unknown');
    },
  );
  it('settles and disposes every sibling stream before reporting a failed batch', async () => {
    const f = await setup();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let siblingEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      siblingEntered = resolve;
    });
    const cancel = vi.fn();
    f.objects.get.mockImplementationOnce(async () => {
      throw new Error('Authored first-file failure');
    });
    f.objects.get.mockImplementationOnce(async () => {
      siblingEntered();
      await wait;
      return {
        size: 999,
        sha256: f.files[1]!.sha256,
        body: new ReadableStream({ cancel }),
      };
    });
    let finished = false;
    const result = f.read().finally(() => {
      finished = true;
    });
    const rejected = expect(result).rejects.toThrow('unavailable');
    await entered;
    expect(finished).toBe(false);
    release();
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('retains the allowance and disposes late streams after caller cancellation', async () => {
    const f = await setup();
    const abort = new AbortController();
    const cancels = [vi.fn(), vi.fn()];
    let index = 0;
    f.objects.get.mockImplementation(async () => {
      const i = index++;
      if (i === 1) abort.abort();
      return {
        size: f.files[i]!.bytes.length,
        sha256: f.files[i]!.sha256,
        body: new ReadableStream<Uint8Array>({ cancel: cancels[i]! }),
      };
    });
    await expect(f.read(abort.signal)).rejects.toThrow();
    expect(cancels.every((cancel) => cancel.mock.calls.length === 1)).toBe(
      true,
    );
    expect(f.store.documents.get('budgets/batch_class_b')?.spent).toBe(2);
    expect(f.journals()[0]?.outcome).toBe('unknown');
  });
  it('serializes competing batch admissions against the last remaining allowance', async () => {
    const f = await setup();
    f.store.documents.get('budgets/batch_class_b')!.limit = 2;
    const results = await Promise.allSettled([f.read(), f.read()]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(f.objects.get).toHaveBeenCalledTimes(2);
    expect(f.store.documents.get('budgets/batch_class_b')?.spent).toBe(2);
    expect(f.journals()).toHaveLength(1);
    expect(f.journals()[0]?.outcome).toBe('opened');
  });
});
