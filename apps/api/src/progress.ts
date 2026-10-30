import { z } from 'zod';
import {
  ExperimentCounts,
  ProgressActivity,
  ProgressSummary,
  ProgressSnapshot,
  Id,
  ResourcePolicy,
} from '@siphon/contracts';
import { type DocumentStore, type DocumentTransaction } from './firestore.js';
import { authorize, nativeTimestamps, stateFrom } from './audit-commands.js';
import {
  assertFence,
  transition,
  type Fence,
  type Transition,
} from './lifecycle.js';
import { ApiError } from './errors.js';

const messages: Record<z.infer<typeof ProgressActivity>, string> = {
  queued: 'Waiting for execution capacity.',
  inspecting_upload: 'Inspecting uploaded files.',
  reading_context: 'Reading the simulation context.',
  awaiting_answers: 'Waiting for clarification answers.',
  verifying_adapter:
    'Verifying observation extraction against the original simulation.',
  planning_checks: 'Selecting applicable checks.',
  running_experiment: 'Running a planned experiment.',
  evaluating_evidence: 'Computing numerical evidence.',
  investigating_findings: 'Investigating evidence and possible causes.',
  rendering_report: 'Preparing the evidence report.',
  finished: 'Audit work has ended. Review the reported outcome.',
  cancel_requested:
    'Cancellation requested. Execution cleanup may still be pending.',
};

const updateSchema = z.strictObject({
  activity: ProgressActivity,
  experiments: ExperimentCounts.nullable(),
});
export type ProgressUpdate = z.infer<typeof updateSchema>;

function compatible(
  stage: string,
  status: string,
  activity: z.infer<typeof ProgressActivity>,
): boolean {
  if (status === 'cancelled') return activity === 'cancel_requested';
  if (stage === 'finished') return activity === 'finished';
  if (status === 'queued') return activity === 'queued';
  if (status === 'waiting_for_input') return activity === 'awaiting_answers';
  if (status !== 'running') return false;
  const permitted: Record<string, string[]> = {
    inspecting: ['inspecting_upload', 'reading_context'],
    clarifying: ['reading_context'],
    adapting: ['verifying_adapter'],
    planning: ['planning_checks'],
    executing: ['running_experiment'],
    evaluating: ['evaluating_evidence'],
    investigating: ['investigating_findings'],
    reporting: ['rendering_report'],
  };
  return permitted[stage]?.includes(activity) ?? false;
}

/** Call within an existing state transaction before writes, or through the repository below.
 * Fixed activity messages prevent arbitrary sandbox/model stdout entering the public timeline.
 */
