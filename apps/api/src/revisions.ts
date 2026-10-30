import { z } from 'zod';
import {
  Answer,
  Id,
  QuestionSet,
  SubmitAnswers,
  acceptAnswer,
  CreateRevision,
  ResourcePolicy,
  RevisionReceipt,
  Timestamp,
  UploadEntry,
  preflightUploads,
} from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import {
  authorize,
  nativeTimestamps,
  receiptKey,
  stateFrom,
} from './audit-commands.js';
import { ApiError } from './errors.js';
import { canonicalJson, sha256 } from './hashing.js';

export class RevisionRepository {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async create(
    uid: string,
    auditId: string,
    value: CreateRevision,
    key: string,
  ): Promise<{ receipt: RevisionReceipt; replayed: boolean }> {
    return this.createSuccessor(uid, auditId, value, key);
  }

  async submitAnswers(
    uid: string,
    auditId: string,
    parentRevisionId: string,
    value: SubmitAnswers,
    key: string,
  ) {
    const submission = SubmitAnswers.parse(value);
    return this.createSuccessor(
      uid,
      auditId,
      {
        schemaVersion: '1.0',
        parentRevisionId,
        expectedGeneration: submission.expectedGeneration,
        expectedInputDigest: submission.expectedInputDigest,
        reuseArtifactIds: [],
      },
      key,
      submission,
    );
  }

  async getQuestions(uid: string, auditId: string, revisionId: string) {
    Id.parse(revisionId);
    return this.store.transaction(async (tx) => {
      await authorize(tx, uid, auditId, false);
      const revision = await tx.get(
        `audits/${auditId}/revisions/${revisionId}`,
      );
      const record = await tx.get(
        `audits/${auditId}/revisions/${revisionId}/questions/current`,
      );
      if (!revision || revision.ownerUid !== uid || !record)
        throw new ApiError(404, 'not_found', 'Questions were not found.');
      const questionSet = QuestionSet.parse(record.questionSet);
      if (
        questionSet.auditId !== auditId ||
        questionSet.revisionId !== revisionId ||
        questionSet.inputDigest !== revision.inputDigest
      )
        throw new Error('Question set snapshot mismatch');
      return {
        questionSet,
        questionSetDigest: await sha256(canonicalJson(questionSet)),
      };
    });
  }

