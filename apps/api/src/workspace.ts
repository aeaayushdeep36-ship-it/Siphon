import {
  AuditPlan,
  AdapterProposal,
  AuditWorkspace,
  ContextProposal,
  Id,
  InspectionGate,
  UploadEntry,
  Timestamp,
  QuestionSet,
} from '@siphon/contracts';
import { z } from 'zod';
import { type DocumentStore } from './firestore.js';
import {
  authorize,
  stateFrom,
  requireActiveRevision,
} from './audit-commands.js';
import { canonicalJson, sha256 } from './hashing.js';
import { ApiError } from './errors.js';
import { interpretAdapterAnswers } from './adapter-questions.js';
import { Answer, Digest, Count } from '@siphon/contracts';
import { ScientificQuestions } from './scientific-questions.js';
import { ScientificEligibilityStage } from './scientific-eligibility-stage.js';

export const SubmitAdapterReview = z.strictObject({
  schemaVersion: z.literal('1.0'),
  expectedGeneration: Count,
  expectedInputDigest: Digest,
  adapterDigest: Digest,
  questionSetDigest: Digest,
  answers: z.array(Answer).min(1).max(10),
});
export const SubmitScientificAnswer = z.strictObject({
  schemaVersion: z.literal('1.0'),
  expectedGeneration: Count,
  expectedInputDigest: Digest,
  questionSetDigest: Digest,
  answer: Answer,
});

