import { Id } from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import { DispatchFence, requireActiveRevision } from './audit-commands.js';
import { Operation } from './accounting.js';
import { ScientificExecutionTransition } from './scientific-execution-transition.js';
import { ScientificEvaluationStage } from './scientific-evaluation-stage.js';
import { type ConservationPipeline } from './conservation-pipeline.js';

/** Drive the plan to one data-only evaluation. An uncertain provider outcome is
 * never dispatched a second time; only durable publication may be recovered. */
export class ScientificEvaluationCoordinator {
  constructor(
    private readonly store: DocumentStore,
    private readonly pipeline: Pick<ConservationPipeline, 'run' | 'recover'>,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async run(uid: string, expected: unknown) {
    let fence = DispatchFence.parse(expected);
    for (let count = 0; count < 3; count++) {
      const state = await this.store.transaction((tx) =>
        requireActiveRevision(tx, uid, fence),
      );
      if (state.stage === 'evaluating') break;
      if (!['adapting', 'planning', 'executing'].includes(state.stage))
        throw new Error('Scientific evaluation cannot start in this stage');
      fence = (
        await new ScientificExecutionTransition(this.store, this.clock).advance(
          uid,
          fence,
        )
      ).fence;
    }
    const snapshot = await this.store.transaction(async (tx) => {
      const state = await requireActiveRevision(tx, uid, fence);
      if (state.stage !== 'evaluating')
        throw new Error('Scientific evaluation stage unavailable');
      const stage = await tx.get(`scientificBudgetStages/${fence.revisionId}`);
      if (
        stage?.ownerUid !== uid ||
        stage.auditId !== fence.auditId ||
        stage.revisionId !== fence.revisionId ||
        stage.inputDigest !== fence.inputDigest ||
        stage.generation !== fence.generation
      )
        throw new Error('Scientific evaluation reservation changed');
      const operationId = Id.parse(stage.operationId),
        operation = Operation.parse(await tx.get(`operations/${operationId}`));
      if (
        operation.id !== operationId ||
        operation.ownerUid !== uid ||
        operation.auditId !== fence.auditId ||
        operation.revisionId !== fence.revisionId ||
        operation.inputDigest !== fence.inputDigest ||
        operation.fence !== fence.generation
      )
        throw new Error('Scientific evaluation operation changed');
      const [candidate, report] = await tx.getMany([
        `conservationCandidates/${operationId}`,
        `audits/${fence.auditId}/revisions/${fence.revisionId}/evidence/${operationId}`,
      ]);
      return {
        operation,
        operationId,
        hasCandidateOrReport: !!candidate || !!report,
      };
    });
    if (snapshot.operation.outcome !== 'reserved') {
      if (!snapshot.hasCandidateOrReport)
        return {
          status: 'blocked' as const,
          code: 'scientific_evaluation_requires_reconciliation' as const,
          operationId: snapshot.operationId,
          fence,
        };
      return {
        ...(await this.pipeline.recover(snapshot.operationId)),
        operationId: snapshot.operationId,
        fence,
      };
    }
    const prepared = await new ScientificEvaluationStage(
      this.store,
      this.clock,
    ).prepare(uid, fence);
    const result = await this.pipeline.run(
      uid,
      prepared.sandbox,
      prepared.request,
      fence,
    );
    return { ...result, operationId: snapshot.operationId, fence };
  }
}
