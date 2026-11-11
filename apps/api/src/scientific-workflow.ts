import type { createInspectionServices } from './inspection-runtime.js';
import type { DispatchFence } from './audit-commands.js';
import type { z } from 'zod';

type Services = Pick<
  ReturnType<typeof createInspectionServices>,
  | 'scientificEvaluateForJob'
  | 'scientificInvestigateForJob'
  | 'scientificReportForJob'
  | 'scientificPdfForJob'
  | 'scientificFinishForJob'
>;
type Fence = z.infer<typeof DispatchFence>;
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
