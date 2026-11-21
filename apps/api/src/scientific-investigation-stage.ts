import { Id } from '@siphon/contracts';
import type { z } from 'zod';
import type { AiConfiguration } from './ai-config.js';
import type { DocumentStore } from './firestore.js';
import { DispatchFence, requireActiveRevision } from './audit-commands.js';
import { prepareOwnedInvestigationInTransaction } from './investigation-evidence.js';
import {
  InvestigationStage,
  readInvestigationReview,
} from './investigation-review.js';
import { GroqAdmissionBlocked, type GroqModelJobs } from './groq-model-jobs.js';
import { groqConfigurationDigest } from './groq-configuration-digest.js';
import { persistProgress } from './progress.js';
import { AdmissionRepository } from './admission.js';
import { Operation } from './accounting.js';

/** One data-only advisory call. A durable operation identity fences duplicate
 * delivery; unknown or lost output is reconciled instead of sent again. */
export class ScientificInvestigationStage {
  constructor(
    private readonly store: DocumentStore,
    private readonly config: AiConfiguration,
    private readonly jobs: Pick<GroqModelJobs, 'run' | 'dispatchInvestigation'>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async run(uid: string, expected: unknown, evaluationIdValue: unknown) {
    const { claimed, fence } = await this.claim(
      uid,
      expected,
      evaluationIdValue,
    );
    const current = await this.store.transaction(async (tx) => {
      await requireActiveRevision(tx, uid, fence);
      const draft = await readInvestigationReview(tx, uid, fence, this.clock);
      const operation = await tx.get(`operations/${claimed.stage.operationId}`);
      return { draft, operation };
    });
    if (!current.draft) {
      if (
        current.operation &&
        Operation.parse(current.operation).outcome !== 'reserved'
      )
        return {
          status: 'blocked' as const,
          fence,
          code: 'investigation_requires_reconciliation' as const,
        };
      try {
        await this.jobs.run(
          uid,
          fence,
          claimed.stage.operationId,
          claimed.prepared,
          'investigation',
        );
      } catch (error) {
        if (!(error instanceof GroqAdmissionBlocked)) throw error;
        return { status: 'blocked' as const, fence, code: error.code };
      }
    }
    return this.complete(uid, fence, claimed.stage.operationId);
  }

  async prepare(uid: string, expected: unknown, evaluationIdValue: unknown) {
    const { claimed, fence } = await this.claim(
      uid,
      expected,
      evaluationIdValue,
    );
    const current = await this.store.transaction(async (tx) => {
      await requireActiveRevision(tx, uid, fence);
      const draft = await readInvestigationReview(tx, uid, fence, this.clock);
      const operation = await tx.get(`operations/${claimed.stage.operationId}`);
      return { draft, operation };
    });
    if (current.draft)
      return this.complete(uid, fence, claimed.stage.operationId);
    if (
      current.operation &&
      Operation.parse(current.operation).outcome !== 'reserved'
    )
      return {
        status: 'blocked' as const,
        fence,
        code: 'investigation_requires_reconciliation' as const,
      };
    try {
      const result = await this.jobs.run(
        uid,
        fence,
        claimed.stage.operationId,
        claimed.prepared,
        'investigation',
        undefined,
        'prepare',
      );
      if (result.status !== 'reserved')
        throw new Error('Investigation admission was not persisted');
      return {
        status: 'dispatch_ready' as const,
        fence,
        operationId: claimed.stage.operationId,
      };
    } catch (error) {
      if (!(error instanceof GroqAdmissionBlocked)) throw error;
      return { status: 'blocked' as const, fence, code: error.code };
    }
  }

  async dispatch(uid: string, expected: unknown, operationIdValue: unknown) {
    const fence = DispatchFence.parse(expected);
    const operationId = Id.parse(operationIdValue);
    try {
      await this.jobs.dispatchInvestigation(uid, fence, operationId);
    } catch (error) {
      if (!(error instanceof GroqAdmissionBlocked)) throw error;
      return { status: 'blocked' as const, fence, code: error.code };
    }
    return this.complete(uid, fence, operationId);
  }

  private async claim(
    uid: string,
    expected: unknown,
    evaluationIdValue: unknown,
  ) {
    const initial = DispatchFence.parse(expected);
    const evaluationId = Id.parse(evaluationIdValue);
    const configDigest = await groqConfigurationDigest(this.config);
    const claimed = await this.store.transaction(async (tx) => {
      const prior = await tx.get(
        `scientificInvestigationStages/${initial.revisionId}`,
      );
      const stage = prior ? InvestigationStage.parse(prior) : null;
      if (
        stage &&
        (stage.ownerUid !== uid ||
          stage.auditId !== initial.auditId ||
          stage.revisionId !== initial.revisionId ||
          stage.inputDigest !== initial.inputDigest ||
          stage.evaluationId !== evaluationId ||
          stage.configDigest !== configDigest ||
          ![stage.sourceGeneration, stage.generation].includes(
            initial.generation,
          ))
      )
        throw new Error('Investigation stage binding changed');
      const fence = {
        ...initial,
        generation: stage?.generation ?? initial.generation,
      };
      const state = await requireActiveRevision(tx, uid, fence);
      if (!['evaluating', 'investigating'].includes(state.stage))
        throw new Error('Investigation stage is unavailable');
      const prepared = await prepareOwnedInvestigationInTransaction(
        tx,
        uid,
        fence,
        evaluationId,
        this.config,
        this.clock,
        state.stage as 'evaluating' | 'investigating',
      );
      if (stage) {
        if (
          state.stage !== 'investigating' ||
          stage.requestDigest !== prepared.requestDigest ||
          stage.evidenceDigest !== prepared.expected.evidenceDigest
        )
          throw new Error('Investigation evidence changed');
        return { stage, prepared };
      }
      if (state.stage !== 'evaluating')
        throw new Error('Investigation claim is missing');
      const next = InvestigationStage.parse({
        schemaVersion: '1.0',
        ownerUid: uid,
        ...initial,
        sourceGeneration: initial.generation,
        generation: initial.generation + 1,
        evaluationId,
        operationId: crypto.randomUUID(),
        evidenceDigest: prepared.expected.evidenceDigest,
        requestDigest: prepared.requestDigest,
        configDigest,
        createdAt: this.clock().toISOString(),
      });
      await persistProgress(
        tx,
        uid,
        initial.auditId,
        initial,
        {
          activity: 'investigating_findings',
          experiments: { planned: 1, completed: 1 },
        },
        this.clock(),
        {
          kind: 'advance',
          stage: 'investigating',
          reason:
            'Prepare advisory investigation from published numerical evidence.',
        },
      );
      tx.set(`scientificInvestigationStages/${initial.revisionId}`, {
        ...next,
        createdAt: this.clock(),
      });
      return { stage: next, prepared };
    });
    const fence = DispatchFence.parse({
      auditId: claimed.stage.auditId,
      revisionId: claimed.stage.revisionId,
      inputDigest: claimed.stage.inputDigest,
      generation: claimed.stage.generation,
    });
    return { claimed, fence };
  }

  private async complete(
    uid: string,
    fence: z.infer<typeof DispatchFence>,
    operationId: string,
  ) {
    const draft = await this.store.transaction(async (tx) => {
      await requireActiveRevision(tx, uid, fence);
      const snapshot = await readInvestigationReview(
        tx,
        uid,
        fence,
        this.clock,
      );
      if (!snapshot) throw new Error('Investigation output is unavailable');
      return snapshot;
    });
    // Waiting for text review must not hold scarce execution capacity.
    const revision = await this.store.get(
      `audits/${fence.auditId}/revisions/${fence.revisionId}`,
    );
    if (revision?.slotLeaseId != null)
      await new AdmissionRepository(this.store, this.clock).releaseReconciled(
        uid,
        fence,
        Id.parse(revision.slotLeaseId),
      );
    return {
      status:
        draft.status === 'awaiting_review'
          ? ('awaiting_review' as const)
          : ('reviewed' as const),
      fence,
      operationId: draft.operationId ?? operationId,
    };
  }
}
