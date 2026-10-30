import {
  AdapterProposal,
  Answer,
  Id,
  QuestionSet,
  Timestamp,
} from '@siphon/contracts';
import { z } from 'zod';
import { type DocumentStore } from './firestore.js';
import { DispatchFence, requireActiveRevision } from './audit-commands.js';
import { Operation } from './accounting.js';
import { FidelityRequest, validateFidelityResult } from './fidelity-runner.js';
import { SourceExecutionBinding } from './source-executions.js';
import { SandboxTermination } from './sandbox-termination.js';
import { interpretAdapterAnswers } from './adapter-questions.js';
import { canonicalJson, sha256 } from './hashing.js';

/** Contract-level verification, conditional on user declarations. Never a
 * certificate that physical meaning or simulation outputs are correct. */
export class AdapterVerification {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async publish(uid: string, expected: unknown, comparisonOperationId: string) {
    const fence = DispatchFence.parse(expected);
    Id.parse(comparisonOperationId);
    return this.store.transaction(async (tx) => {
      const state = await requireActiveRevision(tx, uid, fence),
        base = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
      const [
        saved,
        questions,
        review,
        comparison,
        binding,
        rawOp,
        rawTermination,
        prior,
      ] = await tx.getMany([
        `${base}/adapterProposals/current`,
        `${base}/adapterQuestions/current`,
        `${base}/adapterReviews/current`,
        `${base}/baselineComparisons/${comparisonOperationId}`,
        `fidelityExecutions/${comparisonOperationId}`,
        `operations/${comparisonOperationId}`,
        `sandboxTerminations/${comparisonOperationId}`,
        `${base}/adapters/current`,
      ]);
      const proposal = AdapterProposal.parse(saved?.proposal),
        set = QuestionSet.parse(questions?.questionSet),
        request = FidelityRequest.parse(binding?.request),
        operation = Operation.parse(rawOp),
        termination = SandboxTermination.parse(rawTermination);
      const adapterDigest = await sha256(canonicalJson(proposal)),
        questionDigest = await sha256(canonicalJson(set)),
        result = validateFidelityResult(comparison?.result, request),
        resultDigest = await sha256(canonicalJson(result));
      const decisions = z
          .array(z.object({ answer: Answer }))
          .parse((review?.result as { decisions: unknown })?.decisions),
        interpretation = interpretAdapterAnswers(
          proposal,
          set,
          decisions.map((item) => item.answer),
        );
      const [left, right] = await tx.getMany([
        `sourceExecutions/${request.original.sourceOperationId}`,
        `sourceExecutions/${request.adapted.sourceOperationId}`,
      ]);
      const original = SourceExecutionBinding.parse(left),
        adapted = SourceExecutionBinding.parse(right),
        expiresAt = Timestamp.parse(saved?.expiresAt);
      if (
        state.stage !== 'adapting' ||
        saved?.ownerUid !== uid ||
        saved.inputDigest !== fence.inputDigest ||
        saved.adapterDigest !== adapterDigest ||
        Date.parse(expiresAt) <= this.clock().getTime() ||
        questions?.ownerUid !== uid ||
        questions.adapterDigest !== adapterDigest ||
        questions.questionSetDigest !== questionDigest ||
        review?.ownerUid !== uid ||
        review.auditId !== fence.auditId ||
        review.revisionId !== fence.revisionId ||
        review.inputDigest !== fence.inputDigest ||
        review.adapterDigest !== adapterDigest ||
        review.questionSetDigest !== questionDigest ||
        review.resultDigest !== (await sha256(canonicalJson(interpretation))) ||
        canonicalJson(review.result) !== canonicalJson(interpretation) ||
        !interpretation.allDeclaredConfirmed ||
        comparison?.ownerUid !== uid ||
        comparison.auditId !== fence.auditId ||
        comparison.revisionId !== fence.revisionId ||
        comparison.inputDigest !== fence.inputDigest ||
        comparison.operationId !== comparisonOperationId ||
        comparison.resultDigest !== resultDigest ||
        comparison.originalOperationId !== request.original.sourceOperationId ||
        comparison.adaptedOperationId !== request.adapted.sourceOperationId ||
        result.status !== 'matched' ||
        binding?.status !== 'published' ||
        binding.ownerUid !== uid ||
        binding.operationId !== comparisonOperationId ||
        binding.payloadDigest !== (await sha256(canonicalJson(request))) ||
        binding.payloadDigest !== comparison.payloadDigest ||
        request.original.adapterDigest !== adapterDigest ||
        operation.id !== comparisonOperationId ||
        operation.ownerUid !== uid ||
        operation.auditId !== fence.auditId ||
        operation.revisionId !== fence.revisionId ||
        operation.inputDigest !== fence.inputDigest ||
        termination.operationId !== operation.id ||
        termination.ownerUid !== uid ||
        termination.auditId !== fence.auditId ||
        termination.revisionId !== fence.revisionId ||
        termination.inputDigest !== fence.inputDigest ||
        termination.requestDigest !== operation.requestDigest ||
        termination.sandboxId !== binding.sandboxId ||
        termination.sandboxId !== operation.providerHandle ||
        original.extractionProfile !== 'reference_v1' ||
        adapted.extractionProfile !== 'adapter_v1'
      )
        throw new Error(
          'Adapter verification evidence is incomplete or mismatched',
        );
      if (prior) {
        if (
          prior.ownerUid !== uid ||
          prior.adapterDigest !== adapterDigest ||
          prior.comparisonOperationId !== comparisonOperationId ||
          canonicalJson(prior.baseline) !== canonicalJson(result)
        )
          throw new Error('Adapter verification conflict');
        return { status: 'verified' as const, replayed: true };
      }
      tx.set(`${base}/adapters/current`, {
        schemaVersion: '1.0',
        ownerUid: uid,
        auditId: fence.auditId,
        revisionId: fence.revisionId,
        inputDigest: fence.inputDigest,
        proposal,
        adapterDigest,
        baseline: result,
        status: 'verified',
        originalOperationId: request.original.sourceOperationId,
        adaptedOperationId: request.adapted.sourceOperationId,
        comparisonOperationId,
        reviewDigest: review.resultDigest,
        scope: 'conditional_declared_mapping_and_extraction',
        limitations: [
          'Variable meaning, units and axes are user declarations; verification does not prove physical correctness.',
        ],
        createdAt: this.clock(),
        expiresAt: new Date(expiresAt),
      });
      return { status: 'verified' as const, replayed: false };
    });
  }
}
