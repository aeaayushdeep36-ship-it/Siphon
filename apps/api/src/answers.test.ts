import { describe, expect, it } from 'vitest';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { RevisionRepository } from './revisions.js';
import { canonicalJson, sha256 } from './hashing.js';

async function setup() {
  const store = new TestDocuments();
  store.documents.set('testers/alice', { active: true });
  store.documents.set('testers/bob', { active: true });
  const { audit } = await new FirestoreAuditRepository(store).create(
    'alice',
    { schemaVersion: '1.0', title: 'Questions', domain: 'heat_diffusion' },
    'create',
  );
  const path = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
  const parent = store.documents.get(path)!;
  parent.stage = 'clarifying';
  parent.status = 'waiting_for_input';
  const question = {
    schemaVersion: '1.0',
    id: crypto.randomUUID(),
    key: 'temperatureUnit',
    prompt: 'Which temperature unit is used?',
    reason: 'Needed for physical interpretation.',
    options: [
      { id: 'kelvin', label: 'Kelvin', unknown: false },
      { id: 'unknown', label: 'I do not know', unknown: true },
    ],
    customTextAllowed: true,
    requiredFacts: ['temperature.unit'],
    affectedChecks: ['H_ENERGY'],
  };
  const questionSet = {
    schemaVersion: '1.0',
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest: parent.inputDigest,
    questions: [question],
  };
  store.documents.set(`${path}/questions/current`, {
    questionSet,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const input = {
    schemaVersion: '1.0' as const,
    expectedGeneration: 0,
    expectedInputDigest: String(parent.inputDigest),
    questionSetDigest: await sha256(canonicalJson(questionSet)),
    answers: [
      {
        schemaVersion: '1.0' as const,
        questionId: question.id,
        selectedOptionId: 'kelvin',
        customText: 'Actually the plotting label might say Celsius.  ',
      },
    ],
  };
  const repo = new RevisionRepository(store);
  return {
    store,
    audit,
    path,
    parent,
    input,
    repo,
    submit: (key = 'answer') =>
      repo.submitAnswers(
        'alice',
        audit.id,
        audit.currentRevisionId,
        input,
        key,
      ),
  };
}

describe('immutable clarification answers', () => {
  it('creates a successor preserving option plus exact custom text, with no confirmed facts', async () => {
    const f = await setup();
    const result = await f.submit();
    const child = f.store.documents.get(
      `audits/${f.audit.id}/revisions/${result.receipt.revisionId}`,
    )!;
    expect(child.answers).toEqual(f.input.answers);
    expect(child.answerInterpretations).toMatchObject([
      { state: 'pending', facts: {}, answer: f.input.answers[0] },
    ]);
    expect(child).toMatchObject({
      stage: 'draft',
      status: 'idle',
      parentRevisionId: f.audit.currentRevisionId,
    });
    expect(f.store.documents.get(f.path)?.answers).toEqual([]);
    expect(result.receipt.inputDigest).not.toBe(f.input.expectedInputDigest);
  });
  it('replays concurrent identical requests without creating another successor', async () => {
    const f = await setup();
    const [one, two] = await Promise.all([f.submit(), f.submit()]);
    expect(one.receipt.revisionId).toBe(two.receipt.revisionId);
    expect([one, two].filter((result) => result.replayed)).toHaveLength(1);
    await expect(f.submit('different-key')).rejects.toMatchObject({
      code: 'stale_revision',
    });
  });
  it('rejects stale question versions, unknown options and duplicates', async () => {
    const f = await setup();
    const original = f.input.questionSetDigest;
    f.input.questionSetDigest = 'a'.repeat(64);
    await expect(f.submit()).rejects.toMatchObject({ code: 'stale_questions' });
    f.input.questionSetDigest = original;
    f.input.answers[0]!.selectedOptionId = 'not_present';
    await expect(f.submit()).rejects.toMatchObject({ code: 'invalid_answer' });
    f.input.answers.push(f.input.answers[0]!);
    await expect(f.submit()).rejects.toThrow();
    expect(
      f.store.documents.get(`audits/${f.audit.id}`)?.currentRevisionId,
    ).toBe(f.audit.currentRevisionId);
  });
  it('preserves an explicit unknown answer as unknown', async () => {
    const f = await setup();
    f.input.answers[0]!.selectedOptionId = 'unknown';
    f.input.answers[0]!.customText = '';
    const result = await f.submit();
    expect(
      f.store.documents.get(
        `audits/${f.audit.id}/revisions/${result.receipt.revisionId}`,
      )?.answerInterpretations,
    ).toMatchObject([{ state: 'unknown', facts: {} }]);
  });
  it('protects private questions and answers and denies deleted audit replays', async () => {
    const f = await setup();
    await expect(
      f.repo.getQuestions('bob', f.audit.id, f.audit.currentRevisionId),
    ).rejects.toMatchObject({ status: 404 });
    const listed = await f.repo.getQuestions(
      'alice',
      f.audit.id,
      f.audit.currentRevisionId,
    );
    expect(listed.questionSetDigest).toBe(f.input.questionSetDigest);
    await expect(
      f.repo.submitAnswers(
        'bob',
        f.audit.id,
        f.audit.currentRevisionId,
        f.input,
        'answer',
      ),
    ).rejects.toMatchObject({ status: 404 });
    await f.submit();
    f.store.documents.get(`audits/${f.audit.id}`)!.deletionRequestedAt =
      new Date().toISOString();
    await expect(f.submit()).rejects.toMatchObject({ status: 404 });
  });
});
