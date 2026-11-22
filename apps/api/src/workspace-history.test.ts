import { describe, expect, it, vi } from 'vitest';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { WorkspaceRepository } from './workspace.js';
import { HistoryRepository } from './history.js';
import { FirestoreClient, encodeValue } from './firestore.js';
import { RunService, ResumeService } from './runs.js';
async function fixture() {
  const docs = new TestDocuments();
  docs.documents.set('testers/alice', { active: true });
  docs.documents.set('testers/bob', { active: true });
  const { audit } = await new FirestoreAuditRepository(docs).create(
    'alice',
    {
      schemaVersion: '1.0',
      title: 'Authored private history',
      domain: 'heat_diffusion',
    },
    'create',
  );
  return { docs, audit };
}
describe('connected private workspace and history reads', () => {
  it('exposes only explicit draft fields and rejects a foreign owner or revoked invitation', async () => {
    const f = await fixture(),
      repository = new WorkspaceRepository(f.docs);
    const result = await repository.get(
      'alice',
      f.audit.id,
      f.audit.currentRevisionId,
    );
    expect(result).toMatchObject({
      stage: 'draft',
      status: 'idle',
      uploads: [],
      readiness: null,
      context: null,
      plan: null,
      operationalIssues: [],
    });
    expect('policy' in result).toBe(false);
    expect('slotLeaseId' in result).toBe(false);
    await expect(
      repository.get('bob', f.audit.id, f.audit.currentRevisionId),
    ).rejects.toThrow();
    f.docs.documents.get('testers/alice')!.active = false;
    await expect(
      repository.get('alice', f.audit.id, f.audit.currentRevisionId),
    ).rejects.toThrow();
  });
  it('does not open a write transaction on read-only get', async () => {
    const f = await fixture(),
      repository = new WorkspaceRepository(f.docs);
    const transactionSpy = vi.spyOn(f.docs, 'transaction');
    const result = await repository.get(
      'alice',
      f.audit.id,
      f.audit.currentRevisionId,
    );
    expect(result.stage).toBe('draft');
    expect(transactionSpy).not.toHaveBeenCalled();
    transactionSpy.mockRestore();
  });
  it('keeps missing or changed artifacts from being displayed as a ready upload', async () => {
    const f = await fixture(),
      artifactId = crypto.randomUUID(),
      revision = f.docs.documents.get(
        `audits/${f.audit.id}/revisions/${f.audit.currentRevisionId}`,
      )!;
    revision.sourceManifest = [
      {
        schemaVersion: '1.0',
        artifactId,
        path: 'authored.py',
        bytes: 4,
        sha256: 'a'.repeat(64),
      },
    ];
    const repository = new WorkspaceRepository(f.docs);
    expect(
      (await repository.get('alice', f.audit.id, f.audit.currentRevisionId))
        .uploadStates[0]!.lifecycle,
    ).toBe('missing');
    f.docs.documents.set(`audits/${f.audit.id}/artifacts/${artifactId}`, {
      ownerUid: 'bob',
      auditId: f.audit.id,
      artifactId,
      bytes: 4,
      sha256: 'a'.repeat(64),
      lifecycle: 'ready',
      expiresAt: '2026-11-01T00:00:00Z',
    });
    await expect(
      repository.get('alice', f.audit.id, f.audit.currentRevisionId),
    ).rejects.toThrow('mismatch');
  });
  it('runs the exact bounded owner query and uses the last visible record for cursor paging', async () => {
    const f = await fixture();
    const second = { ...f.audit, id: crypto.randomUUID() },
      third = { ...f.audit, id: crypto.randomUUID() };
    const bodies: unknown[] = [];
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe(
        'https://firestore.googleapis.com/v1/projects/siphon-test/databases/(default)/documents:runQuery',
      );
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(
        [f.audit, second, third].map((record) => {
          const encoded = encodeValue(record);
          if (!('mapValue' in encoded)) throw new Error('Invalid fixture');
          return {
            document: {
              name: `projects/siphon-test/databases/(default)/documents/audits/${record.id}`,
              fields: encoded.mapValue.fields,
            },
          };
        }),
      );
    });
    const query = new FirestoreClient(
        'siphon-test',
        async () => 'authored-token',
        transport,
      ),
      history = new HistoryRepository(f.docs, query);
    const first = await history.list('alice', null, '2', undefined);
    expect('audits' in first && first.audits.map((item) => item.id)).toEqual([
      f.audit.id,
      second.id,
    ]);
    expect(bodies[0]).toMatchObject({
      structuredQuery: {
        limit: 3,
        where: {
          compositeFilter: {
            op: 'AND',
            filters: [
              {
                fieldFilter: {
                  field: { fieldPath: 'ownerUid' },
                  op: 'EQUAL',
                  value: { stringValue: 'alice' },
                },
              },
              {
                unaryFilter: {
                  field: { fieldPath: 'deletionRequestedAt' },
                  op: 'IS_NULL',
                },
              },
            ],
          },
        },
      },
    });
    await history.list('alice', null, '2', first.nextCursor!);
    expect(bodies[1]).toMatchObject({
      structuredQuery: {
        startAt: {
          before: false,
          values: [
            { timestampValue: second.createdAt },
            {
              referenceValue: `projects/siphon-test/databases/(default)/documents/audits/${second.id}`,
            },
          ],
        },
      },
    });
    await expect(
      history.list('bob', null, '2', first.nextCursor!),
    ).rejects.toThrow('cursor');
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('rejects foreign/malformed query rows and rechecks revocation after the database query', async () => {
    const f = await fixture();
    const query = vi.fn(async () => {
      f.docs.documents.get('testers/alice')!.active = false;
      return [f.audit];
    });
    await expect(
      new HistoryRepository(f.docs, { history: query }).list(
        'alice',
        null,
        undefined,
        undefined,
      ),
    ).rejects.toThrow('invitation');
    const client = new FirestoreClient(
      'siphon-test',
      async () => 'authored',
      async () =>
        Response.json([
          {
            document: {
              name:
                'projects/foreign/databases/(default)/documents/audits/' +
                f.audit.id,
              fields: {},
            },
          },
        ]),
    );
    await expect(client.history('alice', null, 20, null)).rejects.toThrow(
      'identity',
    );
  });
});
describe('durable public run trigger boundary', () => {
  it('resumes only the completed current inspection, preserves a stable continuation ID and denies stale or foreign snapshots', async () => {
    const f = await fixture(),
      revisionPath = `audits/${f.audit.id}/revisions/${f.audit.currentRevisionId}`,
      revision = f.docs.documents.get(revisionPath)!;
    Object.assign(revision, { stage: 'inspecting', status: 'running' });
    const input = {
      schemaVersion: '1.0',
      expectedGeneration: revision.generation,
      expectedInputDigest: revision.inputDigest,
    };
    const { canonicalJson, sha256 } = await import('./hashing.js');
    const jobId = await sha256(
      canonicalJson({
        uid: 'alice',
        auditId: f.audit.id,
        revisionId: f.audit.currentRevisionId,
        inputDigest: revision.inputDigest,
        stage: 'inspection',
      }),
    );
    const operationId = crypto.randomUUID(),
      resultDigest = 'd'.repeat(64);
    const queued = {
      schemaVersion: '1.0',
      jobId,
      auditId: f.audit.id,
      revisionId: f.audit.currentRevisionId,
      inputDigest: revision.inputDigest,
      generation: 0,
      stage: 'draft',
      status: 'queued',
    };
    f.docs.documents.set(`stageJobs/${jobId}`, {
      schemaVersion: '1.0',
      id: jobId,
      ownerUid: 'alice',
      auditId: f.audit.id,
      revisionId: f.audit.currentRevisionId,
      inputDigest: revision.inputDigest,
      generation: 0,
      startDigest: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64),
      receipt: queued,
      operationId,
      sandboxRequest: null,
      leaseId: null,
      status: 'inspection_complete',
      resultDigest,
      createdAt: f.audit.createdAt,
      updatedAt: f.audit.createdAt,
    });
    f.docs.documents.set(`${revisionPath}/inspection/current`, {
      ownerUid: 'alice',
      inputDigest: revision.inputDigest,
      operationId,
      resultDigest,
    });
    const create = vi.fn(async () => ({})),
      binding = {
        create,
        get: vi.fn(async () => ({
          status: async () => ({ status: 'complete' }),
        })),
      },
      service = new ResumeService(f.docs, binding, true);
    expect(
      await service.resume(
        'alice',
        f.audit.id,
        f.audit.currentRevisionId,
        input,
        'same-key',
      ),
    ).toMatchObject({ jobId, status: 'accepted' });
    await service.resume(
      'alice',
      f.audit.id,
      f.audit.currentRevisionId,
      input,
      'same-key',
    );
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
    expect(create.mock.calls[0]).toMatchObject([
      { params: { jobId, resumeContext: true } },
    ]);
    await expect(
      service.resume(
        'bob',
        f.audit.id,
        f.audit.currentRevisionId,
        input,
        'foreign',
      ),
    ).rejects.toThrow();
    await expect(
      service.resume(
        'alice',
        f.audit.id,
        f.audit.currentRevisionId,
        { ...input, expectedGeneration: 99 },
        'stale',
      ),
    ).rejects.toThrow();
    f.docs.documents.get(`stageJobs/${jobId}`)!.status = 'dispatching';
    await expect(
      service.resume(
        'alice',
        f.audit.id,
        f.audit.currentRevisionId,
        input,
        'unfinished',
      ),
    ).rejects.toThrow('completed inspection');
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('keeps one durable ID on ambiguous creation and replays an existing workflow without a new source execution', async () => {
    const auditId = crypto.randomUUID(),
      revisionId = crypto.randomUUID();
    const receipt = {
      schemaVersion: '1.0' as const,
      jobId: 'a'.repeat(64),
      auditId,
      revisionId,
      inputDigest: 'b'.repeat(64),
      generation: 1,
      stage: 'draft' as const,
      status: 'queued' as const,
    };
    const enqueue = vi.fn(async () => ({ receipt, replayed: false })),
      create = vi.fn(async () => {
        throw new Error('private provider marker');
      }),
      get = vi.fn(async () => ({
        status: async () => ({ status: 'running' }),
      }));
    const service = new RunService({ enqueue }, { create, get }, true);
    expect(
      await service.start('alice', auditId, revisionId, {}, 'same-key'),
    ).toEqual({ receipt, replayed: false });
    expect(create).toHaveBeenCalledWith({
      id: `inspection-${receipt.jobId}`,
      params: { schemaVersion: '1.0', jobId: receipt.jobId },
    });
    expect(get).toHaveBeenCalledWith(`inspection-${receipt.jobId}`);
    expect(enqueue).toHaveBeenCalledWith(
      'alice',
      auditId,
      revisionId,
      {},
      'same-key',
    );
  });
  it('does not queue when disabled and reports a queued unknown without looping or exposing diagnostics', async () => {
    const enqueue = vi.fn(async () => ({
      receipt: {
        schemaVersion: '1.0' as const,
        jobId: 'a'.repeat(64),
        auditId: crypto.randomUUID(),
        revisionId: crypto.randomUUID(),
        inputDigest: 'b'.repeat(64),
        generation: 1,
        stage: 'draft' as const,
        status: 'queued' as const,
      },
      replayed: false,
    }));
    await expect(
      new RunService({ enqueue }, undefined, false).start(
        'alice',
        'x',
        'y',
        {},
        'key',
      ),
    ).rejects.toMatchObject({ code: 'audit_execution_unavailable' });
    expect(enqueue).not.toHaveBeenCalled();
    const create = vi.fn(async () => {
        throw new Error('private marker');
      }),
      get = vi.fn(async () => {
        throw new Error('private marker');
      });
    await expect(
      new RunService({ enqueue }, { create, get }, true).start(
        'alice',
        'x',
        'y',
        {},
        'key',
      ),
    ).rejects.toMatchObject({ code: 'workflow_dispatch_unknown', status: 503 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });
  it.each(['errored', 'terminated', 'unrecognized'])(
    'does not claim a %s workflow was accepted after ambiguous creation',
    async (status) => {
      const enqueue = vi.fn(async () => ({
        receipt: {
          schemaVersion: '1.0' as const,
          jobId: 'a'.repeat(64),
          auditId: crypto.randomUUID(),
          revisionId: crypto.randomUUID(),
          inputDigest: 'b'.repeat(64),
          generation: 1,
          stage: 'draft' as const,
          status: 'queued' as const,
        },
        replayed: false,
      }));
      const create = vi.fn(async () => {
        throw new Error('create failed');
      });
      const get = vi.fn(async () => ({ status: async () => ({ status }) }));
      await expect(
        new RunService({ enqueue }, { create, get }, true).start(
          'alice',
          'audit',
          'revision',
          {},
          'key',
        ),
      ).rejects.toMatchObject({
        code:
          status === 'unrecognized'
            ? 'workflow_dispatch_unknown'
            : 'workflow_stopped',
      });
      expect(create).toHaveBeenCalledTimes(1);
    },
  );
});
