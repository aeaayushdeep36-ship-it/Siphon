import { describe, expect, it } from 'vitest';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { ScientificQuestions } from './scientific-questions.js';
import { canonicalJson, sha256 } from './hashing.js';

async function orbitalFixture() {
  const docs = new TestDocuments();
  docs.documents.set('testers/alice', { active: true });
  const { audit } = await new FirestoreAuditRepository(docs).create(
    'alice',
    {
      schemaVersion: '1.0',
      title: 'Authored orbit',
      domain: 'orbital_dynamics',
    },
    'create',
  );
  const base = `audits/${audit.id}/revisions/${audit.currentRevisionId}`,
    revision = docs.documents.get(base)!;
  Object.assign(revision, { stage: 'adapting', status: 'running' });
  const fence = {
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest: String(revision.inputDigest),
    generation: 0,
  };
  const context = {
      schemaVersion: '1.0',
      auditId: audit.id,
      revisionId: fence.revisionId,
      inputDigest: fence.inputDigest,
      domain: 'orbital_dynamics',
      summary: 'Authored fixture',
      domainMismatchSuspected: false,
      candidates: [],
    },
    contextDigest = await sha256(canonicalJson(context));
  const mappings = [
    {
      key: 'times',
      root: 't',
      steps: [],
      expectedShape: [2],
      axisOrder: [0],
      declaredUnit: 's',
    },
    {
      key: 'positions',
      root: 'x',
      steps: [],
      expectedShape: [2, 1, 2],
      axisOrder: [0, 1, 2],
      declaredUnit: 'm',
    },
    {
      key: 'velocities',
      root: 'v',
      steps: [],
      expectedShape: [2, 1, 2],
      axisOrder: [0, 1, 2],
      declaredUnit: 'm/s',
    },
  ];
  const adapter = {
    schemaVersion: '1.0',
    auditId: audit.id,
    revisionId: fence.revisionId,
    inputDigest: fence.inputDigest,
    contextDigest,
    sourceArtifactId: crypto.randomUUID(),
    sourceDigest: 'a'.repeat(64),
    domain: 'orbital_dynamics',
    handler: 'script_globals_v1',
    mappings,
  };
  docs.documents.set(`${base}/context/current`, {
    ownerUid: 'alice',
    inputDigest: fence.inputDigest,
    proposal: context,
    proposalDigest: contextDigest,
  });
  docs.documents.set(`${base}/adapters/current`, {
    ownerUid: 'alice',
    inputDigest: fence.inputDigest,
    status: 'verified',
    proposal: adapter,
    adapterDigest: await sha256(canonicalJson(adapter)),
  });
  return { docs, fence, base, service: new ScientificQuestions(docs) };
}
describe('domain-specific scientific declarations', () => {
  it('asks the orbital coordinate question and keeps custom text intact', async () => {
    const f = await orbitalFixture(),
      prepared = await f.service.prepare('alice', f.fence),
      q = prepared.questionSet.questions[0]!;
    expect(q.key).toBe('scientific.orbital_coordinates');
    expect(q.customTextAllowed).toBe(true);
    expect(q.options.some((option) => option.unknown)).toBe(true);
    const answer = {
      schemaVersion: '1.0',
      questionId: q.id,
      selectedOptionId: 'fixed_source_relative',
      customText: 'Origin is moving; please clarify.',
    };
    await f.service.submit(
      'alice',
      f.fence,
      prepared.questionSetDigest,
      answer,
    );
    expect(
      f.docs.documents.get(`${f.base}/scientificQuestions/current`)?.answer,
    ).toEqual(answer);
    await expect(
      f.service.submit('alice', f.fence, 'a'.repeat(64), answer),
    ).rejects.toThrow('snapshot changed');
  });
});
