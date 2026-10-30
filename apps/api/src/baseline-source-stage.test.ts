import { describe, expect, it } from 'vitest';
import { baselineExecutionFixture as fixture } from '../test/baseline-execution-fixture.js';

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
      status: 'blocked',
      code: 'baseline_execution_requires_reconciliation',
    });
  });
  it('does not dispatch or read uploads without verified source configuration', async () => {
    const f = await fixture();
    f.docs.documents.delete('configuration/source_dispatch');
    f.readBatch.mockClear();
    await expect(f.stage.run('alice', f.fence, 'original')).rejects.toThrow();
    expect(f.creates).not.toHaveBeenCalled();
    expect(f.readBatch).not.toHaveBeenCalled();
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
