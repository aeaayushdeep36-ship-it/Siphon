import { describe, expect, it } from 'vitest';
import { SourceExecutions } from './source-executions.js';
import { baselineStageFixture as fixture } from '../test/baseline-stage-fixture.js';

describe('baseline readiness from actual persisted proposal and inspection lineage', () => {
  it('produces the approval consumed by real source binding, without certifying fidelity', async () => {
    const f = await fixture();
    const result = await f.readiness.approve('alice', f.fence, f.request);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Authored readiness failed');
    expect(
      await new SourceExecutions(f.docs, f.clock).bind(
        f.request,
        result.approvalId,
      ),
    ).toMatchObject({ status: 'bound', approvalId: f.request.operationId });
    expect(f.docs.documents.get(`${f.base}/readiness/current`)).toMatchObject({
      scope: 'isolated_baseline_attempt',
    });
    expect(f.docs.documents.has(`${f.base}/adapters/current`)).toBe(false);
    expect(await f.readiness.approve('alice', f.fence, f.request)).toEqual(
      result,
    );
  });
  it('withholds approval for unsupported dependencies', async () => {
    const f = await fixture('unavailable_dependency');
    expect(
      await f.readiness.approve('alice', f.fence, f.request),
    ).toMatchObject({
      status: 'needs_input',
      reasons: [{ code: 'dependency_not_supported', line: 1 }],
    });
    expect(
      f.docs.documents.has(`sourceExecutionApprovals/${f.request.operationId}`),
    ).toBe(false);
  });
  it('withholds approval when retention cannot cover the reserved VM lifetime', async () => {
    const f = await fixture();
    f.docs.documents.get(
      `audits/${f.fence.auditId}/artifacts/${f.request.entryArtifactId}`,
    )!.expiresAt = new Date(f.clock().getTime() + 30_000).toISOString();
    expect(
      await f.readiness.approve('alice', f.fence, f.request),
    ).toMatchObject({
      status: 'needs_input',
      reasons: [{ code: 'input_retention_too_short' }],
    });
  });
  it('rejects altered source bytes before creating any approval', async () => {
    const f = await fixture();
    f.request.files[0]!.dataBase64 = btoa(
      f.source.text.replace('numpy', 'numqy'),
    );
    await expect(
      f.readiness.approve('alice', f.fence, f.request),
    ).rejects.toThrow('immutable source');
    expect(
      f.docs.documents.has(`sourceExecutionApprovals/${f.request.operationId}`),
    ).toBe(false);
  });
  it('rejects mismatched inspection cleanup receipts and expired/foreign provenance', async () => {
    const f = await fixture();
    f.docs.documents.get(
      `sandboxTerminations/${f.inspectionId}`,
    )!.requestDigest = 'c'.repeat(64);
    await expect(
      f.readiness.approve('alice', f.fence, f.request),
    ).rejects.toThrow('provenance');
    f.docs.documents.get(
      `sandboxTerminations/${f.inspectionId}`,
    )!.requestDigest = 'b'.repeat(64);
    f.docs.documents.get(`${f.base}/adapterProposals/current`)!.ownerUid =
      'bob';
    await expect(
      f.readiness.approve('alice', f.fence, f.request),
    ).rejects.toThrow('mismatch');
  });
});
