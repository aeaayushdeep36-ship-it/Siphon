import { z } from 'zod';
import { Count, Digest, Id, Timestamp } from '@siphon/contracts';
import type { AiConfiguration } from './ai-config.js';
import { Operation } from './accounting.js';
import { DispatchFence, nativeTimestamps } from './audit-commands.js';
import type { DocumentStore, DocumentTransaction } from './firestore.js';
import { groqConfigurationDigest } from './groq-configuration-digest.js';
import { canonicalJson, sha256 } from './hashing.js';
import { prepareOwnedInvestigationInTransaction } from './investigation-evidence.js';
import { validateInvestigationDraft } from './investigation-draft.js';
import { FreeModelJob, FreeModelReceipt } from './groq-model-contracts.js';

export const InvestigationTask = z
  .strictObject({
    schemaVersion: z.literal('1.0'),
    operationId: Id,
    ownerUid: z.string().min(1).max(128),
    auditId: Id,
    revisionId: Id,
    inputDigest: Digest,
    generation: Count,
    evaluationId: Id,
    evidenceDigest: Digest,
    evidenceIds: z.array(Id).min(1).max(3),
    requestDigest: Digest,
    configDigest: Digest,
    promptVersion: z.literal('investigation.groq.1'),
    createdAt: Timestamp,
  })
  .refine((task) => new Set(task.evidenceIds).size === task.evidenceIds.length);

/** Rebuild the data-only request in the caller's transaction. This verifies
 * provenance and binding, but does not itself authorize a provider call. */
export async function requireInvestigationTask(
  tx: DocumentTransaction,
  uid: string,
  expected: unknown,
  operationIdValue: unknown,
  config: AiConfiguration,
  allowedOutcomes: readonly ('reserved' | 'dispatching' | 'succeeded')[],
  clock: () => Date = () => new Date(),
) {
  const fence = DispatchFence.parse(expected);
  const operationId = Id.parse(operationIdValue);
  const [rawOperation, rawTask] = await tx.getMany([
    `operations/${operationId}`,
    `investigationTasks/${operationId}`,
  ]);
  const operation = Operation.parse(rawOperation);
  const task = InvestigationTask.parse(rawTask);
  const prepared = await prepareOwnedInvestigationInTransaction(
    tx,
    uid,
    fence,
    task.evaluationId,
    config,
    clock,
  );
  if (
    operation.id !== operationId ||
    operation.ownerUid !== uid ||
    operation.auditId !== fence.auditId ||
    operation.revisionId !== fence.revisionId ||
    operation.inputDigest !== fence.inputDigest ||
    operation.fence !== fence.generation ||
    !allowedOutcomes.includes(
      operation.outcome as 'reserved' | 'dispatching' | 'succeeded',
    ) ||
    operation.requestDigest !== prepared.requestDigest ||
    task.operationId !== operationId ||
    task.ownerUid !== uid ||
    task.auditId !== fence.auditId ||
    task.revisionId !== fence.revisionId ||
    task.inputDigest !== fence.inputDigest ||
    task.generation !== fence.generation ||
    task.requestDigest !== prepared.requestDigest ||
    task.evidenceDigest !== prepared.expected.evidenceDigest ||
    canonicalJson(task.evidenceIds) !==
      canonicalJson(prepared.expected.evidenceIds) ||
    task.configDigest !== (await groqConfigurationDigest(config))
  )
    throw new Error('Investigation task binding changed');
  return { operation, task, prepared };
}

