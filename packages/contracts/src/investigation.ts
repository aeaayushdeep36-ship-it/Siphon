import { z } from 'zod';
import { Count, Digest, Id, SchemaVersion, Timestamp } from './common.js';
import { reportText } from './reports.js';
import { MetricEvidence } from './evidence.js';

const evidenceReferences = z
  .array(Id)
  .min(1)
  .max(20)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    'Duplicate evidence reference',
  );
const advisoryText = reportText(2000).refine(
  (value) => !value.includes('```'),
  'Code blocks are not accepted as investigation text',
);

/** Untrusted advisory output. It never carries facts or numerical verdicts. */
export const InvestigationDraft = z.strictObject({
  schemaVersion: SchemaVersion,
  auditId: Id,
  revisionId: Id,
  inputDigest: Digest,
  evidenceDigest: Digest,
  hypotheses: z
    .array(
      z.strictObject({
        text: advisoryText,
        evidenceIds: evidenceReferences,
        verification: advisoryText,
      }),
    )
    .max(20),
  recommendations: z
    .array(
      z.strictObject({
        text: advisoryText,
        evidenceIds: evidenceReferences,
        validation: advisoryText,
      }),
    )
    .max(20),
});

export const InvestigationReviewSnapshot = z
  .strictObject({
    provider: z.literal('groq'),
    model: z.string().min(1).max(200),
    operationId: Id,
    draftDigest: Digest,
    draft: InvestigationDraft,
    evidence: z.array(MetricEvidence).min(1).max(3),
    status: z.enum(['awaiting_review', 'accepted', 'omitted', 'expired']),
    expiresAt: Timestamp,
  })
  .superRefine((value, ctx) => {
    const ids = new Set(value.evidence.map((item) => item.id));
    if (
      ids.size !== value.evidence.length ||
      value.evidence.some(
        (item) =>
          item.auditId !== value.draft.auditId ||
          item.revisionId !== value.draft.revisionId ||
          item.inputDigest !== value.draft.inputDigest,
      ) ||
      [...value.draft.hypotheses, ...value.draft.recommendations].some((item) =>
        item.evidenceIds.some((id) => !ids.has(id)),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Investigation review evidence snapshot mismatch',
      });
  });
export const SubmitInvestigationReview = z.strictObject({
  schemaVersion: SchemaVersion,
  expectedGeneration: Count,
  expectedInputDigest: Digest,
  draftDigest: Digest,
  decision: z.enum(['accept', 'omit']),
});
export const InvestigationReviewReceipt = z.strictObject({
  schemaVersion: SchemaVersion,
  operationId: Id,
  draftDigest: Digest,
  status: z.enum(['accepted', 'omitted']),
  replayed: z.boolean(),
});
export type InvestigationDraft = z.infer<typeof InvestigationDraft>;
export type InvestigationReviewSnapshot = z.infer<
  typeof InvestigationReviewSnapshot
>;
