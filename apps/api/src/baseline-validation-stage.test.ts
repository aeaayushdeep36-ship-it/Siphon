import { describe, expect, it, vi } from 'vitest';
import { baselineExecutionFixture } from '../test/baseline-execution-fixture.js';
import { BaselineValidationStage } from './baseline-validation-stage.js';

async function fixture() {
  const f = await baselineExecutionFixture();
  const source = await f.stage.run('alice', f.fence, 'original');
  if (source.status !== 'source_stored')
    throw new Error('Authored source failed');
  const id = crypto.randomUUID();
  f.docs.documents.set('configuration/evaluation_dispatch', {
    templateEvidenceId: id,
    lifetimeSeconds: 60,
  });
  f.docs.documents.set(`sandboxTemplates/${id}`, {
    schemaVersion: '1.0',
    id,
    templateId: 'authored-evaluator',
    role: 'evaluation',
    imageDigest: 'c'.repeat(64),
    runtimeDigest: 'd'.repeat(64),
    verifiedAt: f.clock().toISOString(),
    expiresAt: '2026-10-31T00:00:00.000Z',
    networkIsolationVerified: true,
    privateAccessVerified: true,
    resourceLimitsVerified: true,
    immutableTemplateVerified: true,
    microUsdPerSecondCeiling: 10,
  });
  const pipeline = {
    run: vi.fn(async () => ({
      status: 'published' as const,
      reportDigest: 'a'.repeat(64),
      replayed: false,
    })),
    recover: vi.fn(async () => ({
      status: 'published' as const,
      reportDigest: 'a'.repeat(64),
      replayed: true,
    })),
  };
  return {
    ...f,
    source,
    pipeline,
    validator: new BaselineValidationStage(f.docs, f.jobs, pipeline, f.clock),
  };
}

describe('baseline validation admission', () => {
  it('reserves a distinct evaluation and hands the stored source to the data-only pipeline', async () => {
    const f = await fixture(),
      result = await f.validator.run('alice', f.fence, 'original');
    expect(result.status).toBe('validation_published');
    expect(result.operationId).not.toBe(f.source.operationId);
    expect(f.pipeline.run).toHaveBeenCalledOnce();
    expect(f.pipeline.run).toHaveBeenCalledWith(
      'alice',
      f.source.operationId,
      expect.objectContaining({ role: 'evaluation' }),
      f.fence,
      expect.any(AbortSignal),
    );
    expect(
      f.docs.documents.get(`sandboxJobs/${result.operationId}`),
    ).toMatchObject({
      request: { role: 'evaluation', operationId: result.operationId },
    });
    expect(f.docs.documents.has(`${f.base}/adapters/current`)).toBe(false);
  });
  it('blocks a source belonging to another owner before dispatch', async () => {
    const f = await fixture();
    f.docs.documents.get(
      `baselineStages/${f.fence.revisionId}_original`,
    )!.ownerUid = 'bob';
    await expect(f.validator.run('alice', f.fence, 'original')).rejects.toThrow(
      'stale',
    );
    expect(f.pipeline.run).not.toHaveBeenCalled();
  });
  it('does not repeat a dispatch whose outcome is uncertain', async () => {
    const f = await fixture();
    f.pipeline.run.mockRejectedValueOnce(
      new Error('authored provider failure'),
    );
    await expect(
      f.validator.run('alice', f.fence, 'original'),
    ).rejects.toThrow();
    const stage = f.docs.documents.get(
      `baselineValidationStages/${f.fence.revisionId}_original`,
    )!;
    f.docs.documents.get(`operations/${stage.operationId}`)!.outcome =
      'dispatching';
    expect(await f.validator.run('alice', f.fence, 'original')).toMatchObject({
      status: 'blocked',
      code: 'baseline_validation_requires_reconciliation',
    });
    expect(f.pipeline.run).toHaveBeenCalledOnce();
  });
});
