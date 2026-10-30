import { z } from 'zod';
import {
  Count,
  Digest,
  ProgressSummary,
  QuestionSet,
  SchemaVersion,
} from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import {
  authorize,
  DispatchFence,
  receiptKey,
  requireActiveRevision,
} from './audit-commands.js';
import { canonicalJson, sha256 } from './hashing.js';
import { transition } from './lifecycle.js';
import { ApiError } from './errors.js';
import { persistProgress } from './progress.js';

const receiptSchema = z.strictObject({
  schemaVersion: SchemaVersion,
  questionSetDigest: Digest,
  generation: Count,
  stage: z.literal('clarifying'),
  status: z.literal('waiting_for_input'),
});

/** Internal workflow publication port. Model content cannot supply owner/fence.
 * A leased stage must first complete its capacity/active-job release protocol;
 * the current service refuses to strand an attached lease by entering a wait.
 */
export class QuestionPublisher {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async publish(
    uid: string,
    expected: z.infer<typeof DispatchFence>,
    value: unknown,
    key: string,
  ) {
    const fence = DispatchFence.parse(expected);
    const questionSet = QuestionSet.parse(value);
    if (
      questionSet.auditId !== fence.auditId ||
      questionSet.revisionId !== fence.revisionId ||
      questionSet.inputDigest !== fence.inputDigest
    )
      throw new ApiError(
        409,
        'question_snapshot_mismatch',
        'Questions do not match the current input snapshot.',
      );
    const digest = await sha256(canonicalJson(questionSet));
    const requestDigest = await sha256(canonicalJson({ fence, questionSet }));
    const requestId = await receiptKey(
      uid,
      `INTERNAL /audits/${fence.auditId}/revisions/${fence.revisionId}/questions`,
      key,
    );
    return this.store.transaction(async (tx) => {
      await authorize(tx, uid, fence.auditId, false);
      const previous = await tx.get(`requests/${requestId}`);
      if (previous) {
        if (previous.requestDigest !== requestDigest)
          throw new ApiError(
            409,
            'idempotency_conflict',
            'Publication key was used with different questions.',
          );
        return {
          receipt: receiptSchema.parse(previous.result),
          replayed: true,
        };
      }
      const state = await requireActiveRevision(tx, uid, fence);
      const path = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
      const revision = await tx.get(path);
      const saved = await tx.get(`${path}/questions/current`);
      if (!revision) throw new Error('Revision disappeared inside transaction');
      if (saved)
        throw new ApiError(
          409,
          'questions_already_published',
          'Questions are immutable once published.',
        );
      if (revision.slotLeaseId != null || revision.activeOperationId != null)
        throw new ApiError(
          409,
          'stage_release_required',
          'Finish active work and release capacity before waiting for answers.',
        );
      const next = transition(state, fence, {
        kind: 'wait',
        reason: 'Clarification facts are required.',
      });
      const result = receiptSchema.parse({
        schemaVersion: '1.0',
        questionSetDigest: digest,
        generation: next.generation,
        stage: next.stage,
        status: next.status,
      });
      const now = this.clock();
      const previousProgress =
        revision.progress === undefined
          ? null
          : ProgressSummary.parse(revision.progress);
      await persistProgress(
        tx,
        uid,
        fence.auditId,
        fence,
        {
          activity: 'awaiting_answers',
          experiments: previousProgress?.experiments ?? null,
        },
        now,
        { kind: 'wait', reason: 'Clarification facts are required.' },
      );
      tx.set(`${path}/questions/current`, {
        schemaVersion: '1.0',
        ownerUid: uid,
        questionSet,
        createdAt: now,
        updatedAt: now,
      });
      tx.set(`requests/${requestId}`, {
        schemaVersion: '1.0',
        ownerUid: uid,
        auditId: fence.auditId,
        requestDigest,
        result,
        createdAt: now,
        updatedAt: now,
      });
      return { receipt: result, replayed: false };
    });
  }
}
