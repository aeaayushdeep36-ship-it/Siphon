import { z } from 'zod';
import {
  ConservationJobRequest,
  Count,
  Digest,
  Id,
  InvestigationReviewReceipt,
  InvestigationReviewSnapshot,
  SubmitInvestigationReview,
  Timestamp,
  validateConservationJobResult,
} from '@siphon/contracts';
import type { DocumentStore, DocumentTransaction } from './firestore.js';
import {
  authorize,
  DispatchFence,
  nativeTimestamps,
  receiptKey,
  requireActiveRevision,
} from './audit-commands.js';
import { Operation } from './accounting.js';
import { FreeModelJob, FreeModelReceipt } from './groq-model-contracts.js';
import { InvestigationTask } from './investigation-tasks.js';
import { validateInvestigationDraft } from './investigation-draft.js';
import { canonicalJson, sha256 } from './hashing.js';
import { ApiError } from './errors.js';

export const InvestigationStage = DispatchFence.extend({
  schemaVersion: z.literal('1.0'),
  ownerUid: z.string().min(1).max(128),
  sourceGeneration: Count,
  evaluationId: Id,
  operationId: Id,
  evidenceDigest: Digest,
  requestDigest: Digest,
  configDigest: Digest,
  createdAt: Timestamp,
});

/** Read only after authorizing this private revision. Revalidate settled model
 * provenance and the exact evidence snapshot before displaying or publishing
 * any advisory text. This does not establish the truth of a hypothesis. */
export async function readInvestigationReview(
  tx: DocumentTransaction | DocumentStore,
  uid: string,
  fence: z.infer<typeof DispatchFence>,
  clock: () => Date,
  allowExpired = false,
) {
  const base = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
  const [rawStage, review] = await tx.getMany([
    `scientificInvestigationStages/${fence.revisionId}`,
    `${base}/investigationReviews/current`,
  ]);
  if (!rawStage) {
    if (review) throw new Error('Investigation stage is missing');
    return null;
  }
  const stage = InvestigationStage.parse(rawStage);
  if (
    stage.ownerUid !== uid ||
    stage.auditId !== fence.auditId ||
    stage.revisionId !== fence.revisionId ||
    stage.inputDigest !== fence.inputDigest ||
    stage.generation > fence.generation
  )
    throw new Error('Investigation stage changed');
  const [
    rawDraft,
    rawTask,
    rawOperation,
    rawJob,
    rawReceipt,
    evidence,
    evaluation,
  ] = await tx.getMany([
    `${base}/investigationDrafts/${stage.operationId}`,
    `investigationTasks/${stage.operationId}`,
    `operations/${stage.operationId}`,
    `modelJobs/${stage.operationId}`,
    `modelReceipts/${stage.operationId}`,
    `${base}/evidence/${stage.evaluationId}`,
    `scientificEvaluationStages/${fence.revisionId}`,
  ]);
  if (!rawDraft) {
    if (review) throw new Error('Reviewed investigation draft is missing');
    return null;
  }
  const task = InvestigationTask.parse(rawTask);
  const operation = Operation.parse(rawOperation);
  const job = FreeModelJob.parse(rawJob);
  const receipt = FreeModelReceipt.parse(rawReceipt);
  const request = ConservationJobRequest.parse(evaluation?.request);
  const result = validateConservationJobResult(evidence?.report, request);
  const evidenceDigest = await sha256(canonicalJson(result));
  const draft = validateInvestigationDraft(rawDraft.draft, {
    ...fence,
    evidenceDigest,
    evidenceIds: result.evidence.map((item) => item.id),
  });
  const draftDigest = await sha256(canonicalJson(draft));
  for (const record of [task, rawDraft, operation, evidence, evaluation])
    if (
      record?.ownerUid !== uid ||
      record.auditId !== fence.auditId ||
      record.revisionId !== fence.revisionId ||
      record.inputDigest !== fence.inputDigest
    )
      throw new Error('Investigation ownership or snapshot changed');
  if (
    stage.evaluationId !== request.diagnostic.operationId ||
    stage.evaluationId !== task.evaluationId ||
    stage.operationId !== task.operationId ||
    stage.operationId !== rawDraft.operationId ||
    stage.operationId !== operation.id ||
    stage.operationId !== job.operationId ||
    stage.operationId !== receipt.operationId ||
    stage.generation !== task.generation ||
    stage.generation !== rawDraft.generation ||
    stage.generation !== operation.fence ||
    stage.evidenceDigest !== evidenceDigest ||
    task.evidenceDigest !== evidenceDigest ||
    evidence?.reportDigest !== evidenceDigest ||
    rawDraft.evidenceDigest !== evidenceDigest ||
    rawDraft.draftDigest !== draftDigest ||
    rawDraft.status !== 'awaiting_review' ||
    [task, rawDraft, operation, job, receipt].some(
      (record) => record.requestDigest !== stage.requestDigest,
    ) ||
    [task, job, receipt].some(
      (record) => record.configDigest !== stage.configDigest,
    ) ||
    job.purpose !== 'investigation' ||
    receipt.provider !== job.provider ||
    receipt.model !== job.model ||
    receipt.endpoint !== job.endpoint ||
    operation.outcome !== 'succeeded' ||
    receipt.outcome !== 'succeeded' ||
    receipt.failureCode !== null ||
    !operation.usage ||
    !receipt.usage ||
    receipt.usage.prompt_tokens > job.inputTokenBound ||
    receipt.usage.completion_tokens > job.outputTokenBound ||
    operation.charges.some(
      (charge) =>
        operation.usage?.[charge.counterKey] !==
        (charge.consumeOnDispatch
          ? charge.amount
          : receipt.usage!.total_tokens),
    ) ||
    Date.parse(Timestamp.parse(rawDraft.expiresAt)) >
      Date.parse(Timestamp.parse(evidence?.expiresAt)) ||
    (!allowExpired &&
      Date.parse(Timestamp.parse(rawDraft.expiresAt)) <= clock().getTime())
  )
    throw new Error('Investigation draft or accounting proof changed');
  if (
    review &&
    (review.ownerUid !== uid ||
      review.auditId !== fence.auditId ||
      review.revisionId !== fence.revisionId ||
      review.inputDigest !== fence.inputDigest ||
      review.operationId !== stage.operationId ||
      review.draftDigest !== draftDigest ||
      review.evidenceDigest !== evidenceDigest)
  )
    throw new Error('Investigation review changed');
  return InvestigationReviewSnapshot.parse({
    provider: job.provider,
    model: job.model,
    operationId: stage.operationId,
    draftDigest,
    draft,
    evidence: result.evidence,
    status:
      Date.parse(Timestamp.parse(rawDraft.expiresAt)) <= clock().getTime()
        ? 'expired'
        : (review?.status ?? 'awaiting_review'),
    expiresAt: Timestamp.parse(rawDraft.expiresAt),
  });
}

