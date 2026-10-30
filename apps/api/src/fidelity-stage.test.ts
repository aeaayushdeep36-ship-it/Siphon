import { describe, expect, it, vi } from 'vitest';
import { fidelityExecutionFixture } from '../test/fidelity-execution-fixture.js';
import { FidelityStage } from './fidelity-stage.js';

async function fixture() {
  const f = await fidelityExecutionFixture(),
    templateEvidenceId = crypto.randomUUID(),
    now = f.clock().toISOString();
  f.docs.documents.set('configuration/evaluation_dispatch', {
    templateEvidenceId,
    lifetimeSeconds: 60,
  });
  f.docs.documents.set(`sandboxTemplates/${templateEvidenceId}`, {
    schemaVersion: '1.0',
    id: templateEvidenceId,
    templateId: 'authored-evaluator',
    role: 'evaluation',
    imageDigest: 'c'.repeat(64),
    runtimeDigest: 'd'.repeat(64),
    verifiedAt: now,
    expiresAt: '2026-10-31T00:00:00Z',
    networkIsolationVerified: true,
    privateAccessVerified: true,
    resourceLimitsVerified: true,
    immutableTemplateVerified: true,
    microUsdPerSecondCeiling: 10,
  });
  for (const [kind, request] of [
    ['original', f.request.original],
    ['adapted', f.request.adapted],
  ] as const)
    f.docs.documents.set(
      `baselineValidationStages/${f.fence.revisionId}_${kind}`,
      {
        ownerUid: 'alice',
        auditId: f.fence.auditId,
        revisionId: f.fence.revisionId,
        inputDigest: f.fence.inputDigest,
        generation: f.fence.generation,
        sourceOperationId: request.sourceOperationId,
        operationId: request.evaluationOperationId,
      },
    );
  const pipeline = {
    run: vi.fn(async () => ({
      status: 'published' as const,
      resultDigest: 'a'.repeat(64),
      replayed: false,
    })),
    recover: vi.fn(async () => ({
      status: 'published' as const,
      resultDigest: 'a'.repeat(64),
      replayed: true,
    })),
  };
  return {
    ...f,
    pipeline,
    stage: new FidelityStage(f.docs, f.jobs, pipeline, f.clock),
  };
}
describe('comparison stage admission', () => {
  it('reserves a distinct evaluation operation for both published validations', async () => {
    const f = await fixture(),
      result = await f.stage.run('alice', f.fence);
    expect(result.status).toBe('published');
    expect(result.operationId).not.toBe(
      f.request.original.evaluationOperationId,
    );
    expect(result.operationId).not.toBe(
      f.request.adapted.evaluationOperationId,
    );
    expect(
      f.docs.documents.get(`sandboxJobs/${result.operationId}`),
    ).toMatchObject({ request: { role: 'evaluation' } });
    expect(f.pipeline.run).toHaveBeenCalledOnce();
  });
  it('rejects changed validation ownership before reserving or starting an evaluator', async () => {
    const f = await fixture();
    f.docs.documents.get(
      `${f.base}/numericValidations/${f.request.adapted.evaluationOperationId}`,
    )!.ownerUid = 'bob';
    await expect(f.stage.run('alice', f.fence)).rejects.toThrow(
      'Published baseline validation',
    );
    expect(f.pipeline.run).not.toHaveBeenCalled();
    expect(f.docs.documents.has(`fidelityStages/${f.fence.revisionId}`)).toBe(
      false,
    );
  });
  it('does not repeat a dispatch whose outcome is unknown', async () => {
    const f = await fixture();
    f.pipeline.run.mockRejectedValueOnce(new Error('authored timeout'));
    await expect(f.stage.run('alice', f.fence)).rejects.toThrow();
    const saved = f.docs.documents.get(`fidelityStages/${f.fence.revisionId}`)!;
    f.docs.documents.get(`operations/${saved.operationId}`)!.outcome =
      'unknown';
    expect(await f.stage.run('alice', f.fence)).toMatchObject({
      status: 'blocked',
      code: 'comparison_requires_reconciliation',
    });
    expect(f.pipeline.run).toHaveBeenCalledOnce();
  });
});
