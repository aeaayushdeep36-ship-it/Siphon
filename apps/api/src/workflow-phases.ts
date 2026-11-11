import { z } from 'zod';
import { Digest, Id } from '@siphon/contracts';
import { canonicalJson, sha256 } from './hashing.js';
import { DispatchFence } from './audit-commands.js';

/** Internal phase messages contain identifiers and fencing metadata only.
 * Source text, request bodies, credentials and live SDK handles stay outside
 * Workflow event payloads and checkpoints. */
export const InspectionPhase = z.enum([
  'inspection',
  'context',
  'adapter',
  'baseline_original',
  'baseline_adapted',
  'validate_original',
  'validate_adapted',
  'compare',
  'scientific_evaluate',
  'scientific_investigate',
  'investigation_prepare',
  'investigation_dispatch',
  'investigation_settle',
  'investigation_publish',
  'report',
  'pdf',
  'finish',
]);

export const InspectionPhasePayload = z.strictObject({
  schemaVersion: z.literal('1.0'),
  jobId: Digest,
  phase: InspectionPhase,
  phaseKey: Id,
  fence: DispatchFence.optional(),
  operationId: Id.optional(),
  evaluationId: Id.optional(),
});
export type InspectionPhasePayload = z.infer<typeof InspectionPhasePayload>;

export function isScientificWorkflowPhase(
  value: InspectionPhasePayload['phase'],
) {
  return (
    value === 'scientific_evaluate' ||
    value === 'scientific_investigate' ||
    value === 'report' ||
    value === 'pdf' ||
    value === 'finish'
  );
}

export interface WorkflowPhaseBinding {
  create(options: {
    id: string;
    params: InspectionPhasePayload;
  }): Promise<unknown>;
  get(id: string): Promise<{ status(): Promise<unknown> }>;
}

export class WorkflowDispatchError extends Error {
  constructor(public readonly code: 'unknown' | 'stopped') {
    super(code);
  }
}

const ACCEPTED_STATUSES = new Set([
  'queued',
  'running',
  'paused',
  'waiting',
  'waitingForPause',
  'rollingBack',
  'complete',
]);

export interface WorkflowStatusBinding {
  get(id: string): Promise<{ status(): Promise<unknown> }>;
}

/** Reconcile an ambiguous create response using the deterministic instance ID. */
export async function createOrReconcileWorkflow(
  binding: WorkflowStatusBinding,
  id: string,
  create: () => Promise<unknown>,
) {
  try {
    await create();
    return false as const;
  } catch {
    // The create response may be lost after Cloudflare accepted the instance.
  }
  let observed: unknown;
  try {
    observed = await (await binding.get(id)).status();
  } catch {
    throw new WorkflowDispatchError('unknown');
  }
  const status =
    observed && typeof observed === 'object' && 'status' in observed
      ? observed.status
      : undefined;
  if (status === 'errored' || status === 'terminated')
    throw new WorkflowDispatchError('stopped');
  if (!ACCEPTED_STATUSES.has(typeof status === 'string' ? status : ''))
    throw new WorkflowDispatchError('unknown');
  return true as const;
}

/** Stable ID makes child creation idempotent across parent replay. A status
 * snapshot of `queued` is accepted as dispatch acknowledgement, not completion. */
export async function dispatchWorkflowPhase(
  binding: WorkflowPhaseBinding,
  chainIdValue: unknown,
  payloadValue: unknown,
) {
  const chainId = Digest.parse(chainIdValue);
  const payload = InspectionPhasePayload.parse(payloadValue);
  const id = `phase-${await sha256(
    canonicalJson({
      chainId,
      jobId: payload.jobId,
      phase: payload.phase,
      phaseKey: payload.phaseKey,
    }),
  )}`;
  const reconciled = await createOrReconcileWorkflow(binding, id, () =>
    binding.create({ id, params: payload }),
  );
  return { id, reconciled };
}
