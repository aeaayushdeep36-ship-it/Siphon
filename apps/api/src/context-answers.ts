import { z } from 'zod';
import {
  Answer,
  Id,
  QuestionSet,
  UploadEntry,
  Digest,
} from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import { authorize, DispatchFence, stateFrom } from './audit-commands.js';
import { assertFence } from './lifecycle.js';
import { canonicalJson, sha256 } from './hashing.js';
import {
  buildContextQuestions,
  interpretContextAnswers,
  unresolvedContextQuestions,
} from './context-questions.js';

const SourceManifest = z.array(UploadEntry).max(10);
const Basis = z.object({
  schemaVersion: z.literal('1.0'),
  auditId: Id,
  revisionId: Id,
  inputDigest: Digest,
  sourceManifestDigest: Digest,
  questionBasis: QuestionSet,
});

/** Resolve raw option declarations only on answer-derived successor drafts.
 * Nothing from an earlier adapter, plan, AI interpretation or numerical verdict
 * is carried forward. Custom text still requires semantic reconciliation.
 */
export class ContextAnswerResolver {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async resolve(uid: string, expected: unknown) {
    const fence = DispatchFence.parse(expected);
    return this.store.transaction(async (tx) => {
      const audit = await authorize(tx, uid, fence.auditId, false);
      const path = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
      const revision = await tx.get(path);
      if (
        !revision ||
        revision.ownerUid !== uid ||
        audit.currentRevisionId !== fence.revisionId
      )
        throw new Error('Context answer revision is unavailable');
      const state = stateFrom(revision);
      assertFence(state, fence);
      if (
        state.status !== 'idle' ||
        state.stage !== 'draft' ||
        revision.cancellationRequestedAt !== null
      )
        throw new Error('Context answers require the current successor draft');
      const parentId = Id.parse(revision.parentRevisionId);
      const parentPath = `audits/${fence.auditId}/revisions/${parentId}`;
      const parent = await tx.get(parentPath);
      const pending = await tx.get(`${parentPath}/questions/current`);
      const priorResolution = await tx.get(
        `${parentPath}/contextAnswerResolution/current`,
      );
      const existing = await tx.get(`${path}/contextAnswerResolution/current`);
      if (!parent || parent.ownerUid !== uid || !pending)
        throw new Error('Context question provenance is missing');
      const parentState = stateFrom(parent);
      if (
        parentState.auditId !== fence.auditId ||
        parentState.revisionId !== parentId ||
        parentState.status !== 'waiting_for_input'
      )
        throw new Error('Parent revision is not a pending question snapshot');
      const parentQuestions = QuestionSet.parse(pending.questionSet);
      if (
        parentQuestions.auditId !== fence.auditId ||
        parentQuestions.revisionId !== parentId ||
        parentQuestions.inputDigest !== parentState.inputDigest ||
        (await sha256(canonicalJson(parentQuestions))) !==
          Digest.parse(revision.answeredQuestionSetDigest)
      )
        throw new Error('Answered question snapshot mismatch');
      const manifest = SourceManifest.parse(revision.sourceManifest);
      const parentManifest = SourceManifest.parse(parent.sourceManifest);
      const sourceManifestDigest = await sha256(canonicalJson(manifest));
      if (
        sourceManifestDigest !== (await sha256(canonicalJson(parentManifest)))
      )
        throw new Error('Source changes require fresh context review');
      const answers = z.array(Answer).max(100).parse(revision.answers);
      if (
        (await sha256(canonicalJson({ uploads: manifest, answers }))) !==
        state.inputDigest
      )
        throw new Error('Successor input snapshot mismatch');
      let basis = parentQuestions;
      if (priorResolution) {
        const inherited = Basis.parse(priorResolution);
        if (
          inherited.auditId !== fence.auditId ||
          inherited.revisionId !== parentId ||
          inherited.inputDigest !== parentState.inputDigest ||
          inherited.sourceManifestDigest !== sourceManifestDigest
        )
          throw new Error('Context declaration provenance mismatch');
        basis = inherited.questionBasis;
      }
      const reviewed = buildContextQuestions({
        ...fence,
        domain: audit.domain,
      });
      const definitions = (set: typeof basis) =>
        set.questions.map((q) => ({ ...q, id: null }));
      if (
        canonicalJson(definitions(basis)) !==
          canonicalJson(definitions(reviewed)) ||
        parentQuestions.questions.some(
          (question) =>
            !basis.questions.some(
              (original) => canonicalJson(question) === canonicalJson(original),
            ),
        )
      )
        throw new Error('Context question definitions changed');
      const relevant = answers.filter((answer) =>
        basis.questions.some((q) => q.id === answer.questionId),
      );
      const declarations = interpretContextAnswers(
        audit.domain,
        basis,
        relevant,
      );
      const unresolved = unresolvedContextQuestions(
        audit.domain,
        basis,
        relevant,
      );
      const questionDraft = unresolved
        ? QuestionSet.parse({
            ...unresolved,
            auditId: fence.auditId,
            revisionId: fence.revisionId,
            inputDigest: fence.inputDigest,
          })
        : null;
      const resolution = {
        schemaVersion: '1.0',
        auditId: fence.auditId,
        revisionId: fence.revisionId,
        parentRevisionId: parentId,
        inputDigest: fence.inputDigest,
        sourceManifestDigest,
        questionBasis: basis,
        declarations,
        questionDraft,
        allUserDeclarationsResolved: questionDraft === null,
      };
      const resolutionDigest = await sha256(canonicalJson(resolution));
      if (existing) {
        if (existing.resolutionDigest !== resolutionDigest)
          throw new Error('Context answer resolution is immutable');
        return { ...resolution, resolutionDigest, replayed: true };
      }
      const now = this.clock();
      tx.set(`${path}/contextAnswerResolution/current`, {
        ...resolution,
        ownerUid: uid,
        resolutionDigest,
        createdAt: now,
        updatedAt: now,
      });
      return { ...resolution, resolutionDigest, replayed: false };
    });
  }
}
