import { describe, expect, it } from 'vitest';
import { fidelityExecutionFixture } from '../test/fidelity-execution-fixture.js';
import { WorkspaceRepository } from './workspace.js';
import { AdapterVerification } from './adapter-verification.js';
import { canonicalJson, sha256 } from './hashing.js';
import { QuestionSet } from '@siphon/contracts';
import { ScientificEligibilityStage } from './scientific-eligibility-stage.js';
import { ScientificQuestions } from './scientific-questions.js';

async function fixture() {
  const f = await fidelityExecutionFixture(),
    questions = QuestionSet.parse(
      f.docs.documents.get(`${f.base}/adapterQuestions/current`)?.questionSet,
    );
  const review = {
    schemaVersion: '1.0',
    expectedGeneration: f.fence.generation,
    expectedInputDigest: f.fence.inputDigest,
    adapterDigest: await sha256(canonicalJson(f.adapter)),
    questionSetDigest: await sha256(canonicalJson(questions)),
    answers: questions.questions.map((q) => ({
      schemaVersion: '1.0',
      questionId: q.id,
      selectedOptionId: 'confirm',
      customText: '',
    })),
  };
  await f.executions.bind('alice', f.request);
  f.dispatch();
  await f.executions.claim(
    f.request,
    await sha256(canonicalJson(f.request)),
    'authored-comparison',
  );
  await f.executions.recordCandidate(f.request.operationId, f.result);
  f.terminate();
  await f.executions.publish(f.request.operationId);
  // Authored parent provenance exercises the actual successor-read checks.
  const resolution = f.docs.documents.get(
      `${f.base}/contextAnswerResolution/current`,
    )!,
    parentId = String(resolution.parentRevisionId),
    revision = f.docs.documents.get(f.base)!;
  const parentQuestions = {
    ...QuestionSet.parse(resolution.questionBasis),
    revisionId: parentId,
  };
  revision.parentRevisionId = parentId;
  revision.answeredQuestionSetDigest = await sha256(
    canonicalJson(parentQuestions),
  );
  f.docs.documents.set(`audits/${f.fence.auditId}/revisions/${parentId}`, {
    ownerUid: 'alice',
    auditId: f.fence.auditId,
    revisionId: parentId,
    inputDigest: parentQuestions.inputDigest,
    sourceManifest: revision.sourceManifest,
  });
  f.docs.documents.set(
    `audits/${f.fence.auditId}/revisions/${parentId}/questions/current`,
    { ownerUid: 'alice', questionSet: parentQuestions },
  );
  return { ...f, review, verify: new AdapterVerification(f.docs, f.clock) };
}
describe('conditional adapter verification', () => {
  it('requires the saved declarations and independent completed comparison', async () => {
    const f = await fixture();
    await expect(
      f.verify.publish('alice', f.fence, f.request.operationId),
    ).rejects.toThrow();
    await new WorkspaceRepository(f.docs).submitAdapterReview(
      'alice',
      f.fence.auditId,
      f.fence.revisionId,
      f.review,
    );
    expect(
      await f.verify.publish('alice', f.fence, f.request.operationId),
    ).toMatchObject({ status: 'verified', replayed: false });
    const eligibility = await new ScientificEligibilityStage(
      f.docs,
      f.clock,
    ).assess('alice', f.fence);
    const questionService = new ScientificQuestions(f.docs, f.clock),
      question = await questionService.prepare('alice', f.fence);
    expect(question.questionSet.questions[0]?.key).toBe(
      'scientific.thermal_geometry',
    );
    expect(await questionService.prepare('alice', f.fence)).toMatchObject({
      replayed: true,
      questionSetDigest: question.questionSetDigest,
    });
    const answer = {
      schemaVersion: '1.0',
      questionId: question.questionSet.questions[0]!.id,
      selectedOptionId: 'cell_averages_physical_volumes',
      customText: '',
    };
    await expect(
      questionService.submit(
        'bob',
        f.fence,
        question.questionSetDigest,
        answer,
      ),
    ).rejects.toThrow();
    expect(
      await questionService.submit(
        'alice',
        f.fence,
        question.questionSetDigest,
        answer,
      ),
    ).toMatchObject({ replayed: false });
    expect(
      await questionService.submit(
        'alice',
        f.fence,
        question.questionSetDigest,
        answer,
      ),
    ).toMatchObject({ replayed: true });
    expect(
      await new WorkspaceRepository(f.docs, f.clock).submitScientificAnswer(
        'alice',
        f.fence.auditId,
        f.fence.revisionId,
        {
          schemaVersion: '1.0',
          expectedGeneration: f.fence.generation,
          expectedInputDigest: f.fence.inputDigest,
          questionSetDigest: question.questionSetDigest,
          answer,
        },
      ),
    ).toMatchObject({
      replayed: true,
      assessmentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(
      questionService.submit('alice', f.fence, question.questionSetDigest, {
        ...answer,
        customText: 'different',
      }),
    ).rejects.toThrow('immutable');
    expect(
      eligibility.assessmentInput.assertions.find(
        (item) => item.requirement === 'verified_adapter',
      )?.state,
    ).toBe('satisfied');
    expect(
      eligibility.assessment.decisions.find(
        (item) => item.checkId === 'H_ENERGY',
      )?.status,
    ).not.toBe('eligible');
    expect(
      await new ScientificEligibilityStage(f.docs, f.clock).assess(
        'alice',
        f.fence,
      ),
    ).toMatchObject({
      replayed: true,
      assessmentDigest: eligibility.assessmentDigest,
    });
    const numeric = f.docs.documents.get(
      `${f.base}/numericValidations/${f.request.adapted.evaluationOperationId}`,
    )!;
    numeric.ownerUid = 'bob';
    await expect(
      new ScientificEligibilityStage(f.docs, f.clock).assess('alice', f.fence),
    ).rejects.toThrow('numeric evidence changed');
    numeric.ownerUid = 'alice';
    expect(f.docs.documents.get(`${f.base}/adapters/current`)).toMatchObject({
      scope: 'conditional_declared_mapping_and_extraction',
    });
    expect(
      await f.verify.publish('alice', f.fence, f.request.operationId),
    ).toMatchObject({ replayed: true });
  });
  it('rejects unknown declarations', async () => {
    const f = await fixture();
    f.review.answers[0]!.selectedOptionId = 'unknown';
    await new WorkspaceRepository(f.docs).submitAdapterReview(
      'alice',
      f.fence.auditId,
      f.fence.revisionId,
      f.review,
    );
    await expect(
      f.verify.publish('alice', f.fence, f.request.operationId),
    ).rejects.toThrow('evidence is incomplete');
  });
});
