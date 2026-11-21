import { describe, expect, it } from 'vitest';
import { baselineExecutionFixture as fixture } from '../test/baseline-execution-fixture.js';
import { sha256 } from './hashing.js';

describe('connected baseline source execution', () => {
  it('runs distinct original/adapted VMs through real gates, cleanup and private publication; no numeric or fidelity claim', async () => {
    const f = await fixture(),
      original = await f.stage.run('alice', f.fence, 'original'),
      adapted = await f.stage.run('alice', f.fence, 'adapted');
    expect(original.status).toBe('source_stored');
    expect(adapted.status).toBe('source_stored');
    expect(original.operationId).not.toBe(adapted.operationId);
    expect(f.creates).toHaveBeenCalledTimes(2);
    expect(f.profiles).toEqual(['reference_v1', 'adapter_v1']);
    expect(f.kill).toHaveBeenCalledTimes(2);
    expect(f.putOnce).toHaveBeenCalledTimes(6);
    expect(
      f.docs.documents.get(`sourceOutputPlans/${original.operationId}`),
    ).toMatchObject({ status: 'stored' });
    expect(
      f.docs.documents.get(`sandboxTerminations/${original.operationId}`),
    ).toMatchObject({ outcome: 'killed' });
    expect(
      f.docs.documents.get(`budgets/source_executions_${f.fence.revisionId}`),
    ).toMatchObject({ spent: 2, reserved: 0 });
    expect(f.docs.documents.has(`${f.base}/adapters/current`)).toBe(false);
    expect(await f.stage.run('alice', f.fence, 'original')).toEqual(original);
    expect(f.creates).toHaveBeenCalledTimes(2);
  });
  it('stops unsupported source before VM creation and refunds only undispatched reservations', async () => {
    const f = await fixture('unavailable_dependency');
    expect(await f.stage.run('alice', f.fence, 'original')).toMatchObject({
      status: 'needs_input',
      reasons: [{ code: 'dependency_not_supported' }],
    });
    expect(f.creates).not.toHaveBeenCalled();
    expect(f.putOnce).not.toHaveBeenCalled();
    expect(f.docs.documents.get('budgets/e2b_global_micro_usd')).toMatchObject({
      reserved: 0,
      spent: 0,
    });
    expect(await f.stage.run('alice', f.fence, 'original')).toMatchObject({
      status: 'needs_input',
      reasons: [{ code: 'dependency_not_supported' }],
    });
    expect(f.creates).not.toHaveBeenCalled();
  });
  it('does not dispatch or read uploads without verified source configuration', async () => {
    const f = await fixture();
    f.docs.documents.delete('configuration/source_dispatch');
    f.readBatch.mockClear();
    await expect(f.stage.run('alice', f.fence, 'original')).rejects.toThrow();
    expect(f.creates).not.toHaveBeenCalled();
    expect(f.readBatch).not.toHaveBeenCalled();
  });
  it('reports the numeric runtime gate before requiring template configuration', async () => {
    const f = await fixture();
    const revision = f.docs.documents.get(f.base)!;
    const numericId = crypto.randomUUID();
    revision.sourceManifest = [
      ...(revision.sourceManifest as Array<Record<string, unknown>>),
      {
        schemaVersion: '1.0',
        artifactId: numericId,
        path: 'data.csv',
        bytes: 1,
        sha256: 'a'.repeat(64),
      },
    ];
    f.docs.documents.delete('configuration/source_dispatch');
    f.readBatch.mockClear();
    expect(await f.stage.run('alice', f.fence, 'original')).toMatchObject({
      status: 'needs_input',
      operationId: null,
      reasons: [
        { artifactId: numericId, code: 'numeric_input_validator_required' },
      ],
    });
    expect(f.creates).not.toHaveBeenCalled();
    expect(f.readBatch).not.toHaveBeenCalled();
    expect(
      f.docs.documents.has(`baselineStages/${f.fence.revisionId}_original`),
    ).toBe(false);
  });
  it('requires explicit numeric-validation evidence on a pinned source build', async () => {
    const f = await fixture();
    const revision = f.docs.documents.get(f.base)!;
    revision.sourceManifest = [
      ...(revision.sourceManifest as Array<Record<string, unknown>>),
      {
        schemaVersion: '1.0',
        artifactId: crypto.randomUUID(),
        path: 'data.npy',
        bytes: 1,
        sha256: 'a'.repeat(64),
      },
    ];
    const config = f.docs.documents.get('configuration/source_dispatch')!;
    const evidence = f.docs.documents.get(
      `sandboxTemplates/${config.templateEvidenceId}`,
    )!;
    evidence.numericInputValidation = 'headerless-csv-npy-v1';
    f.readBatch.mockClear();
    expect(await f.stage.run('alice', f.fence, 'original')).toMatchObject({
      status: 'needs_input',
      reasons: [{ code: 'numeric_input_validator_required' }],
    });
    expect(f.readBatch).not.toHaveBeenCalled();
    const pinnedEvidence = f.docs.documents.get(
      `sandboxTemplates/${config.templateEvidenceId}`,
    )!;
    pinnedEvidence.templateBuildId = 'fixture-build';
    pinnedEvidence.templateTag = 'fixture-tag';
    // The fixture downloader intentionally omits the numeric file. Passing the
    // gate must reach byte integrity checks, not proceed with missing data.
    await expect(f.stage.run('alice', f.fence, 'original')).rejects.toThrow(
      'Baseline download differs from manifest',
    );
    expect(f.readBatch).toHaveBeenCalledOnce();
    expect(f.creates).not.toHaveBeenCalled();
  });
  it('passes numeric input through the normal gates when the pinned source build is verified', async () => {
    const f = await fixture();
    const revision = f.docs.documents.get(f.base)!;
    const manifest = revision.sourceManifest as Array<Record<string, unknown>>;
    const originalArtifact = f.docs.documents.get(
      `audits/${f.fence.auditId}/artifacts/${manifest[0]!.artifactId}`,
    )!;
    const numericText = '1\n2\n';
    const data = new TextEncoder().encode(numericText);
    const numeric = {
      schemaVersion: '1.0',
      artifactId: crypto.randomUUID(),
      path: 'data.csv',
      bytes: data.length,
      sha256: await sha256(numericText),
    };
    revision.sourceManifest = [...manifest, numeric];
    f.docs.documents.set(
      `audits/${f.fence.auditId}/artifacts/${numeric.artifactId}`,
      { ...originalArtifact, ...numeric },
    );
    const config = f.docs.documents.get('configuration/source_dispatch')!;
    const evidence = f.docs.documents.get(
      `sandboxTemplates/${config.templateEvidenceId}`,
    )!;
    Object.assign(evidence, {
      templateBuildId: 'fixture-build',
      templateTag: 'fixture-tag',
      numericInputValidation: 'headerless-csv-npy-v1',
    });
    const originalFiles = await f.readBatch();
    f.readBatch.mockResolvedValue([
      ...originalFiles,
      { artifactId: numeric.artifactId, bytes: data, sha256: numeric.sha256 },
    ]);
    expect(await f.stage.run('alice', f.fence, 'original')).toMatchObject({
      status: 'source_stored',
    });
    expect(f.creates).toHaveBeenCalledOnce();
    expect(f.kill).toHaveBeenCalledOnce();
  });
  it('retains uncertain dispatches and never automatically creates a replacement VM', async () => {
    const f = await fixture();
    f.creates.mockRejectedValueOnce(new Error('Authored timeout'));
    await expect(f.stage.run('alice', f.fence, 'original')).rejects.toThrow();
    expect(await f.stage.run('alice', f.fence, 'original')).toMatchObject({
      status: 'blocked',
      code: 'baseline_execution_requires_reconciliation',
    });
    expect(f.creates).toHaveBeenCalledTimes(1);
    expect(f.putOnce).not.toHaveBeenCalled();
    expect(f.docs.documents.get('budgets/e2b_global_micro_usd')).toMatchObject({
      reserved: 600,
      spent: 0,
    });
  });
});
