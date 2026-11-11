import { describe, expect, it, vi } from 'vitest';
import {
  runScientificPhase,
  runScientificWorkflow,
} from './scientific-workflow.js';

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
    scientificInvestigateForJob: vi.fn(async () => ({
      status: 'reviewed',
      fence,
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
      'scientific.investigate',
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
  it.each(['awaiting_review', 'blocked'])(
    'stops for investigation %s without publishing a report',
    async (status) => {
      const f = fixture();
      f.services.scientificInvestigateForJob.mockResolvedValueOnce({
        status,
        fence: f.fence,
      });
      expect(await f.run()).toMatchObject({ status });
      expect(f.calls).toEqual([
        'scientific.evaluate',
        'scientific.investigate',
      ]);
      expect(f.services.scientificReportForJob).not.toHaveBeenCalled();
      expect(f.services.scientificPdfForJob).not.toHaveBeenCalled();
    },
  );
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

describe('scientific child phase chain', () => {
  const phaseSteps = {
    async run<T>(_name: string, callback: () => Promise<T>) {
      return callback();
    },
  };
  const payload = (
    phase:
      | 'scientific_evaluate'
      | 'scientific_investigate'
      | 'report'
      | 'pdf'
      | 'finish',
    fence: ReturnType<typeof fixture>['fence'],
    operationId?: string,
  ) => ({
    schemaVersion: '1.0' as const,
    jobId: 'a'.repeat(64),
    phase,
    phaseKey: operationId ?? fence.revisionId,
    fence,
    ...(operationId ? { operationId } : {}),
  });

  it('dispatches evaluation output to a separate investigation instance', async () => {
    const f = fixture(),
      dispatched: unknown[] = [];
    const operationId = crypto.randomUUID();
    f.services.scientificEvaluateForJob.mockResolvedValueOnce({
      status: 'published',
      fence: f.fence,
      operationId,
    } as never);
    const result = await runScientificPhase(
      payload('scientific_evaluate', f.fence),
      phaseSteps,
      f.services as never,
      async (next) => void dispatched.push(next),
    );
    expect(result).toMatchObject({ phase: 'scientific_investigate' });
    expect(dispatched).toEqual([
      expect.objectContaining({
        phase: 'scientific_investigate',
        phaseKey: operationId,
        operationId,
        fence: f.fence,
      }),
    ]);
  });

  it('leaves an unreviewed investigation waiting without dispatching report', async () => {
    const f = fixture(),
      dispatch = vi.fn();
    f.services.scientificInvestigateForJob.mockResolvedValueOnce({
      status: 'awaiting_review',
      fence: f.fence,
      operationId: crypto.randomUUID(),
    } as never);
    const result = await runScientificPhase(
      payload('scientific_investigate', f.fence, crypto.randomUUID()),
      phaseSteps,
      f.services as never,
      dispatch,
    );
    expect(result).toMatchObject({ status: 'awaiting_review' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('chains report to PDF and PDF to finish in separate instances', async () => {
    const f = fixture(),
      dispatched: unknown[] = [];
    const operationId = crypto.randomUUID();
    const reportResult = await runScientificPhase(
      payload('report', f.fence, operationId),
      phaseSteps,
      f.services as never,
      async (next) => void dispatched.push(next),
    );
    expect(reportResult).toMatchObject({ phase: 'pdf' });
    expect(dispatched[0]).toMatchObject({
      phase: 'pdf',
      operationId,
      fence: f.reportFence,
    });

    const pdfOperationId = crypto.randomUUID();
    f.services.scientificPdfForJob.mockResolvedValueOnce({
      status: 'published',
      fence: f.reportFence,
      operationId: pdfOperationId,
    } as never);
    const finishResult = await runScientificPhase(
      payload('pdf', f.reportFence, operationId),
      phaseSteps,
      f.services as never,
      async (next) => void dispatched.push(next),
    );
    expect(finishResult).toMatchObject({ phase: 'finish' });
    expect(dispatched[1]).toMatchObject({
      phase: 'finish',
      operationId: pdfOperationId,
      fence: f.reportFence,
    });
  });
});
