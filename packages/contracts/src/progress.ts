import { z } from 'zod';
import {
  AuditStage,
  Count,
  Id,
  RunStatus,
  SchemaVersion,
  Timestamp,
} from './common.js';

export const ProgressActivity = z.enum([
  'queued',
  'inspecting_upload',
  'reading_context',
  'awaiting_answers',
  'verifying_adapter',
  'planning_checks',
  'running_experiment',
  'evaluating_evidence',
  'investigating_findings',
  'rendering_report',
  'finished',
  'cancel_requested',
]);
export const ExperimentCounts = z
  .strictObject({ completed: Count, planned: Count })
  .refine((value) => value.completed <= value.planned, {
    message: 'Completed count exceeds planned count',
  });
export const ProgressSummary = z.strictObject({
  schemaVersion: SchemaVersion,
  auditId: Id,
  revisionId: Id,
  stage: AuditStage,
  status: RunStatus,
  activity: ProgressActivity,
  message: z.string().min(1).max(300),
  updatedAt: Timestamp,
  experiments: ExperimentCounts.nullable(),
  eventCount: Count,
  timelineCapped: z.boolean(),
});
export type ProgressSummary = z.infer<typeof ProgressSummary>;

export const ProgressSnapshot = z
  .strictObject({
    schemaVersion: SchemaVersion,
    auditId: Id,
    revisionId: Id,
    isCurrentRevision: z.boolean(),
    generation: Count,
    stage: AuditStage,
    status: RunStatus,
    updatedAt: Timestamp,
    progress: ProgressSummary.nullable(),
    pollAfterSeconds: Count.refine((n) => n > 0).nullable(),
  })
  .superRefine((value, ctx) => {
    const summary = value.progress;
    if (
      summary &&
      (summary.auditId !== value.auditId ||
        summary.revisionId !== value.revisionId ||
        summary.stage !== value.stage ||
        summary.status !== value.status)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Progress must describe the current snapshot state',
      });
    if (
      (value.stage === 'finished' || !value.isCurrentRevision) &&
      value.pollAfterSeconds !== null
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Terminal and historical revisions must stop polling',
      });
  });
export type ProgressSnapshot = z.infer<typeof ProgressSnapshot>;
