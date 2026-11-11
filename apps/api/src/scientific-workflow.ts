import type { createInspectionServices } from './inspection-runtime.js';
import type { DispatchFence } from './audit-commands.js';
import type { z } from 'zod';
import {
  type InspectionPhasePayload,
  InspectionPhasePayload as PhasePayload,
} from './workflow-phases.js';

type Services = Pick<
  ReturnType<typeof createInspectionServices>,
  | 'scientificEvaluateForJob'
  | 'scientificInvestigateForJob'
  | 'scientificReportForJob'
  | 'scientificPdfForJob'
  | 'scientificFinishForJob'
>;
type Fence = z.infer<typeof DispatchFence>;
type PhaseServices = Services;

/** Execute exactly one persisted scientific stage, then start the next instance.
 * Only IDs and the current fence cross the Workflow event boundary. */
export async function runScientificPhase(
  value: unknown,
  steps: ScientificWorkflowSteps,
  services: PhaseServices,
  dispatch: (payload: InspectionPhasePayload) => Promise<unknown>,
) {
  const phase = PhasePayload.parse(value);
  const fence = phase.fence;
  if (!fence) throw new Error('Scientific phase requires a revision fence');
  const common = {
    schemaVersion: '1.0' as const,
    jobId: phase.jobId,
  };
  if (phase.phase === 'scientific_evaluate') {
    const evaluation = await steps.run('scientific.evaluate', () =>
      services.scientificEvaluateForJob(phase.jobId, fence),
    );
    if (evaluation.status !== 'published') return evaluation;
    await dispatch({
      ...common,
      phase: 'scientific_investigate',
      phaseKey: evaluation.operationId,
      fence: evaluation.fence,
      operationId: evaluation.operationId,
    });
    return {
      status: 'phase_dispatched' as const,
      phase: 'scientific_investigate',
    };
  }
  if (phase.phase === 'scientific_investigate') {
    const operationId = phase.operationId;
    if (!operationId) throw new Error('Investigation operation is required');
    const investigation = await steps.run('scientific.investigate', () =>
      services.scientificInvestigateForJob(phase.jobId, fence, operationId),
    );
    if (investigation.status !== 'reviewed') return investigation;
    await dispatch({
      ...common,
      phase: 'report',
      phaseKey: operationId,
      fence: investigation.fence,
      operationId,
    });
    return { status: 'phase_dispatched' as const, phase: 'report' };
  }
  if (phase.phase === 'report') {
    const operationId = phase.operationId;
    if (!operationId) throw new Error('Report operation is required');
    const report = await steps.run('scientific.report', () =>
      services.scientificReportForJob(phase.jobId, fence, operationId),
    );
    await dispatch({
      ...common,
      phase: 'pdf',
      phaseKey: operationId,
      fence: report.fence,
      operationId,
    });
    return { status: 'phase_dispatched' as const, phase: 'pdf' };
  }
  if (phase.phase === 'pdf') {
    const pdf = await steps.run('scientific.pdf', () =>
      services.scientificPdfForJob(phase.jobId, fence),
    );
    if (pdf.status !== 'published') return pdf;
    await dispatch({
      ...common,
      phase: 'finish',
      phaseKey: pdf.operationId,
      fence: pdf.fence,
      operationId: pdf.operationId,
    });
    return { status: 'phase_dispatched' as const, phase: 'finish' };
  }
  if (phase.phase === 'finish') {
    if (!phase.operationId) throw new Error('PDF operation is required');
    return steps.run('scientific.finish', () =>
      services.scientificFinishForJob(phase.jobId, fence, phase.operationId),
    );
  }
  throw new Error('Unsupported scientific Workflow phase');
}
export interface ScientificWorkflowSteps {
  run<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/** Checkpoint each stage separately; each stage revalidates durable provenance. */
export async function runScientificWorkflow(
  jobId: string,
  fence: Fence,
  steps: ScientificWorkflowSteps,
  services: Services,
) {
  const evaluation = await steps.run('scientific.evaluate', () =>
    services.scientificEvaluateForJob(jobId, fence),
  );
  if (evaluation.status !== 'published') return evaluation;
  const investigation = await steps.run('scientific.investigate', () =>
    services.scientificInvestigateForJob(
      jobId,
      evaluation.fence,
      evaluation.operationId,
    ),
  );
  if (
    investigation.status === 'blocked' ||
    investigation.status === 'awaiting_review'
  )
    return investigation;
  const report = await steps.run('scientific.report', () =>
    services.scientificReportForJob(
      jobId,
      investigation.fence,
      evaluation.operationId,
    ),
  );
  const pdf = await steps.run('scientific.pdf', () =>
    services.scientificPdfForJob(jobId, report.fence),
  );
  if (pdf.status !== 'published') return { report, pdf };
  return steps.run('scientific.finish', () =>
    services.scientificFinishForJob(jobId, pdf.fence, pdf.operationId),
  );
}
