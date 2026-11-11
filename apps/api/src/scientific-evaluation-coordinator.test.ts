import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { ScientificEvaluationCoordinator } from './scientific-evaluation-coordinator.js';
import { ScientificEvaluationStage } from './scientific-evaluation-stage.js';

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const docs = new TestDocuments();
  docs.documents.set('testers/alice', { active: true });
  const { audit } = await new FirestoreAuditRepository(docs).create(
    'alice',
    {
      schemaVersion: '1.0',
      title: 'Authored evaluation',
      domain: 'orbital_dynamics',
    },
    'fixture',
  );
  const base = `audits/${audit.id}/revisions/${audit.currentRevisionId}`,
    revision = docs.documents.get(base)!;
  Object.assign(revision, {
    stage: 'evaluating',
    status: 'running',
    generation: 3,
  });
  const fence = {
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest: String(revision.inputDigest),
    generation: 3,
  };
  const operationId = crypto.randomUUID(),
    now = '2026-11-10T18:00:00.000Z';
  docs.documents.set(`scientificBudgetStages/${fence.revisionId}`, {
    ownerUid: 'alice',
    ...fence,
    operationId,
  });
  docs.documents.set(`operations/${operationId}`, {
    schemaVersion: '1.0',
    id: operationId,
    ownerUid: 'alice',
    auditId: fence.auditId,
    revisionId: fence.revisionId,
    inputDigest: fence.inputDigest,
    fence: fence.generation,
    requestDigest: 'a'.repeat(64),
    outcome: 'reserved',
    usage: null,
    providerHandle: null,
    charges: [
      {
        counterKey: 'fixture',
        unit: 'seconds',
        amount: 1,
        consumeOnDispatch: false,
      },
    ],
    createdAt: now,
    updatedAt: now,
  });
  const pipeline = {
    run: vi.fn(async () => ({
      status: 'published' as const,
      reportDigest: 'b'.repeat(64),
      replayed: false,
    })),
    recover: vi.fn(async () => ({
      status: 'published' as const,
      reportDigest: 'b'.repeat(64),
      replayed: true,
    })),
  };
  const prepare = vi
    .spyOn(ScientificEvaluationStage.prototype, 'prepare')
    .mockResolvedValue({ sandbox: {}, request: {} } as never);
  return {
    docs,
    fence,
    operationId,
    base,
    pipeline,
    prepare,
    coordinator: new ScientificEvaluationCoordinator(docs, pipeline),
  };
}
describe('scientific evaluation orchestration', () => {
  it('dispatches a prepared request once and does not repeat an unknown outcome', async () => {
    const f = await fixture();
    expect(await f.coordinator.run('alice', f.fence)).toMatchObject({
      status: 'published',
      operationId: f.operationId,
    });
    expect(f.pipeline.run).toHaveBeenCalledOnce();
    f.docs.documents.get(`operations/${f.operationId}`)!.outcome =
      'dispatching';
    expect(await f.coordinator.run('alice', f.fence)).toMatchObject({
      status: 'blocked',
      code: 'scientific_evaluation_requires_reconciliation',
    });
    expect(f.pipeline.run).toHaveBeenCalledOnce();
    f.docs.documents.set(`conservationCandidates/${f.operationId}`, {
      test: 'authored',
    });
    expect(await f.coordinator.run('alice', f.fence)).toMatchObject({
      status: 'published',
      replayed: true,
    });
    expect(f.pipeline.recover).toHaveBeenCalledWith(f.operationId);
    await expect(f.coordinator.run('bob', f.fence)).rejects.toThrow();
  });
});
