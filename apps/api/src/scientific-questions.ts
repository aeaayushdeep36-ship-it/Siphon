import {
  AdapterProposal,
  Answer,
  ContextProposal,
  QuestionSet,
} from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import {
  authorize,
  DispatchFence,
  requireActiveRevision,
  nativeTimestamps,
} from './audit-commands.js';
import {
  buildOrbitalCoordinatesQuestions,
  buildThermalGeometryQuestions,
} from './scientific-context.js';
import { canonicalJson, sha256 } from './hashing.js';

/** Immutable, owner-bound declarations. Custom answers remain unresolved until
 * reconciled; a declaration is never proof of physical correctness. */
export class ScientificQuestions {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async prepare(uid: string, expected: unknown) {
    const fence = DispatchFence.parse(expected),
      base = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
    return this.store.transaction(async (tx) => {
      const audit = await authorize(tx, uid, fence.auditId, false),
        state = await requireActiveRevision(tx, uid, fence);
      const [rawAdapter, rawContext, prior] = await tx.getMany([
        `${base}/adapters/current`,
        `${base}/context/current`,
        `${base}/scientificQuestions/current`,
      ]);
      const adapter = AdapterProposal.parse(rawAdapter?.proposal),
        context = ContextProposal.parse(rawContext?.proposal),
        adapterDigest = await sha256(canonicalJson(adapter)),
        contextDigest = await sha256(canonicalJson(context));
      if (
        state.stage !== 'adapting' ||
        rawAdapter?.ownerUid !== uid ||
        rawAdapter.inputDigest !== fence.inputDigest ||
        rawAdapter.status !== 'verified' ||
        rawAdapter.adapterDigest !== adapterDigest ||
        rawContext?.ownerUid !== uid ||
        rawContext.inputDigest !== fence.inputDigest ||
        rawContext.proposalDigest !== contextDigest ||
        adapter.contextDigest !== contextDigest ||
        adapter.domain !== audit.domain ||
        context.domain !== audit.domain
      )
        throw new Error('Scientific question prerequisites changed');
      const snapshot = {
        auditId: fence.auditId,
        revisionId: fence.revisionId,
        inputDigest: fence.inputDigest,
        domain: audit.domain,
        contextDigest,
        adapterDigest,
      };
      const expectedSet =
        audit.domain === 'heat_diffusion'
          ? buildThermalGeometryQuestions(snapshot)
          : buildOrbitalCoordinatesQuestions(snapshot);
      if (prior) {
        const set = QuestionSet.parse(prior.questionSet);
        if (
          prior.ownerUid !== uid ||
          prior.auditId !== fence.auditId ||
          prior.revisionId !== fence.revisionId ||
          prior.inputDigest !== fence.inputDigest ||
          set.auditId !== fence.auditId ||
          set.revisionId !== fence.revisionId ||
          set.inputDigest !== fence.inputDigest ||
          prior.adapterDigest !== adapterDigest ||
          prior.questionSetDigest !== (await sha256(canonicalJson(set))) ||
          canonicalJson({ ...set.questions[0], id: null }) !==
            canonicalJson({ ...expectedSet.questions[0], id: null })
        )
          throw new Error('Scientific question snapshot changed');
        return {
          questionSet: set,
          questionSetDigest: String(prior.questionSetDigest),
          replayed: true,
        };
      }
      const questionSetDigest = await sha256(canonicalJson(expectedSet));
      tx.set(`${base}/scientificQuestions/current`, {
        schemaVersion: '1.0',
        ownerUid: uid,
        ...fence,
        adapterDigest,
        questionSet: expectedSet,
        questionSetDigest,
        answer: null,
        createdAt: this.clock(),
      });
      return { questionSet: expectedSet, questionSetDigest, replayed: false };
    });
  }
  async submit(
    uid: string,
    expected: unknown,
    questionSetDigest: string,
    value: unknown,
  ) {
    const fence = DispatchFence.parse(expected),
      answer = Answer.parse(value),
      base = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
    return this.store.transaction(async (tx) => {
      const audit = await authorize(tx, uid, fence.auditId, false),
        state = await requireActiveRevision(tx, uid, fence);
      const [saved, adapterRecord, contextRecord, plan] = await tx.getMany([
        `${base}/scientificQuestions/current`,
        `${base}/adapters/current`,
        `${base}/context/current`,
        `${base}/plans/current`,
      ]);
      const set = QuestionSet.parse(saved?.questionSet),
        adapter = AdapterProposal.parse(adapterRecord?.proposal),
        context = ContextProposal.parse(contextRecord?.proposal),
        adapterDigest = await sha256(canonicalJson(adapter)),
        contextDigest = await sha256(canonicalJson(context));
      const snapshot = {
        auditId: fence.auditId,
        revisionId: fence.revisionId,
        inputDigest: fence.inputDigest,
        domain: audit.domain,
        contextDigest,
        adapterDigest,
      };
      const expectedSet =
          audit.domain === 'heat_diffusion'
            ? buildThermalGeometryQuestions(snapshot)
            : buildOrbitalCoordinatesQuestions(snapshot),
        question = set.questions[0];
      if (
        state.stage !== 'adapting' ||
        plan ||
        saved?.ownerUid !== uid ||
        saved.auditId !== fence.auditId ||
        saved.revisionId !== fence.revisionId ||
        saved.inputDigest !== fence.inputDigest ||
        set.auditId !== fence.auditId ||
        set.revisionId !== fence.revisionId ||
        set.inputDigest !== fence.inputDigest ||
        saved.adapterDigest !== adapterDigest ||
        saved.questionSetDigest !== questionSetDigest ||
        questionSetDigest !== (await sha256(canonicalJson(set))) ||
        adapterRecord?.ownerUid !== uid ||
        adapterRecord.status !== 'verified' ||
        adapterRecord.inputDigest !== fence.inputDigest ||
        adapterRecord.adapterDigest !== adapterDigest ||
        contextRecord?.ownerUid !== uid ||
        contextRecord.inputDigest !== fence.inputDigest ||
        contextRecord.proposalDigest !== contextDigest ||
        adapter.contextDigest !== contextDigest ||
        set.questions.length !== 1 ||
        canonicalJson({ ...question, id: null }) !==
          canonicalJson({ ...expectedSet.questions[0], id: null }) ||
        answer.questionId !== question?.id ||
        (answer.selectedOptionId !== null &&
          !question.options.some(
            (option) => option.id === answer.selectedOptionId,
          ))
      )
        throw new Error('Scientific answer snapshot changed');
      if (saved.answer !== null) {
        if (canonicalJson(Answer.parse(saved.answer)) !== canonicalJson(answer))
          throw new Error('Scientific answer is immutable');
        return { replayed: true };
      }
      tx.set(
        `${base}/scientificQuestions/current`,
        nativeTimestamps({
          ...saved,
          answer,
          updatedAt: this.clock(),
        }),
      );
      return { replayed: false };
    });
  }
}
