import { z } from 'zod';
import {
  AuditStage,
  RunStatus,
  Digest,
  Id,
  SchemaVersion,
  Timestamp,
} from '@siphon/contracts';

export const RevisionState = z
  .strictObject({
    schemaVersion: SchemaVersion,
    auditId: Id,
    revisionId: Id,
    stage: AuditStage,
    status: RunStatus,
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    inputDigest: Digest,
    cancellationRequestedAt: Timestamp.nullable(),
  })
  .superRefine((state, ctx) => {
    const isTerminal = [
      'completed',
      'partial',
      'failed',
      'cancelled',
      'unsupported',
    ].includes(state.status);
    if (isTerminal !== (state.stage === 'finished'))
      ctx.addIssue({
        code: 'custom',
        message: 'Terminal status and finished stage must agree',
      });
    if (state.status === 'idle' && state.stage !== 'draft')
      ctx.addIssue({
        code: 'custom',
        message: 'Idle revision must be a draft',
      });
    if (state.status === 'running' && state.stage === 'draft')
      ctx.addIssue({
        code: 'custom',
        message: 'Running revision must have started inspection',
      });
    if (state.status === 'waiting_for_input' && state.stage !== 'clarifying')
      ctx.addIssue({
        code: 'custom',
        message: 'Waiting revision must be clarifying',
      });
    if (state.status === 'cancelled' && state.cancellationRequestedAt === null)
      ctx.addIssue({
        code: 'custom',
        message: 'Cancelled revision requires a request timestamp',
      });
  });
export type RevisionState = z.infer<typeof RevisionState>;
export type Fence = Pick<
  RevisionState,
  'revisionId' | 'generation' | 'inputDigest'
>;

const terminal = new Set<RunStatus>([
  'completed',
  'partial',
  'failed',
  'cancelled',
  'unsupported',
]);
const successors: Record<AuditStage, readonly AuditStage[]> = {
  draft: ['inspecting'],
  inspecting: ['clarifying', 'adapting'],
  clarifying: ['inspecting', 'adapting'],
  adapting: ['clarifying', 'planning'],
  planning: ['clarifying', 'executing', 'investigating'],
  executing: ['evaluating'],
  evaluating: ['investigating'],
  investigating: ['reporting'],
  reporting: [],
  finished: [],
};

export class StateConflict extends Error {
  readonly code = 'state_conflict';
}

export function assertFence(current: RevisionState, expected: Fence): void {
  if (
    current.revisionId !== expected.revisionId ||
    current.generation !== expected.generation ||
    current.inputDigest !== expected.inputDigest
  )
    throw new StateConflict('Stale revision or operation');
}

export type Transition =
  | { kind: 'queue' }
  | { kind: 'start' }
  | { kind: 'advance'; stage: AuditStage; reason: string }
  | { kind: 'wait'; reason: string }
  | {
      kind: 'finish';
      status: 'completed' | 'partial' | 'failed' | 'unsupported';
      hasEvidence: boolean;
      narrativeComplete: boolean;
      pdfComplete: boolean;
    }
  | { kind: 'cancel'; requestedAt: string };

/** Pure transition calculation; caller must persist with a transactional fencing precondition. */
export function transition(
  value: RevisionState,
  fence: Fence,
  event: Transition,
): RevisionState {
  const current = RevisionState.parse(value);
  assertFence(current, fence);
  if (terminal.has(current.status))
    throw new StateConflict('Revision is terminal');
  if (current.cancellationRequestedAt !== null && event.kind !== 'cancel')
    throw new StateConflict('Cancellation is pending');
  let stage = current.stage;
  let status = current.status;
  let cancellationRequestedAt = current.cancellationRequestedAt;
  switch (event.kind) {
    case 'queue':
      if (!['idle', 'waiting_for_input'].includes(status))
        throw new StateConflict('Cannot queue this revision');
      status = 'queued';
      break;
    case 'start':
      if (status !== 'queued')
        throw new StateConflict('Revision was not queued');
      status = 'running';
      if (stage === 'draft') stage = 'inspecting';
      break;
    case 'advance':
      if (
        status !== 'running' ||
        !successors[stage].includes(event.stage) ||
        !event.reason.trim()
      )
        throw new StateConflict('Illegal stage advance');
      stage = event.stage;
      break;
    case 'wait':
      if (
        status !== 'running' ||
        !['inspecting', 'clarifying', 'adapting', 'planning'].includes(stage) ||
        !event.reason.trim()
      )
        throw new StateConflict('Cannot request input here');
      stage = 'clarifying';
      status = 'waiting_for_input';
      break;
    case 'finish':
      if (status !== 'running')
        throw new StateConflict('Only running work can finish');
      if (
        event.status === 'completed' &&
        (stage !== 'reporting' ||
          !event.hasEvidence ||
          !event.narrativeComplete ||
          !event.pdfComplete)
      )
        throw new StateConflict('Complete report evidence is missing');
      if (event.status === 'partial' && !event.hasEvidence)
        throw new StateConflict('Partial requires useful evidence');
      if (event.status === 'failed' && event.hasEvidence)
        throw new StateConflict('Useful evidence must be preserved as partial');
      status = event.status;
      stage = 'finished';
      break;
    case 'cancel':
      cancellationRequestedAt = Timestamp.parse(event.requestedAt);
      status = 'cancelled';
      stage = 'finished';
      break;
  }
  return RevisionState.parse({
    ...current,
    stage,
    status,
    cancellationRequestedAt,
    generation: current.generation + 1,
  });
}
