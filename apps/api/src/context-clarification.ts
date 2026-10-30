import { QuestionSet, ContextProposal, Id } from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import { Operation } from './accounting.js';
import { ContextTask } from './context-tasks.js';
import { authorize } from './audit-commands.js';
import { AdmissionRepository } from './admission.js';
import { QuestionPublisher } from './question-publication.js';
import { canonicalJson, sha256 } from './hashing.js';
import { buildContextQuestions } from './context-questions.js';

/** Idempotent internal continuation after successful context publication.
 * Releasing capacity and publishing questions are deliberately separate safe
 * transactions: an interruption may delay questions, but cannot strand a wait
 * with capacity held or free uncertain execution.
 */
export class ContextClarification {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async publish(operationId: string) {
    Id.parse(operationId);
    const prepared = await this.store.transaction(async (tx) => {
      const operation = Operation.parse(
        await tx.get(`operations/${operationId}`),
      );
      const task = ContextTask.parse(
        await tx.get(`contextTasks/${operationId}`),
      );
      const audit = await authorize(
        tx,
        operation.ownerUid,
        operation.auditId,
        false,
      );
      const path = `audits/${operation.auditId}/revisions/${operation.revisionId}`;
      const revision = await tx.get(path);
      const context = await tx.get(`${path}/context/current`);
      const proposal = ContextProposal.parse(context?.proposal);
      const questions = QuestionSet.parse(context?.questionDraft);
      const expectedQuestions = buildContextQuestions(task);
      const definitions = (set: typeof questions) =>
        set.questions.map((question) => ({ ...question, id: null }));
      if (
        operation.outcome !== 'succeeded' ||
        task.operationId !== operationId ||
        task.ownerUid !== operation.ownerUid ||
        task.auditId !== operation.auditId ||
        task.revisionId !== operation.revisionId ||
        task.inputDigest !== operation.inputDigest ||
        task.generation !== operation.fence ||
        task.requestDigest !== operation.requestDigest ||
        audit.currentRevisionId !== operation.revisionId ||
        context?.operationId !== operationId ||
        context.ownerUid !== operation.ownerUid ||
        context.inputDigest !== operation.inputDigest ||
        context.proposalDigest !== (await sha256(canonicalJson(proposal))) ||
        questions.auditId !== operation.auditId ||
        questions.revisionId !== operation.revisionId ||
        questions.inputDigest !== operation.inputDigest ||
        proposal.auditId !== operation.auditId ||
        proposal.revisionId !== operation.revisionId ||
        proposal.inputDigest !== operation.inputDigest ||
        proposal.domain !== audit.domain ||
        !revision ||
        revision.activeOperationId != null ||
        canonicalJson(definitions(questions)) !==
          canonicalJson(definitions(expectedQuestions))
      )
        throw new Error('Context clarification snapshot mismatch');
      return {
        uid: operation.ownerUid,
        questions,
        leaseId: revision.slotLeaseId,
        fence: {
          auditId: operation.auditId,
          revisionId: operation.revisionId,
          generation: operation.fence,
          inputDigest: operation.inputDigest,
        },
      };
    });
    if (prepared.leaseId != null)
      await new AdmissionRepository(this.store, this.clock).releaseReconciled(
        prepared.uid,
        prepared.fence,
        String(prepared.leaseId),
      );
    return new QuestionPublisher(this.store, this.clock).publish(
      prepared.uid,
      prepared.fence,
      prepared.questions,
      `context_${operationId}`,
    );
  }
}