/** Owner acceptance is advisory-text review, never scientific verification. */
export class InvestigationReviews {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async submit(
    uid: string,
    auditId: string,
    revisionId: string,
    value: unknown,
    key: string,
  ) {
    const input = SubmitInvestigationReview.parse(value);
    const fence = DispatchFence.parse({
      auditId,
      revisionId,
      generation: input.expectedGeneration,
      inputDigest: input.expectedInputDigest,
    });
    const requestId = await receiptKey(
      uid,
      `POST /audits/${auditId}/revisions/${revisionId}/investigation-review`,
      key,
    );
    const requestDigest = await sha256(canonicalJson(input));
    const base = `audits/${auditId}/revisions/${revisionId}`;
    return this.store.transaction(async (tx) => {
      const audit = await authorize(tx, uid, auditId, false);
      const previous = await tx.get(`requests/${requestId}`);
      const revision = await tx.get(base);
      if (
        audit.currentRevisionId !== revisionId ||
        revision?.ownerUid !== uid ||
        revision.inputDigest !== fence.inputDigest
      )
        throw new Error('Investigation review revision changed');
      if (previous) {
        if (
          previous.ownerUid !== uid ||
          previous.auditId !== auditId ||
          previous.requestDigest !== requestDigest
        )
          throw new ApiError(
            409,
            'idempotency_conflict',
            'This review key was used with different input.',
          );
        return InvestigationReviewReceipt.parse({
          ...(previous.result as object),
          replayed: true,
        });
      }
      const state = await requireActiveRevision(tx, uid, fence);
      if (state.stage !== 'investigating')
        throw new Error('Investigation review is unavailable');
      const snapshot = await readInvestigationReview(
        tx,
        uid,
        fence,
        this.clock,
      );
      if (!snapshot || snapshot.draftDigest !== input.draftDigest)
        throw new ApiError(
          409,
          'investigation_review_changed',
          'Investigation text changed. Refresh before reviewing.',
        );
      const status = input.decision === 'accept' ? 'accepted' : 'omitted';
      if (snapshot.status !== 'awaiting_review' && snapshot.status !== status)
        throw new ApiError(
          409,
          'investigation_review_immutable',
          'The saved investigation review is immutable.',
        );
      const result = InvestigationReviewReceipt.parse({
        schemaVersion: '1.0',
        operationId: snapshot.operationId,
        draftDigest: snapshot.draftDigest,
        status,
        replayed: false,
      });
      if (snapshot.status === 'awaiting_review')
        tx.set(
          `${base}/investigationReviews/current`,
          nativeTimestamps({
            schemaVersion: '1.0',
            ownerUid: uid,
            ...fence,
            operationId: snapshot.operationId,
            draftDigest: snapshot.draftDigest,
            evidenceDigest: snapshot.draft.evidenceDigest,
            status,
            reviewedAt: this.clock().toISOString(),
          }),
        );
      tx.set(`requests/${requestId}`, {
        schemaVersion: '1.0',
        ownerUid: uid,
        auditId,
        requestDigest,
        result,
        createdAt: this.clock(),
      });
      return result;
    });
  }
}
