import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';
import {
  createInspectionServices,
  type InspectionWorkflowEnvironment,
} from '../src/inspection-runtime.js';
import {
  runInspectionWorkflow,
  type InspectionWorkflowSteps,
} from '../src/inspection-workflow.js';
import { DispatchFence } from '../src/audit-commands.js';
import { runScientificPhase } from '../src/scientific-workflow.js';
import {
  dispatchWorkflowPhase,
  isScientificWorkflowPhase,
  InspectionPhasePayload,
} from '../src/workflow-phases.js';
export { default } from '../src/worker.js';

/** Native runtime boundary. No public HTTP trigger; the disabled-by-default
 * binding can run only after configuration and operator release gates are met.
 */
export class SiphonInspectionWorkflow extends WorkflowEntrypoint<InspectionWorkflowEnvironment> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    try {
      const services = createInspectionServices(this.env),
        coordinator = services.coordinator;
      const dispatchPhase = (chainId: string, payload: unknown) => {
        if (!this.env.SIPHON_INSPECTION)
          throw new Error('Workflow binding is unavailable');
        return dispatchWorkflowPhase(
          this.env.SIPHON_INSPECTION,
          chainId,
          payload,
        );
      };
      const adapterAndBaselines = async (jobId: string, fence: unknown) => {
        const adapter = await step.do(
          'adapter.propose',
          { retries: { limit: 0, delay: '1 second' }, timeout: '5 minutes' },
          async () => {
            try {
              const result = await services.adapterForJob(jobId, fence);
              return result.status === 'proposal_ready'
                ? {
                    status: result.status,
                    fence: result.fence,
                    operationId: result.operationId,
                    adapterDigest: result.adapterDigest,
                  }
                : result;
            } catch {
              throw new NonRetryableError('adapter_stage_failed');
            }
          },
        );
        if (adapter.status !== 'proposal_ready') return { adapter };
        const original = await step.do(
          'baseline.original',
          { retries: { limit: 0, delay: '1 second' }, timeout: '5 minutes' },
          () => services.baselineForJob(jobId, adapter.fence, 'original'),
        );
        if (original.status !== 'source_stored') return { adapter, original };
        const adapted = await step.do(
          'baseline.adapted',
          { retries: { limit: 0, delay: '1 second' }, timeout: '5 minutes' },
          () => services.baselineForJob(jobId, adapter.fence, 'adapted'),
        );
        if (adapted.status !== 'source_stored')
          return { adapter, original, adapted };
        const originalValidation = await step.do(
          'baseline.validate_original',
          { retries: { limit: 0, delay: '1 second' }, timeout: '5 minutes' },
          () =>
            services.validateBaselineForJob(jobId, adapter.fence, 'original'),
        );
        if (originalValidation.status !== 'validation_published')
          return { adapter, original, adapted, originalValidation };
        const adaptedValidation = await step.do(
          'baseline.validate_adapted',
          { retries: { limit: 0, delay: '1 second' }, timeout: '5 minutes' },
          () =>
            services.validateBaselineForJob(jobId, adapter.fence, 'adapted'),
        );
        if (adaptedValidation.status !== 'validation_published')
          return {
            adapter,
            original,
            adapted,
            originalValidation,
            adaptedValidation,
          };
        const comparison = await step.do(
          'baseline.compare',
          { retries: { limit: 0, delay: '1 second' }, timeout: '5 minutes' },
          () => services.compareBaselinesForJob(jobId, adapter.fence),
        );
        return {
          adapter,
          original,
          adapted,
          originalValidation,
          adaptedValidation,
          comparison,
        };
      };
      const scientific = z
        .strictObject({
          schemaVersion: z.literal('1.0'),
          jobId: z.string().regex(/^[a-f0-9]{64}$/),
          resumeScientific: z.literal(true),
          fence: DispatchFence,
        })
        .safeParse(event.payload);
      if (scientific.success) {
        await dispatchPhase(scientific.data.jobId, {
          schemaVersion: '1.0',
          jobId: scientific.data.jobId,
          phase: 'scientific_evaluate',
          phaseKey: scientific.data.fence.revisionId,
          fence: scientific.data.fence,
        });
        return {
          status: 'phase_dispatched' as const,
          phase: 'scientific_evaluate',
        };
      }
      const phase = InspectionPhasePayload.safeParse(event.payload);
      if (phase.success && isScientificWorkflowPhase(phase.data.phase)) {
        return await runScientificPhase(
          phase.data,
          {
            run: async <T>(name: string, callback: () => Promise<T>) => {
              const checkpoint = await step.do(
                name,
                {
                  retries: { limit: 0, delay: '1 second' },
                  timeout: '5 minutes',
                },
                async () => {
                  try {
                    const encoded = JSON.stringify(await callback());
                    if (encoded === undefined)
                      throw new Error('Invalid checkpoint');
                    return encoded;
                  } catch {
                    throw new NonRetryableError('scientific_stage_unavailable');
                  }
                },
              );
              return JSON.parse(checkpoint) as T;
            },
          },
          services,
          (payload) => dispatchPhase(phase.data.jobId, payload),
        );
      }
      const resume = z
        .strictObject({
          schemaVersion: z.literal('1.0'),
          jobId: z.string().regex(/^[a-f0-9]{64}$/),
          resumeContext: z.literal(true),
        })
        .safeParse(event.payload);
      if (resume.success) {
        const context = await step.do(
          'context.resume',
          { retries: { limit: 0, delay: '1 second' }, timeout: '5 minutes' },
          async () => {
            try {
              return await services.continueContext(resume.data.jobId);
            } catch {
              throw new NonRetryableError('context_stage_failed');
            }
          },
        );
        if (
          context.status === 'continue' ||
          context.status === 'adapter_pending'
        )
          return await adapterAndBaselines(resume.data.jobId, context.fence);
        return context;
      }
      const steps: InspectionWorkflowSteps = {
        do: (name, config, callback) =>
          step.do(name, config, async () => {
            try {
              return await callback();
            } catch {
              throw new NonRetryableError('inspection_step_failed');
            }
          }),
      };
      const inspection = await runInspectionWorkflow(
        event.payload,
        steps,
        coordinator,
      );
      if (
        inspection.status !== 'inspection_complete' ||
        inspection.next === 'unsupported'
      )
        return inspection;
      const context = await step.do(
        'context.review',
        { retries: { limit: 0, delay: '1 second' }, timeout: '5 minutes' },
        async () => {
          try {
            return await services.continueContext(inspection.jobId);
          } catch {
            throw new NonRetryableError('context_stage_failed');
          }
        },
      );
      if (
        context.status === 'continue' ||
        context.status === 'adapter_pending'
      ) {
        const baseline = await adapterAndBaselines(
          inspection.jobId,
          context.fence,
        );
        return { inspection, context, ...baseline };
      }
      return { inspection, context };
    } catch {
      // Workflow dashboards/logs must never retain credential/config/input errors.
      throw new NonRetryableError('inspection_workflow_unavailable');
    }
  }
}
