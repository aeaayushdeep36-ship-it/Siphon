import {
  AdapterProposal,
  Answer,
  BaselineComparison,
  ContextProposal,
  Id,
  ObservationValidationResult,
  QuestionSet,
  Timestamp,
} from '@siphon/contracts';
import { z } from 'zod';
import { type DocumentStore } from './firestore.js';
import {
  authorize,
  DispatchFence,
  requireActiveRevision,
} from './audit-commands.js';
import { FidelityRequest, validateFidelityResult } from './fidelity-runner.js';
import { buildScientificEligibility } from './scientific-context.js';
import { assessEligibility } from './eligibility.js';
import { canonicalJson, sha256 } from './hashing.js';

/** Read the current, server-produced evidence before calculating eligibility.
 * This does not reserve compute, certify a physical model, or start a run. */
export class ScientificEligibilityStage {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async assess(uid: string, expected: unknown) {
    const fence = DispatchFence.parse(expected),
      base = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
    return this.store.transaction(async (tx) => {
      const audit = await authorize(tx, uid, fence.auditId, false),
        state = await requireActiveRevision(tx, uid, fence);
      const [
        revision,
        context,
        resolution,
        verified,
        prior,
        scienceQuestions,
        plan,
      ] = await tx.getMany([
        base,
        `${base}/context/current`,
        `${base}/contextAnswerResolution/current`,
        `${base}/adapters/current`,
        `${base}/eligibility/current`,
        `${base}/scientificQuestions/current`,
        `${base}/plans/current`,
      ]);
      if (
        state.stage !== 'adapting' ||
        !revision ||
        !context ||
        !resolution ||
        !verified
      )
        throw new Error('Scientific prerequisites are not available');
      const proposal = ContextProposal.parse(context.proposal),
        adapter = AdapterProposal.parse(verified.proposal),
        basis = QuestionSet.parse(resolution.questionBasis),
        answers = z.array(Answer).max(100).parse(revision.answers);
      const contextDigest = await sha256(canonicalJson(proposal)),
        adapterDigest = await sha256(canonicalJson(adapter));
      const resolutionCore = Object.fromEntries(
        Object.entries(resolution).filter(
          ([key]) =>
            ![
              'ownerUid',
              'resolutionDigest',
              'createdAt',
              'updatedAt',
            ].includes(key),
        ),
      );
      const parentRevisionId = Id.parse(resolution.parentRevisionId);
      const [parent, parentQuestions] = await tx.getMany([
        `audits/${fence.auditId}/revisions/${parentRevisionId}`,
        `audits/${fence.auditId}/revisions/${parentRevisionId}/questions/current`,
      ]);
      const answeredQuestions = QuestionSet.parse(parentQuestions?.questionSet);
      if (
        revision.parentRevisionId !== parentRevisionId ||
        parent?.ownerUid !== uid ||
        parent.auditId !== fence.auditId ||
        parent.revisionId !== parentRevisionId ||
        parentQuestions?.ownerUid !== uid ||
        answeredQuestions.auditId !== fence.auditId ||
        answeredQuestions.revisionId !== parentRevisionId ||
        answeredQuestions.inputDigest !== parent.inputDigest ||
        revision.answeredQuestionSetDigest !==
          (await sha256(canonicalJson(answeredQuestions))) ||
        answeredQuestions.questions.some(
          (question) =>
            !basis.questions.some(
              (original) => canonicalJson(original) === canonicalJson(question),
            ),
        ) ||
        (await sha256(canonicalJson(parent.sourceManifest))) !==
          resolution.sourceManifestDigest ||
        (await sha256(
          canonicalJson({ uploads: revision.sourceManifest, answers }),
        )) !== fence.inputDigest
      )
        throw new Error('Scientific declaration parent provenance changed');
      if (
        context.ownerUid !== uid ||
        context.inputDigest !== fence.inputDigest ||
        context.proposalDigest !== contextDigest ||
        proposal.domain !== audit.domain ||
        resolution.ownerUid !== uid ||
        resolution.auditId !== fence.auditId ||
        resolution.revisionId !== fence.revisionId ||
        resolution.inputDigest !== fence.inputDigest ||
        resolution.resolutionDigest !==
          (await sha256(canonicalJson(resolutionCore))) ||
        resolution.sourceManifestDigest !==
          (await sha256(canonicalJson(revision.sourceManifest))) ||
        resolution.allUserDeclarationsResolved !== true ||
        resolution.questionDraft !== null ||
        verified.ownerUid !== uid ||
        verified.auditId !== fence.auditId ||
        verified.revisionId !== fence.revisionId ||
        verified.inputDigest !== fence.inputDigest ||
        verified.status !== 'verified' ||
        verified.scope !== 'conditional_declared_mapping_and_extraction' ||
        verified.adapterDigest !== adapterDigest ||
        adapter.contextDigest !== contextDigest ||
        Date.parse(Timestamp.parse(verified.expiresAt)) <=
          this.clock().getTime()
      )
        throw new Error('Scientific prerequisite provenance changed');
      const comparisonId = Id.parse(verified.comparisonOperationId),
        [comparison, binding] = await tx.getMany([
          `${base}/baselineComparisons/${comparisonId}`,
          `fidelityExecutions/${comparisonId}`,
        ]);
      const request = FidelityRequest.parse(binding?.request),
        baseline = validateFidelityResult(comparison?.result, request);
      if (
        binding?.status !== 'published' ||
        binding.ownerUid !== uid ||
        binding.operationId !== comparisonId ||
        binding.payloadDigest !== (await sha256(canonicalJson(request))) ||
        comparison?.ownerUid !== uid ||
        comparison.auditId !== fence.auditId ||
        comparison.revisionId !== fence.revisionId ||
        comparison.inputDigest !== fence.inputDigest ||
        comparison.operationId !== comparisonId ||
        comparison.payloadDigest !== binding.payloadDigest ||
        comparison.resultDigest !== (await sha256(canonicalJson(baseline))) ||
        canonicalJson(BaselineComparison.parse(verified.baseline)) !==
          canonicalJson(baseline) ||
        baseline.status !== 'matched' ||
        request.original.adapterDigest !== adapterDigest ||
        verified.originalOperationId !== request.original.sourceOperationId ||
        verified.adaptedOperationId !== request.adapted.sourceOperationId
      )
        throw new Error('Scientific baseline provenance changed');
      const [left, right] = await tx.getMany([
        `${base}/numericValidations/${request.original.evaluationOperationId}`,
        `${base}/numericValidations/${request.adapted.evaluationOperationId}`,
      ]);
      const original = ObservationValidationResult.parse(left?.report),
        adapted = ObservationValidationResult.parse(right?.report);
      for (const [record, report, job] of [
        [left, original, request.original],
        [right, adapted, request.adapted],
      ] as const) {
        if (
          record?.ownerUid !== uid ||
          record.auditId !== fence.auditId ||
          record.revisionId !== fence.revisionId ||
          record.inputDigest !== fence.inputDigest ||
          record.operationId !== job.evaluationOperationId ||
          record.sourceOperationId !== job.sourceOperationId ||
          record.reportDigest !== (await sha256(canonicalJson(report))) ||
          Date.parse(Timestamp.parse(record.expiresAt)) <=
            this.clock().getTime()
        )
          throw new Error('Scientific numeric evidence changed');
      }
      const scienceSet = scienceQuestions
        ? QuestionSet.parse(scienceQuestions.questionSet)
        : null;
      const scienceAnswer = scienceQuestions?.answer
        ? Answer.parse(scienceQuestions.answer)
        : null;
      if (
        scienceQuestions &&
        (scienceQuestions.ownerUid !== uid ||
          scienceQuestions.auditId !== fence.auditId ||
          scienceQuestions.revisionId !== fence.revisionId ||
          scienceQuestions.inputDigest !== fence.inputDigest ||
          scienceQuestions.adapterDigest !== adapterDigest ||
          scienceQuestions.questionSetDigest !==
            (await sha256(canonicalJson(scienceSet))))
      )
        throw new Error('Scientific question provenance changed');
      const assessmentInput = buildScientificEligibility({
        snapshot: {
          auditId: fence.auditId,
          revisionId: fence.revisionId,
          inputDigest: fence.inputDigest,
          domain: audit.domain,
          contextDigest,
          adapterDigest,
        },
        questionBasis: basis,
        answers: answers.filter((answer) =>
          basis.questions.some((question) => question.id === answer.questionId),
        ),
        declarationEvidenceId: parentRevisionId,
        adapter,
        adapterVerification: {
          status: 'verified',
          scope: verified.scope,
          adapterDigest,
          comparisonOperationId: comparisonId,
          originalOperationId: request.original.sourceOperationId,
          adaptedOperationId: request.adapted.sourceOperationId,
          reviewDigest: verified.reviewDigest,
        },
        baseline: {
          comparison: baseline,
          original,
          adapted,
          evidenceId: comparisonId,
        },
        geometryQuestions:
          audit.domain === 'heat_diffusion' ? scienceSet : null,
        geometryAnswers:
          audit.domain === 'heat_diffusion' && scienceAnswer
            ? [scienceAnswer]
            : [],
        coordinatesQuestions:
          audit.domain === 'orbital_dynamics' ? scienceSet : null,
        coordinatesAnswers:
          audit.domain === 'orbital_dynamics' && scienceAnswer
            ? [scienceAnswer]
            : [],
      });
      const assessment = assessEligibility(assessmentInput);
      const assessmentDigest = await sha256(canonicalJson(assessment));
      if (prior) {
        if (
          prior.ownerUid !== uid ||
          prior.inputDigest !== fence.inputDigest ||
          prior.assessmentDigest !==
            (await sha256(canonicalJson(prior.assessment)))
        )
          throw new Error('Scientific eligibility snapshot changed');
        if (prior.assessmentDigest === assessmentDigest)
          return {
            schemaVersion: '1.0' as const,
            assessment,
            assessmentInput,
            assessmentDigest,
            replayed: true,
          };
        if (plan)
          throw new Error('Published plan prevents eligibility changes');
        tx.set(
          `${base}/eligibilityHistory/${String(prior.assessmentDigest)}`,
          prior,
        );
      }
      tx.set(`${base}/eligibility/current`, {
        schemaVersion: '1.0',
        ownerUid: uid,
        auditId: fence.auditId,
        revisionId: fence.revisionId,
        inputDigest: fence.inputDigest,
        assessment,
        assessmentDigest,
        createdAt: this.clock(),
        expiresAt: new Date(Timestamp.parse(verified.expiresAt)),
      });
      return {
        schemaVersion: '1.0' as const,
        assessment,
        assessmentInput,
        assessmentDigest,
        replayed: false,
      };
    });
  }
}
