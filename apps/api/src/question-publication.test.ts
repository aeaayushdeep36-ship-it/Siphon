import { describe, expect, it } from 'vitest';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { QuestionPublisher } from './question-publication.js';
import { RevisionRepository } from './revisions.js';

async function setup() {
  const store = new TestDocuments();
  store.documents.set('testers/alice', { active: true });
  const { audit } = await new FirestoreAuditRepository(store).create(
    'alice',
    { schemaVersion: '1.0', domain: 'heat_diffusion', title: 'Publication' },
    'create',
  );
  const path = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
  const revision = store.documents.get(path)!;
  revision.stage = 'inspecting';
  revision.status = 'running';
  const fence = {
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    generation: 0,
    inputDigest: String(revision.inputDigest),
  };
  const value = {
    schemaVersion: '1.0',
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest: fence.inputDigest,
    questions: [
      {
        schemaVersion: '1.0',
        id: crypto.randomUUID(),
        key: 'units',
        prompt: 'Which units?',
        reason: 'Required for interpretation.',
        options: [
          { id: 'si', label: 'SI', unknown: false },
          { id: 'unknown', label: 'Unknown', unknown: true },
        ],
        customTextAllowed: true,
        requiredFacts: ['units'],
        affectedChecks: ['H_ENERGY'],
      },
    ],
  };
  const publisher = new QuestionPublisher(store);
  return {
    store,
    audit,
    path,
    revision,
    fence,
    value,
    publisher,
    publish: (key = 'publish') => publisher.publish('alice', fence, value, key),
  };
}

describe('fenced question publication', () => {
  it('atomically publishes and enters a wait; the answer flow consumes the new fence', async () => {
    const f = await setup();
    const result = await f.publish();
    expect(result.receipt).toMatchObject({
      generation: 1,
      status: 'waiting_for_input',
    });
    expect(f.store.documents.get(f.path)?.progress).toMatchObject({
      activity: 'awaiting_answers',
      status: 'waiting_for_input',
      eventCount: 1,
    });
    expect(f.store.documents.has(`${f.path}/events/000001`)).toBe(true);
    const revisions = new RevisionRepository(f.store);
    const questions = await revisions.getQuestions(
      'alice',
      f.audit.id,
      f.audit.currentRevisionId,
    );
    expect(questions.questionSetDigest).toBe(result.receipt.questionSetDigest);
    const answered = await revisions.submitAnswers(
      'alice',
      f.audit.id,
      f.audit.currentRevisionId,
      {
        schemaVersion: '1.0',
        expectedGeneration: 1,
        expectedInputDigest: f.fence.inputDigest,
        questionSetDigest: result.receipt.questionSetDigest,
        answers: [
          {
            schemaVersion: '1.0',
            questionId: f.value.questions[0]!.id,
            selectedOptionId: 'unknown',
            customText: '',
          },
        ],
      },
      'answer',
    );
    expect(answered.receipt.parentRevisionId).toBe(f.audit.currentRevisionId);
  });
  it('deduplicates concurrent publication and rejects overwrites under another key', async () => {
    const f = await setup();
    const results = await Promise.all([f.publish(), f.publish()]);
    expect(results[0]?.receipt).toEqual(results[1]?.receipt);
    expect(results.filter((item) => item.replayed)).toHaveLength(1);
    await expect(f.publish('other')).rejects.toMatchObject({
      code: 'stale_revision',
    });
    f.value.questions[0]!.prompt = 'Changed';
    await expect(f.publish()).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
  });
  it('rejects stale source identity, generations, deletion and cancellation', async () => {
    const f = await setup();
    f.value.inputDigest = 'a'.repeat(64);
    await expect(f.publish()).rejects.toMatchObject({
      code: 'question_snapshot_mismatch',
    });
    f.value.inputDigest = f.fence.inputDigest;
    f.revision.generation = 1;
    await expect(f.publish()).rejects.toMatchObject({ code: 'stale_revision' });
    f.revision.generation = 0;
    f.revision.stage = 'finished';
    f.revision.status = 'cancelled';
    f.revision.cancellationRequestedAt = new Date().toISOString();
    await expect(f.publish()).rejects.toMatchObject({ code: 'stale_revision' });
    f.store.documents.get(`audits/${f.audit.id}`)!.deletionRequestedAt =
      new Date().toISOString();
    await expect(f.publish()).rejects.toMatchObject({ status: 404 });
    expect(f.store.documents.has(`${f.path}/questions/current`)).toBe(false);
  });
  it('does not strand an active operation or lease in a human wait', async () => {
    const f = await setup();
    f.revision.slotLeaseId = 'lease';
    await expect(f.publish()).rejects.toMatchObject({
      code: 'stage_release_required',
    });
    f.revision.slotLeaseId = null;
    f.revision.activeOperationId = 'operation';
    await expect(f.publish()).rejects.toMatchObject({
      code: 'stage_release_required',
    });
    expect(f.store.documents.get(f.path)?.status).toBe('running');
  });
});
