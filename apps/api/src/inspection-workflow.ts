import { z } from 'zod';
import { Digest, Id, InspectionGate } from '@siphon/contracts';
import { type InspectionCoordinator } from './inspection-coordinator.js';
import { InspectionStageJob } from './run-queue.js';
import { InspectionExecutionReceipt } from './inspection-pipeline.js';

export const InspectionWorkflowPayload = z.strictObject({
  schemaVersion: z.literal('1.0'),
  jobId: Digest,
});
const pointer = { jobId: Digest, operationId: Id };
const BeginCheckpoint = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('prepare'), job: InspectionStageJob }),
  z.strictObject({ action: z.enum(['recover', 'wait', 'failed']), ...pointer }),
]);
const ExecuteCheckpoint = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('already_claimed'), ...pointer }),
  z.strictObject({
    status: z.literal('execution_finished'),
    ...pointer,
    receipt: InspectionExecutionReceipt,
  }),
]);
export const InspectionWorkflowOutcome = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('inspection_complete'),
    ...pointer,
    resultDigest: Digest,
    next: InspectionGate.shape.next,
  }),
  z.strictObject({
    status: z.enum(['awaiting_reconciliation', 'inspection_failed']),
    ...pointer,
  }),
]);
export type InspectionWorkflowCheckpoint = Awaited<
  ReturnType<
    InspectionCoordinator[
      'begin' | 'reserve' | 'execute' | 'cleanup' | 'finish']
  >
>;

export interface InspectionWorkflowSteps {
  do(
    name: string,
    config: {
      retries: { limit: 0; delay: '1 second' };
      timeout: '5 minutes';
    },
    callback: () => Promise<InspectionWorkflowCheckpoint>,
  ): Promise<unknown>;
}

/** Small retry-disabled steps; the provider phase persists only a bounded receipt.
 * This driver is locally testable without importing Cloudflare's runtime. Native
 * binding/deployment and full invocation/CPU verification remain separate gates.
 */
export async function runInspectionWorkflow(
  value: unknown,
  steps: InspectionWorkflowSteps,
  coordinator: Pick<
    InspectionCoordinator,
    'begin' | 'reserve' | 'execute' | 'cleanup' | 'finish'
  >,
) {
  const payload = InspectionWorkflowPayload.parse(value);
  const run = (
    name: string,
    callback: () => Promise<InspectionWorkflowCheckpoint>,
  ) =>
    steps.do(
      name,
      {
        retries: { limit: 0, delay: '1 second' },
        timeout: '5 minutes',
      },
      callback,
    );
  const initial = BeginCheckpoint.parse(
    await run('inspection.begin', () => coordinator.begin(payload.jobId)),
  );
  if (
    initial.action === 'prepare'
      ? initial.job.id !== payload.jobId
      : initial.jobId !== payload.jobId
  )
    throw new Error('Inspection workflow checkpoint identity mismatch');
  const operationId =
    initial.action === 'prepare'
      ? initial.job.operationId
      : initial.operationId;
  if (initial.action === 'wait' || initial.action === 'failed')
    return {
      status:
        initial.action === 'wait'
          ? ('awaiting_reconciliation' as const)
          : ('inspection_failed' as const),
      jobId: payload.jobId,
      operationId: initial.operationId,
    };
  if (initial.action === 'prepare') {
    const prepared = InspectionStageJob.parse(
      await run('inspection.reserve', () => coordinator.reserve(initial.job)),
    );
    if (
      prepared.id !== payload.jobId ||
      prepared.operationId !== initial.job.operationId
    )
      throw new Error('Inspection workflow reservation identity mismatch');
    try {
      const execution = ExecuteCheckpoint.parse(
        await run('inspection.execute', () => coordinator.execute(prepared)),
      );
      if (
        execution.jobId !== payload.jobId ||
        execution.operationId !== prepared.operationId ||
        (execution.status === 'execution_finished' &&
          execution.receipt.operationId !== prepared.operationId)
      )
        throw new Error('Inspection workflow execution identity mismatch');
    } catch {
      // Missing/failed Workflow checkpoint is not proof the operation never ran.
      // Continue only to journal-based cleanup/reconciliation, never re-execute.
    }
  }
  await run('inspection.cleanup', () => coordinator.cleanup(payload.jobId));
  const outcome = InspectionWorkflowOutcome.parse(
    await run('inspection.finish', () => coordinator.finish(payload.jobId)),
  );
  if (outcome.jobId !== payload.jobId || outcome.operationId !== operationId)
    throw new Error('Inspection workflow result identity mismatch');
  return outcome;
}