  private async createSuccessor(
    uid: string,
    auditId: string,
    value: CreateRevision,
    key: string,
    submission?: SubmitAnswers,
  ): Promise<{ receipt: RevisionReceipt; replayed: boolean }> {
    const input = CreateRevision.parse(value);
    const requestId = await receiptKey(
      uid,
      submission
        ? `POST /audits/${auditId}/revisions/${input.parentRevisionId}/answers`
        : `POST /audits/${auditId}/revisions`,
      key,
    );
    const requestDigest = await sha256(canonicalJson(submission ?? input));
    const revisionId = crypto.randomUUID();
    return this.store.transaction(async (tx) => {
      const audit = await authorize(tx, uid, auditId, false);
      const previous = await tx.get(`requests/${requestId}`);
      if (previous) {
        if (previous.requestDigest !== requestDigest)
          throw new ApiError(
            409,
            'idempotency_conflict',
            'This key was already used with different input.',
          );
        return {
          receipt: RevisionReceipt.parse(previous.result),
          replayed: true,
        };
      }
      if (audit.currentRevisionId !== input.parentRevisionId)
        throw new ApiError(
          409,
          'stale_revision',
          'The parent is no longer the current revision.',
        );
      const parent = await tx.get(
        `audits/${auditId}/revisions/${input.parentRevisionId}`,
      );
      if (!parent || parent.ownerUid !== uid)
        throw new ApiError(404, 'not_found', 'Revision was not found.');
      const state = stateFrom(parent);
      if (
        state.auditId !== auditId ||
        state.revisionId !== input.parentRevisionId
      )
        throw new Error('Stored revision identity mismatch');
      if (
        state.generation !== input.expectedGeneration ||
        state.inputDigest !== input.expectedInputDigest
      )
        throw new ApiError(
          409,
          'stale_revision',
          'The revision changed before this request.',
        );
      if (state.status === 'running' || state.status === 'queued')
        throw new ApiError(
          409,
          'revision_active',
          'Cancel or finish active work before creating a successor.',
        );
      const policy = ResourcePolicy.parse(parent.policy);
      const manifest = z.array(UploadEntry).parse(parent.sourceManifest);
      let answers = z.array(Answer).parse(parent.answers);
      if (
        (await sha256(canonicalJson({ uploads: manifest, answers }))) !==
        state.inputDigest
      )
        throw new Error(
          'Parent input digest does not match its immutable snapshot',
        );
      let interpretations: ReturnType<typeof acceptAnswer>[] = [];
      if (submission) {
        if (state.status !== 'waiting_for_input')
          throw new ApiError(
            409,
            'questions_not_pending',
            'This revision is not waiting for answers.',
          );
        const record = await tx.get(
          `audits/${auditId}/revisions/${input.parentRevisionId}/questions/current`,
        );
        if (!record)
          throw new ApiError(
            409,
            'questions_not_pending',
            'No current questions are available.',
          );
        const questionSet = QuestionSet.parse(record.questionSet);
        if (
          questionSet.auditId !== auditId ||
          questionSet.revisionId !== input.parentRevisionId ||
          questionSet.inputDigest !== state.inputDigest ||
          (await sha256(canonicalJson(questionSet))) !==
            submission.questionSetDigest
        )
          throw new ApiError(
            409,
            'stale_questions',
            'The question set changed before submission.',
          );
        interpretations = submission.answers.map((answer) => {
          const question = questionSet.questions.find(
            (item) => item.id === answer.questionId,
          );
          if (
            !question ||
            (answer.selectedOptionId !== null &&
              !question.options.some(
                (option) => option.id === answer.selectedOptionId,
              ))
          )
            throw new ApiError(
              422,
              'invalid_answer',
              'Answer does not belong to the current question options.',
            );
          return acceptAnswer(question, answer);
        });
        const replacements = new Map(
          submission.answers.map((answer) => [answer.questionId, answer]),
        );
        answers = [
          ...answers.filter((answer) => !replacements.has(answer.questionId)),
          ...submission.answers,
        ];
        // Bound cumulative history in a single revision document. Older answers
        // remain available through immutable parent snapshots.
        if (answers.length > 100)
          throw new ApiError(
            422,
            'answer_limit',
            'The revision answer limit is reached.',
          );
        answers.sort((a, b) => a.questionId.localeCompare(b.questionId));
      }
      const selected: z.infer<typeof UploadEntry>[] = [];
      const now = this.clock();
      for (const id of submission
        ? manifest.map((entry) => entry.artifactId)
        : input.reuseArtifactIds) {
        const entry = manifest.find((item) => item.artifactId === id);
        if (!entry)
          throw new ApiError(
            422,
            'invalid_artifact_reference',
            'Only parent source artifacts can be reused.',
          );
        const artifact = await tx.get(`audits/${auditId}/artifacts/${id}`);
        if (
          !artifact ||
          artifact.ownerUid !== uid ||
          artifact.lifecycle !== 'ready'
        )
          throw new ApiError(
            409,
            'artifact_unavailable',
            'A selected artifact is not ready. Upload it again.',
          );
        const expiresAt = Timestamp.parse(artifact.expiresAt);
        if (Date.parse(expiresAt) <= now.getTime())
          throw new ApiError(
            409,
            'artifact_expired',
            'A selected artifact has expired. Upload it again.',
          );
        if (
          artifact.sha256 !== entry.sha256 ||
          artifact.bytes !== entry.bytes ||
          artifact.path !== entry.path
        )
          throw new Error('Immutable artifact metadata mismatch');
        selected.push(entry);
      }
      selected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      if (selected.length) {
        const check = preflightUploads(selected, policy);
        // Drafts can temporarily contain only supporting data; inspection requires Python source.
        if (check.reasons.some((reason) => reason !== 'python_source_required'))
          throw new ApiError(
            422,
            'invalid_upload_manifest',
            'Reused artifacts exceed the supported upload policy.',
          );
      }
      const inputDigest = await sha256(
        canonicalJson({ uploads: selected, answers }),
      );
      const receipt = RevisionReceipt.parse({
        schemaVersion: '1.0',
        auditId,
        revisionId,
        parentRevisionId: input.parentRevisionId,
        inputDigest,
        stage: 'draft',
        status: 'idle',
      });
      // Copy immutable inputs only. Prior plans, adapter verdicts, evidence and confirmed interpretations stay with the parent.
      tx.set(`audits/${auditId}/revisions/${revisionId}`, {
        ...receipt,
        ownerUid: uid,
        generation: 0,
        sourceManifest: selected,
        answers,
        ...(submission
          ? {
              answerInterpretations: interpretations,
              answeredQuestionSetDigest: submission.questionSetDigest,
            }
          : {}),
        policy,
        cancellationRequestedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      tx.set(
        `audits/${auditId}`,
        nativeTimestamps({
          ...audit,
          currentRevisionId: revisionId,
          updatedAt: now.toISOString(),
        }),
      );
      tx.set(`requests/${requestId}`, {
        schemaVersion: '1.0',
        ownerUid: uid,
        auditId,
        requestDigest,
        result: receipt,
        createdAt: now,
        updatedAt: now,
      });
      return { receipt, replayed: false };
    });
  }
}