/** Explicit display snapshot; never exposes private execution/configuration records. */
export class WorkspaceRepository {
  constructor(
    private readonly documents: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async submitScientificAnswer(
    uid: string,
    auditId: string,
    revisionId: string,
    value: unknown,
  ) {
    Id.parse(auditId);
    Id.parse(revisionId);
    const input = SubmitScientificAnswer.parse(value);
    const fence = {
      auditId,
      revisionId,
      inputDigest: input.expectedInputDigest,
      generation: input.expectedGeneration,
    };
    const saved = await new ScientificQuestions(
      this.documents,
      this.clock,
    ).submit(uid, fence, input.questionSetDigest, input.answer);
    // Replays allow recovery if the answer committed but assessment did not.
    const assessment = await new ScientificEligibilityStage(
      this.documents,
      this.clock,
    ).assess(uid, fence);
    return { ...saved, assessmentDigest: assessment.assessmentDigest };
  }
  async submitAdapterReview(
    uid: string,
    auditId: string,
    revisionId: string,
    value: unknown,
  ) {
    Id.parse(auditId);
    Id.parse(revisionId);
    const input = SubmitAdapterReview.parse(value),
      fence = {
        auditId,
        revisionId,
        inputDigest: input.expectedInputDigest,
        generation: input.expectedGeneration,
      },
      base = `audits/${auditId}/revisions/${revisionId}`;
    return this.documents.transaction(async (tx) => {
      const state = await requireActiveRevision(tx, uid, fence);
      const [saved, questions, prior] = await tx.getMany([
        `${base}/adapterProposals/current`,
        `${base}/adapterQuestions/current`,
        `${base}/adapterReviews/current`,
      ]);
      if (
        state.stage !== 'adapting' ||
        saved?.ownerUid !== uid ||
        saved.inputDigest !== fence.inputDigest ||
        saved.adapterDigest !== input.adapterDigest ||
        questions?.ownerUid !== uid ||
        questions.inputDigest !== fence.inputDigest ||
        questions.adapterDigest !== input.adapterDigest ||
        questions.questionSetDigest !== input.questionSetDigest
      )
        throw new Error('Adapter review snapshot changed');
      const proposal = AdapterProposal.parse(saved.proposal),
        set = QuestionSet.parse(questions.questionSet);
      if (
        (await sha256(canonicalJson(proposal))) !== input.adapterDigest ||
        (await sha256(canonicalJson(set))) !== input.questionSetDigest
      )
        throw new Error('Adapter review integrity mismatch');
      const result = interpretAdapterAnswers(proposal, set, input.answers);
      if (result.decisions.some((decision) => decision.answer === null))
        throw new Error('Answer every adapter question');
      const digest = await sha256(canonicalJson(result));
      if (prior) {
        if (
          prior.ownerUid !== uid ||
          prior.adapterDigest !== input.adapterDigest ||
          prior.questionSetDigest !== input.questionSetDigest ||
          prior.resultDigest !== digest
        )
          throw new Error('Adapter review is immutable');
        return {
          schemaVersion: '1.0' as const,
          resultDigest: digest,
          allDeclaredConfirmed: result.allDeclaredConfirmed,
          replayed: true,
        };
      }
      tx.set(`${base}/adapterReviews/current`, {
        schemaVersion: '1.0',
        ownerUid: uid,
        auditId,
        revisionId,
        inputDigest: fence.inputDigest,
        adapterDigest: input.adapterDigest,
        questionSetDigest: input.questionSetDigest,
        result,
        resultDigest: digest,
        createdAt: new Date(),
      });
      return {
        schemaVersion: '1.0' as const,
        resultDigest: digest,
        allDeclaredConfirmed: result.allDeclaredConfirmed,
        replayed: false,
      };
    });
  }
  async get(uid: string, auditId: string, revisionId: string) {
    Id.parse(auditId);
    Id.parse(revisionId);
    return this.documents.transaction(async (tx) => {
      const audit = await authorize(tx, uid, auditId, false);
      const base = `audits/${auditId}/revisions/${revisionId}`;
      const [
        revision,
        inspection,
        context,
        savedPlan,
        savedAdapter,
        savedQuestions,
        savedReview,
        scienceRecord,
      ] = await tx.getMany([
        base,
        `${base}/inspection/current`,
        `${base}/context/current`,
        `${base}/plans/current`,
        `${base}/adapterProposals/current`,
        `${base}/adapterQuestions/current`,
        `${base}/adapterReviews/current`,
        `${base}/scientificQuestions/current`,
      ]);
      if (
        !revision ||
        revision.ownerUid !== uid ||
        revision.auditId !== auditId ||
        revision.revisionId !== revisionId
      )
        throw new ApiError(404, 'not_found', 'Revision was not found.');
      const state = stateFrom(revision),
        uploads = z.array(UploadEntry).max(10).parse(revision.sourceManifest);
      const artifacts = await tx.getMany(
        uploads.map((item) => `audits/${auditId}/artifacts/${item.artifactId}`),
      );
      let readiness = null,
        proposal = null,
        plan = null;
      if (inspection) {
        if (
          inspection.ownerUid !== uid ||
          inspection.inputDigest !== state.inputDigest
        )
          throw new Error('Inspection display snapshot mismatch');
        readiness = InspectionGate.parse(inspection.gate);
        if (
          readiness.sourceDigests.length !==
            uploads.filter((item) => item.path.endsWith('.py')).length ||
          readiness.sourceDigests.some(
            (item) =>
              !uploads.some(
                (upload) =>
                  upload.artifactId === item.artifactId &&
                  upload.sha256 === item.sha256,
              ),
          )
        )
          throw new Error('Inspection source manifest mismatch');
      }
      if (context) {
        proposal = ContextProposal.parse(context.proposal);
        if (
          context.ownerUid !== uid ||
          proposal.domain !== audit.domain ||
          context.proposalDigest !== (await sha256(canonicalJson(proposal)))
        )
          throw new Error('Context display integrity failure');
      }
      if (savedPlan) {
        plan = AuditPlan.parse(savedPlan.plan);
        if (
          savedPlan.ownerUid !== uid ||
          savedPlan.planDigest !== (await sha256(canonicalJson(plan)))
        )
          throw new Error('Plan display integrity failure');
      }
      let adapterProposal = null;
      if (savedAdapter) {
        adapterProposal = AdapterProposal.parse(savedAdapter.proposal);
        if (
          savedAdapter.ownerUid !== uid ||
          savedAdapter.inputDigest !== state.inputDigest ||
          savedAdapter.adapterDigest !==
            (await sha256(canonicalJson(adapterProposal))) ||
          adapterProposal.domain !== audit.domain ||
          adapterProposal.contextDigest !== context?.proposalDigest
        )
          throw new Error('Adapter display integrity failure');
      }
      let adapterQuestions = null;
      if (savedQuestions) {
        adapterQuestions = QuestionSet.parse(savedQuestions.questionSet);
        if (
          !adapterProposal ||
          savedQuestions.ownerUid !== uid ||
          savedQuestions.auditId !== auditId ||
          savedQuestions.revisionId !== revisionId ||
          savedQuestions.inputDigest !== state.inputDigest ||
          savedQuestions.adapterDigest !== savedAdapter?.adapterDigest ||
          savedQuestions.questionSetDigest !==
            (await sha256(canonicalJson(adapterQuestions)))
        )
          throw new Error('Adapter question display integrity failure');
        interpretAdapterAnswers(adapterProposal, adapterQuestions, []);
      }
      let adapterReview = null;
      if (savedReview) {
        if (
          !adapterProposal ||
          !adapterQuestions ||
          savedReview.ownerUid !== uid ||
          savedReview.inputDigest !== state.inputDigest ||
          savedReview.adapterDigest !== savedAdapter?.adapterDigest ||
          savedReview.questionSetDigest !== savedQuestions?.questionSetDigest ||
          savedReview.resultDigest !==
            (await sha256(canonicalJson(savedReview.result)))
        )
          throw new Error('Adapter review display integrity failure');
        const decisions = z
          .array(z.object({ answer: Answer }))
          .parse((savedReview.result as { decisions: unknown }).decisions);
        const resolved = interpretAdapterAnswers(
          adapterProposal,
          adapterQuestions,
          decisions.map((item) => item.answer),
        );
        if (canonicalJson(resolved) !== canonicalJson(savedReview.result))
          throw new Error('Adapter review content mismatch');
        adapterReview = {
          resultDigest: Digest.parse(savedReview.resultDigest),
          allDeclaredConfirmed: resolved.allDeclaredConfirmed,
        };
      }
      let scientificQuestions = null;
      if (scienceRecord) {
        const questionSet = QuestionSet.parse(scienceRecord.questionSet),
          questionSetDigest = Digest.parse(scienceRecord.questionSetDigest),
          answer =
            scienceRecord.answer === null
              ? null
              : Answer.parse(scienceRecord.answer);
        if (
          scienceRecord.ownerUid !== uid ||
          scienceRecord.auditId !== auditId ||
          scienceRecord.revisionId !== revisionId ||
          scienceRecord.inputDigest !== state.inputDigest ||
          scienceRecord.adapterDigest !== savedAdapter?.adapterDigest ||
          questionSetDigest !== (await sha256(canonicalJson(questionSet))) ||
          (answer && answer.questionId !== questionSet.questions[0]?.id)
        )
          throw new Error('Scientific question display integrity failure');
        scientificQuestions = { questionSet, questionSetDigest, answer };
      }
      return AuditWorkspace.parse({
        schemaVersion: '1.0',
        auditId,
        revisionId,
        generation: state.generation,
        inputDigest: state.inputDigest,
        stage: state.stage,
        status: state.status,
        uploads,
        readiness,
        context: proposal,
        adapterProposal,
        adapterQuestions,
        adapterDigest: savedAdapter
          ? Digest.parse(savedAdapter.adapterDigest)
          : null,
        adapterQuestionSetDigest: savedQuestions
          ? Digest.parse(savedQuestions.questionSetDigest)
          : null,
        adapterReview,
        scientificQuestions,
        plan,
        operationalIssues: revision.operationalIssues ?? [],
        uploadStates: uploads.map((upload, index) => {
          const artifact = artifacts[index];
          if (
            artifact &&
            (artifact.ownerUid !== uid ||
              artifact.auditId !== auditId ||
              artifact.artifactId !== upload.artifactId ||
              artifact.sha256 !== upload.sha256 ||
              artifact.bytes !== upload.bytes)
          )
            throw new Error('Workspace artifact mismatch');
          return {
            artifactId: upload.artifactId,
            lifecycle: artifact?.lifecycle ?? 'missing',
            expiresAt: artifact ? Timestamp.parse(artifact.expiresAt) : null,
          };
        }),
      });
    });
  }
}
