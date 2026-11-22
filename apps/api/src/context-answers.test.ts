import { describe, expect, it } from 'vitest';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { RevisionRepository } from './revisions.js';
import { QuestionPublisher } from './question-publication.js';
import { buildContextQuestions } from './context-questions.js';
import { ContextAnswerResolver } from './context-answers.js';
import { sha256, canonicalJson } from './hashing.js';
import { type SubmitAnswers } from '@siphon/contracts';

async function setup() {
  const docs = new TestDocuments();
  docs.documents.set('testers/alice', { active: true });
  const { audit } = await new FirestoreAuditRepository(docs).create(
    'alice',
    {
      schemaVersion: '1.0',
      title: 'Answer continuation',
      domain: 'heat_diffusion',
    },
    'create',
  );
  const path = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
  const revision = docs.documents.get(path)!;
  const artifactId = crypto.randomUUID();
  const file = {
    schemaVersion: '1.0',
    artifactId,
    path: 'fixture.py',
    bytes: 0,
    sha256: await sha256(''),
  };
  const inputDigest = await sha256(
    canonicalJson({ uploads: [file], answers: [] }),
  );
  Object.assign(revision, {
    stage: 'inspecting',
    status: 'running',
    sourceManifest: [file],
    inputDigest,
  });
  docs.documents.set(`audits/${audit.id}/artifacts/${artifactId}`, {
    ...file,
    ownerUid: 'alice',
    lifecycle: 'ready',
    expiresAt: '2099-01-01T00:00:00Z',
  });
  const questions = buildContextQuestions({
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest,
    domain: 'heat_diffusion',
  });
  const publisher = new QuestionPublisher(docs);
  const revisions = new RevisionRepository(docs);
  const resolver = new ContextAnswerResolver(docs);
  async function publish(set: typeof questions) {
    const record = docs.documents.get(
      `audits/${set.auditId}/revisions/${set.revisionId}`,
    )!;
    Object.assign(record, { stage: 'inspecting', status: 'running' });
    await publisher.publish(
      'alice',
      {
        auditId: set.auditId,
        revisionId: set.revisionId,
        generation: Number(record.generation),
        inputDigest: set.inputDigest,
      },
      set,
      crypto.randomUUID(),
    );
  }
  async function submit(
    set: typeof questions,
    answers: SubmitAnswers['answers'],
  ) {
    const record = docs.documents.get(
      `audits/${set.auditId}/revisions/${set.revisionId}`,
    )!;
    const { receipt } = await revisions.submitAnswers(
      'alice',
      audit.id,
      set.revisionId,
      {
        schemaVersion: '1.0',
        expectedGeneration: Number(record.generation),
        expectedInputDigest: set.inputDigest,
        questionSetDigest: await sha256(canonicalJson(set)),
        answers,
      },
      crypto.randomUUID(),
    );
    return {
      auditId: audit.id,
      revisionId: receipt.revisionId,
      generation: 0,
      inputDigest: receipt.inputDigest,
    };
  }
  await publish(questions);
  const answer = (
    question: ReturnType<typeof buildContextQuestions>['questions'][number],
    customText = '',
  ) => ({
    schemaVersion: '1.0' as const,
    questionId: question.id,
    selectedOptionId: question.options[0]!.id,
    customText,
  });
  return { docs, audit, resolver, questions, submit, publish, answer };
}
describe('answer-derived context declarations', () => {
  it('resolves all option declarations on a real successor and replays without a model call', async () => {
    const f = await setup();
    const fence = await f.submit(
      f.questions,
      f.questions.questions.map((q) => f.answer(q)),
    );
    const result = await f.resolver.resolve('alice', fence);
    expect(result.allUserDeclarationsResolved).toBe(true);
    expect(result.questionDraft).toBeNull();
    expect(result.declarations).toHaveLength(7);
    expect((await f.resolver.resolve('alice', fence)).replayed).toBe(true);
    expect(
      f.docs.documents.get(`audits/${f.audit.id}/revisions/${fence.revisionId}`)
        ?.status,
    ).toBe('idle');
  });
  it('retains resolved declarations across two partial answer successors without reasking them', async () => {
    const f = await setup();
    const firstFence = await f.submit(f.questions, [
      f.answer(f.questions.questions[0]!),
    ]);
    const first = await f.resolver.resolve('alice', firstFence);
    expect(first.questionDraft?.questions).toHaveLength(6);
    expect(
      first.questionDraft!.questions.some((q) => q.key === 'context.units'),
    ).toBe(false);
    await f.publish(first.questionDraft!);
    const secondFence = await f.submit(
      first.questionDraft!,
      first.questionDraft!.questions.map((q) => f.answer(q)),
    );
    const second = await f.resolver.resolve('alice', secondFence);
    expect(second.allUserDeclarationsResolved).toBe(true);
    expect(second.declarations.find((d) => d.field === 'units')).toMatchObject({
      state: 'declared',
      value: 'si',
    });
  });
  it('preserves conflicting custom text and keeps the affected question unresolved', async () => {
    const f = await setup();
    const fence = await f.submit(f.questions, [
      f.answer(f.questions.questions[0]!, 'Lengths use cm'),
    ]);
    const result = await f.resolver.resolve('alice', fence);
    expect(result.declarations[0]).toMatchObject({
      state: 'needs_reconciliation',
      value: null,
      answer: { customText: 'Lengths use cm', selectedOptionId: 'si' },
    });
    expect(result.questionDraft?.questions).toHaveLength(7);
  });
  it('blocks carrying declarations when source changes even if a new input digest is supplied', async () => {
    const f = await setup();
    const fence = await f.submit(f.questions, [
      f.answer(f.questions.questions[0]!),
    ]);
    const record = f.docs.documents.get(
      `audits/${f.audit.id}/revisions/${fence.revisionId}`,
    )!;
    const manifest = record.sourceManifest as Array<Record<string, unknown>>;
    manifest[0]!.sha256 = 'f'.repeat(64);
    record.inputDigest = await sha256(
      canonicalJson({ uploads: manifest, answers: record.answers }),
    );
    await expect(
      f.resolver.resolve('alice', {
        ...fence,
        inputDigest: record.inputDigest,
      }),
    ).rejects.toThrow('Source changes');
  });
  it('rejects stale question provenance, uninvited access and mutated successor answers', async () => {
    const f = await setup();
    const fence = await f.submit(f.questions, [
      f.answer(f.questions.questions[0]!),
    ]);
    const record = f.docs.documents.get(
      `audits/${f.audit.id}/revisions/${fence.revisionId}`,
    )!;
    record.answeredQuestionSetDigest = 'e'.repeat(64);
    await expect(f.resolver.resolve('alice', fence)).rejects.toThrow(
      'snapshot',
    );
    record.answeredQuestionSetDigest = await sha256(canonicalJson(f.questions));
    record.answers = [];
    await expect(f.resolver.resolve('alice', fence)).rejects.toThrow(
      'snapshot',
    );
    f.docs.documents.set('testers/alice', { active: false });
    await expect(f.resolver.resolve('alice', fence)).rejects.toMatchObject({
      status: 403,
    });
  });
});
