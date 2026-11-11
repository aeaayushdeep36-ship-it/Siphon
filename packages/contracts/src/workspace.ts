import { z } from 'zod';
import { Audit } from './audits.js';
import {
  AuditStage,
  Count,
  Digest,
  Id,
  RunStatus,
  SchemaVersion,
  Timestamp,
} from './common.js';
import { UploadEntry } from './uploads.js';
import { InspectionGate } from './readiness.js';
import { ContextProposal } from './context.js';
import { AuditPlan } from './plans.js';
import { AdapterProposal } from './adapter.js';
import { Answer, QuestionSet } from './questions.js';
import { InvestigationReviewSnapshot } from './investigation.js';

export const AuditHistoryResponse = z.strictObject({
  schemaVersion: SchemaVersion,
  audits: z.array(Audit).max(20),
  nextCursor: z.string().max(1000).nullable(),
});
export const AuditWorkspace = z
  .strictObject({
    schemaVersion: SchemaVersion,
    auditId: Id,
    revisionId: Id,
    generation: Count,
    inputDigest: Digest,
    stage: AuditStage,
    status: RunStatus,
    uploads: z.array(UploadEntry).max(10),
    uploadStates: z
      .array(
        z.strictObject({
          artifactId: Id,
          lifecycle: z.enum([
            'reserved',
            'ready',
            'expired',
            'deleting',
            'deleted',
            'failed',
            'missing',
          ]),
          expiresAt: Timestamp.nullable(),
        }),
      )
      .max(10),
    readiness: InspectionGate.nullable(),
    context: ContextProposal.nullable(),
    adapterProposal: AdapterProposal.nullable().default(null),
    adapterQuestions: QuestionSet.nullable().default(null),
    adapterDigest: Digest.nullable().default(null),
    adapterQuestionSetDigest: Digest.nullable().default(null),
    adapterReview: z
      .strictObject({ resultDigest: Digest, allDeclaredConfirmed: z.boolean() })
      .nullable()
      .default(null),
    scientificQuestions: z
      .strictObject({
        questionSet: QuestionSet,
        questionSetDigest: Digest,
        answer: Answer.nullable(),
      })
      .nullable()
      .default(null),
    heatParameters: z
      .strictObject({
        densityKgM3: z.number().finite().positive(),
        heatCapacityJKgK: z.number().finite().positive(),
      })
      .nullable()
      .default(null),
    investigation: InvestigationReviewSnapshot.nullable().default(null),
    plan: AuditPlan.nullable(),
    planDigest: Digest.nullable().default(null),
    operationalIssues: z
      .array(
        z.strictObject({
          code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
          message: z.string().min(1).max(300),
        }),
      )
      .max(10)
      .default([]),
  })
  .superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    for (const snapshot of [
      value.context,
      value.plan,
      value.adapterProposal,
      value.adapterQuestions,
      value.investigation?.draft,
    ])
      if (
        snapshot &&
        (snapshot.auditId !== value.auditId ||
          snapshot.revisionId !== value.revisionId ||
          snapshot.inputDigest !== value.inputDigest)
      )
        fail('Workspace snapshot mismatch');
    if (value.adapterQuestions && !value.adapterProposal)
      fail('Adapter questions require a proposal');
    if (
      value.scientificQuestions &&
      (value.scientificQuestions.questionSet.auditId !== value.auditId ||
        value.scientificQuestions.questionSet.revisionId !== value.revisionId ||
        value.scientificQuestions.questionSet.inputDigest !== value.inputDigest)
    )
      fail('Scientific question snapshot mismatch');
    if (
      new Set(value.uploads.map((item) => item.artifactId)).size !==
        value.uploads.length ||
      new Set(value.uploadStates.map((item) => item.artifactId)).size !==
        value.uploadStates.length ||
      value.uploadStates.length !== value.uploads.length ||
      value.uploadStates.some(
        (item) =>
          !value.uploads.some(
            (upload) => upload.artifactId === item.artifactId,
          ),
      )
    )
      fail('Workspace upload identities differ');
  });
export type AuditHistoryResponse = z.infer<typeof AuditHistoryResponse>;
export type AuditWorkspace = z.infer<typeof AuditWorkspace>;
export const RevisionHistoryResponse = z.strictObject({
  schemaVersion: SchemaVersion,
  revisions: z
    .array(
      z.strictObject({
        revisionId: Id,
        stage: AuditStage,
        status: RunStatus,
        createdAt: Timestamp,
        reportId: Id.nullable(),
      }),
    )
    .max(20),
  nextCursor: z.string().max(1000).nullable(),
});