export async function persistProgress(
  tx: DocumentTransaction,
  uid: string,
  auditId: string,
  fence: Fence,
  updateValue: ProgressUpdate,
  now: Date,
  stateTransition?: Transition,
): Promise<{ published: boolean; summary: ProgressSummary | null }> {
  const update = updateSchema.parse(updateValue);
  const audit = await authorize(tx, uid, auditId, false);
  const path = `audits/${auditId}/revisions/${fence.revisionId}`;
  const record = await tx.get(path);
  if (!record || record.ownerUid !== uid)
    throw new ApiError(404, 'not_found', 'Revision was not found.');
  const initial = stateFrom(record);
  assertFence(initial, fence);
  const state = stateTransition
    ? transition(initial, fence, stateTransition)
    : initial;
  if (audit.currentRevisionId !== fence.revisionId || state.auditId !== auditId)
    throw new ApiError(
      409,
      'stale_revision',
      'Cannot update progress for a superseded revision.',
    );
  if (!compatible(state.stage, state.status, update.activity))
    throw new ApiError(
      409,
      'invalid_progress',
      'Activity does not match the persisted stage.',
    );
  const policy = ResourcePolicy.parse(record.policy);
  const previous =
    record.progress === undefined
      ? null
      : ProgressSummary.parse(record.progress);
  if (
    previous &&
    (previous.auditId !== auditId || previous.revisionId !== fence.revisionId)
  )
    throw new Error('Progress identity mismatch');
  if (
    previous?.experiments &&
    update.experiments &&
    (update.experiments.planned !== previous.experiments.planned ||
      update.experiments.completed < previous.experiments.completed)
  )
    throw new ApiError(
      409,
      'invalid_progress',
      'Experiment counts cannot regress or change plan within a revision.',
    );
  if (previous?.experiments && !update.experiments)
    throw new ApiError(
      409,
      'invalid_progress',
      'Known experiment counts cannot be discarded.',
    );
  const changedStage =
    !previous ||
    previous.stage !== state.stage ||
    previous.status !== state.status;
  if (previous && !changedStage) {
    if (state.stage === 'finished')
      return { published: false, summary: previous };
    const same =
      previous.activity === update.activity &&
      JSON.stringify(previous.experiments) ===
        JSON.stringify(update.experiments);
    if (
      same ||
      now.getTime() - Date.parse(previous.updatedAt) <
        policy.progressIntervalSeconds * 1000
    )
      return { published: false, summary: previous };
  }
  const count = previous?.eventCount ?? 0;
  const append = count < policy.progressEvents;
  const summary = ProgressSummary.parse({
    schemaVersion: '1.0',
    auditId,
    revisionId: fence.revisionId,
    stage: state.stage,
    status: state.status,
    activity: update.activity,
    message: messages[update.activity],
    updatedAt: now.toISOString(),
    experiments: update.experiments,
    eventCount: append ? count + 1 : count,
    timelineCapped: !append || previous?.timelineCapped === true,
  });
  tx.set(
    path,
    nativeTimestamps({
      ...record,
      ...state,
      progress: { ...summary, updatedAt: now },
      updatedAt: now.toISOString(),
    }),
  );
  if (append)
    tx.set(`${path}/events/${String(count + 1).padStart(6, '0')}`, {
      ...summary,
      sequence: count + 1,
      kind: changedStage ? 'transition' : 'activity',
      updatedAt: now,
    });
  return { published: true, summary };
}

export class ProgressRepository {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async get(
    uid: string,
    auditId: string,
    revisionId: string,
  ): Promise<ProgressSnapshot> {
    Id.parse(auditId);
    Id.parse(revisionId);
    return this.store.transaction(async (tx) => {
      const audit = await authorize(tx, uid, auditId, false);
      const record = await tx.get(`audits/${auditId}/revisions/${revisionId}`);
      if (!record || record.ownerUid !== uid)
        throw new ApiError(404, 'not_found', 'Revision was not found.');
      const state = stateFrom(record);
      if (state.auditId !== auditId || state.revisionId !== revisionId)
        throw new Error('Progress revision identity mismatch');
      const policy = ResourcePolicy.parse(record.policy);
      const summary =
        record.progress == null ? null : ProgressSummary.parse(record.progress);
      if (
        summary &&
        (summary.auditId !== auditId || summary.revisionId !== revisionId)
      )
        throw new Error('Stored progress identity mismatch');
      // Cancellation can supersede a coalesced activity. Never show old running
      // activity as the current state or manufacture completion percentages.
      const currentSummary =
        summary &&
        summary.stage === state.stage &&
        summary.status === state.status
          ? summary
          : null;
      return ProgressSnapshot.parse({
        schemaVersion: '1.0',
        auditId,
        revisionId,
        isCurrentRevision: audit.currentRevisionId === revisionId,
        generation: state.generation,
        stage: state.stage,
        status: state.status,
        updatedAt: record.updatedAt,
        progress: currentSummary,
        pollAfterSeconds:
          state.stage === 'finished' || audit.currentRevisionId !== revisionId
            ? null
            : policy.progressIntervalSeconds,
      });
    });
  }
  publish(uid: string, auditId: string, fence: Fence, update: ProgressUpdate) {
    return this.store.transaction((tx) =>
      persistProgress(tx, uid, auditId, fence, update, this.clock()),
    );
  }
}
