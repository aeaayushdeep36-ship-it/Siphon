import { describe, expect, it, vi } from 'vitest';
import { runScientificWorkflow } from './scientific-workflow.js';

function fixture() {
  const fence = {
    auditId: crypto.randomUUID(),
    revisionId: crypto.randomUUID(),
    inputDigest: 'a'.repeat(64),
    generation: 1,
  };
  const reportFence = { ...fence, generation: 3 };
  const calls: string[] = [];
  const steps = {
    async run<T>(name: string, callback: () => Promise<T>) {
      calls.push(name);
      return callback();
    },
  };
  const services = {
    scientificEvaluateForJob: vi.fn(async () => ({
      status: 'published',
      fence,
      operationId: crypto.randomUUID(),
    })),
    scientificReportForJob: vi.fn(async () => ({
      status: 'report_published',
      fence: reportFence,
    })),
    scientificPdfForJob: vi.fn(async () => ({
      status: 'published',
      fence: reportFence,
      operationId: crypto.randomUUID(),
    })),
    scientificFinishForJob: vi.fn(async () => ({ status: 'partial' })),
  };
  const run = () =>
    runScientificWorkflow(
      'fixture',
      fence,
      steps,
      services as unknown as Parameters<typeof runScientificWorkflow>[3],
    );
  return { run, services, calls, fence, reportFence };
}
describe('scientific workflow checkpoints', () => {
  it('runs stages in order and passes the updated revision fence', async () => {
    const f = fixture();
    expect(await f.run()).toEqual({ status: 'partial' });
    expect(f.calls).toEqual([
      'scientific.evaluate',
      'scientific.report',
      'scientific.pdf',
      'scientific.finish',
    ]);
    expect(f.services.scientificPdfForJob).toHaveBeenCalledWith(
      'fixture',
      f.reportFence,
    );
    expect(f.services.scientificFinishForJob).toHaveBeenCalledWith(
      'fixture',
      f.reportFence,
      expect.any(String),
    );
  });
  it('does not run report or PDF after an unresolved evaluation', async () => {
    const f = fixture();
    f.services.scientificEvaluateForJob.mockResolvedValueOnce({
      status: 'blocked',
      fence: f.fence,
    } as never);
    expect(await f.run()).toMatchObject({ status: 'blocked' });
    expect(f.calls).toEqual(['scientific.evaluate']);
  });
  it('preserves the report and stops before finalization when PDF is unresolved', async () => {
    const f = fixture();
    f.services.scientificPdfForJob.mockResolvedValueOnce({
      status: 'blocked',
      fence: f.reportFence,
    } as never);
    expect(await f.run()).toMatchObject({
      report: { status: 'report_published' },
      pdf: { status: 'blocked' },
    });
    expect(f.services.scientificFinishForJob).not.toHaveBeenCalled();
  });
});