export class InvestigationTasks {
  constructor(
    private readonly store: DocumentStore,
    private readonly config: AiConfiguration,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Bind only an already-reserved operation; no provider request occurs here. */
  async bind(
    uid: string,
    expected: unknown,
    operationIdValue: unknown,
    evaluationIdValue: unknown,
  ) {
    const fence = DispatchFence.parse(expected);
    const operationId = Id.parse(operationIdValue);
    const evaluationId = Id.parse(evaluationIdValue);
    return this.store.transaction(async (tx) => {
      const prepared = await prepareOwnedInvestigationInTransaction(
        tx,
        uid,
        fence,
        evaluationId,
        this.config,
        this.clock,
      );
      const [rawOperation, prior] = await tx.getMany([
        `operations/${operationId}`,
        `investigationTasks/${operationId}`,
      ]);
      const operation = Operation.parse(rawOperation);
      if (
        operation.id !== operationId ||
        operation.ownerUid !== uid ||
        operation.auditId !== fence.auditId ||
        operation.revisionId !== fence.revisionId ||
        operation.inputDigest !== fence.inputDigest ||
        operation.fence !== fence.generation ||
        operation.outcome !== 'reserved' ||
        operation.providerHandle !== null ||
        operation.requestDigest !== prepared.requestDigest
      )
        throw new Error('Investigation operation binding mismatch');
      const task = InvestigationTask.parse({
        schemaVersion: '1.0',
        operationId,
        ownerUid: uid,
        ...fence,
        evaluationId,
        evidenceDigest: prepared.expected.evidenceDigest,
        evidenceIds: prepared.expected.evidenceIds,
        requestDigest: prepared.requestDigest,
        configDigest: await groqConfigurationDigest(this.config),
        promptVersion: 'investigation.groq.1',
        createdAt: this.clock().toISOString(),
      });
      if (prior) {
        const old = InvestigationTask.parse(prior);
        if (
          canonicalJson({ ...old, createdAt: null }) !==
          canonicalJson({ ...task, createdAt: null })
        )
          throw new Error('Investigation task is immutable');
      } else
        tx.set(`investigationTasks/${operationId}`, nativeTimestamps(task));
      return prepared;
    });
  }

  /** Store an untrusted draft for later review; it is not a report or verdict. */
  async storeDraft(
    uid: string,
    expected: unknown,
    operationIdValue: unknown,
    value: unknown,
  ) {
    const fence = DispatchFence.parse(expected);
    const operationId = Id.parse(operationIdValue);
    const draftPath = `audits/${fence.auditId}/revisions/${fence.revisionId}/investigationDrafts/${operationId}`;
    return this.store.transaction(async (tx) => {
      const { operation, task, prepared } = await requireInvestigationTask(
        tx,
        uid,
        fence,
        operationId,
        this.config,
        ['succeeded'],
        this.clock,
      );
      const [rawJob, rawReceipt, prior] = await tx.getMany([
        `modelJobs/${operationId}`,
        `modelReceipts/${operationId}`,
        draftPath,
      ]);
      const job = FreeModelJob.parse(rawJob);
      const receipt = FreeModelReceipt.parse(rawReceipt);
      if (
        !operation.usage ||
        !receipt.usage ||
        job.operationId !== operationId ||
        job.purpose !== 'investigation' ||
        job.requestDigest !== task.requestDigest ||
        job.configDigest !== task.configDigest ||
        job.model !== this.config.model ||
        job.endpoint !== this.config.endpoint ||
        receipt.operationId !== operationId ||
        receipt.outcome !== 'succeeded' ||
        receipt.failureCode !== null ||
        receipt.requestDigest !== task.requestDigest ||
        receipt.configDigest !== task.configDigest ||
        receipt.provider !== job.provider ||
        receipt.model !== job.model ||
        receipt.endpoint !== job.endpoint ||
        receipt.usage.prompt_tokens > job.inputTokenBound ||
        receipt.usage.completion_tokens > job.outputTokenBound ||
        operation.charges.some(
          (charge) =>
            operation.usage?.[charge.counterKey] !==
            (charge.consumeOnDispatch
              ? charge.amount
              : receipt.usage!.total_tokens),
        )
      )
        throw new Error('Investigation model receipt is not settled');
      const draft = validateInvestigationDraft(value, prepared.expected);
      const draftDigest = await sha256(canonicalJson(draft));
      if (prior) {
        if (
          prior.ownerUid !== uid ||
          prior.operationId !== operationId ||
          prior.evidenceDigest !== task.evidenceDigest ||
          prior.draftDigest !== draftDigest ||
          prior.requestDigest !== task.requestDigest ||
          prior.status !== 'awaiting_review' ||
          Timestamp.parse(prior.expiresAt) !== prepared.evidenceExpiresAt ||
          canonicalJson(prior.draft) !== canonicalJson(draft)
        )
          throw new Error('Investigation draft is immutable');
        return { draftDigest, replayed: true };
      }
      const now = this.clock();
      tx.set(draftPath, {
        schemaVersion: '1.0',
        ownerUid: uid,
        operationId,
        ...fence,
        evidenceDigest: task.evidenceDigest,
        requestDigest: task.requestDigest,
        draft,
        draftDigest,
        status: 'awaiting_review',
        createdAt: now,
        expiresAt: new Date(prepared.evidenceExpiresAt),
      });
      return { draftDigest, replayed: false };
    });
  }
}
