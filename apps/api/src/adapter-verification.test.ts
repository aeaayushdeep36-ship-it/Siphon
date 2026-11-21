import { describe, expect, it, vi } from 'vitest';
import { fidelityExecutionFixture } from '../test/fidelity-execution-fixture.js';
import { WorkspaceRepository } from './workspace.js';
import { AdapterVerification } from './adapter-verification.js';
import { canonicalJson, sha256 } from './hashing.js';
import { QuestionSet, RequirementId } from '@siphon/contracts';
import { ScientificEligibilityStage } from './scientific-eligibility-stage.js';
import { ScientificQuestions } from './scientific-questions.js';
import { SandboxRequest } from './e2b-client.js';
import { expectedCharges } from './sandbox-jobs.js';
import { AdmissionRepository } from './admission.js';
import { Operation, reserveOperation } from './accounting.js';
import { FirestoreAccountingStore } from './firestore-accounting.js';
import { ScientificPlanStage } from './scientific-plan-stage.js';
import { ScientificExecutionTransition } from './scientific-execution-transition.js';
import { ScientificEvaluationStage } from './scientific-evaluation-stage.js';
import { assessEligibility } from './eligibility.js';
import { ScientificParameters } from './scientific-parameters.js';

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
  it('reassesses using a real bound reservation and rejects expired credit', async () => {
    const f = await fixture();
    await new WorkspaceRepository(f.docs, f.clock).submitAdapterReview(
      'alice',
      f.fence.auditId,
      f.fence.revisionId,
      f.review,
    );
    await f.verify.publish('alice', f.fence, f.request.operationId);
    const eligibility = new ScientificEligibilityStage(f.docs, f.clock);
    const initial = await eligibility.assess('alice', f.fence);
    const id = crypto.randomUUID(),
      operationId = crypto.randomUUID(),
      now = f.clock().toISOString();
    f.docs.documents.set(`sandboxTemplates/${id}`, {
      schemaVersion: '1.0',
      id,
      templateId: 'test-evaluator',
      role: 'evaluation',
      imageDigest: 'c'.repeat(64),
      runtimeDigest: 'd'.repeat(64),
      verifiedAt: now,
      expiresAt: '2026-10-31T00:00:00.000Z',
      networkIsolationVerified: true,
      privateAccessVerified: true,
      resourceLimitsVerified: true,
      singlePrivateBuildVerified: true,
      microUsdPerSecondCeiling: 10,
    });
    const request = SandboxRequest.parse({
      operationId,
      auditId: f.fence.auditId,
      revisionId: f.fence.revisionId,
      inputDigest: f.fence.inputDigest,
      role: 'evaluation',
      templateId: 'test-evaluator',
      templateEvidenceId: id,
      lifetimeSeconds: 60,
    });
    f.docs.documents.set(`scientificBudgetStages/${f.fence.revisionId}`, {
      ownerUid: 'alice',
      ...f.fence,
      operationId,
      request,
      eligibilityInputDigest: await sha256(
        canonicalJson(initial.assessmentInput),
      ),
    });
    await new AdmissionRepository(f.docs, f.clock).acquire('alice', f.fence);
    await reserveOperation(
      new FirestoreAccountingStore(f.docs),
      Operation.parse({
        schemaVersion: '1.0',
        id: operationId,
        ownerUid: 'alice',
        auditId: f.fence.auditId,
        revisionId: f.fence.revisionId,
        inputDigest: f.fence.inputDigest,
        fence: f.fence.generation,
        requestDigest: await sha256(canonicalJson(request)),
        outcome: 'reserved',
        usage: null,
        providerHandle: null,
        charges: expectedCharges(request, 600),
        createdAt: now,
        updatedAt: now,
      }),
    );
    await f.jobs.bind(request);
    const updated = await eligibility.assess('alice', f.fence);
    expect(
      updated.assessmentInput.assertions.find(
        (item) => item.requirement === 'resource_budget_available',
      ),
    ).toMatchObject({ state: 'satisfied', evidenceIds: [operationId] });
    f.docs.documents.get('configuration/e2b_credits')!.expiresAt = now;
    await expect(eligibility.assess('alice', f.fence)).rejects.toThrow(
      'not covered',
    );
    // Authored eligible assertions exercise publication mechanics, not the
    // upstream physics interpretation, which is covered separately.
    f.docs.documents.get('configuration/e2b_credits')!.expiresAt =
      '2026-10-31T00:00:00.000Z';
    const authored = {
      ...initial.assessmentInput,
      assertions: RequirementId.options.map((requirement) => ({
        requirement,
        state: 'satisfied' as const,
        evidenceIds: [
          requirement === 'resource_budget_available'
            ? operationId
            : crypto.randomUUID(),
        ],
      })),
    };
    const authoredBase = {
      ...authored,
      assertions: authored.assertions.filter(
        (item) => item.requirement !== 'resource_budget_available',
      ),
    };
    f.docs.documents.get(
      `scientificBudgetStages/${f.fence.revisionId}`,
    )!.eligibilityInputDigest = await sha256(canonicalJson(authoredBase));
    const saved = f.docs.documents.get(`${f.base}/eligibility/current`)!;
    saved.eligibilityInput = authored;
    saved.eligibilityInputDigest = await sha256(canonicalJson(authored));
    saved.assessment = assessEligibility(authored);
    saved.assessmentDigest = await sha256(canonicalJson(saved.assessment));
    const spy = vi
      .spyOn(ScientificEligibilityStage.prototype, 'assess')
      .mockResolvedValue(updated);
    try {
      const planStage = new ScientificPlanStage(f.docs, f.clock);
      const first = await planStage.publish('alice', f.fence);
      expect(
        first.plan.checks.find((check) => check.checkId === 'H_ENERGY')
          ?.selection,
      ).toBe('selected');
      const parameters = new ScientificParameters(f.docs, f.clock);
      await expect(
        new ScientificExecutionTransition(f.docs, f.clock).advance(
          'alice',
          f.fence,
        ),
      ).rejects.toThrow('thermal parameters are required');
      const declaration = {
        schemaVersion: '1.0',
        expectedGeneration: f.fence.generation,
        expectedInputDigest: f.fence.inputDigest,
        planDigest: first.planDigest,
        parameters: { densityKgM3: 1000, heatCapacityJKgK: 4184 },
      };
      await expect(
        parameters.submitHeat(
          'bob',
          f.fence.auditId,
          f.fence.revisionId,
          declaration,
        ),
      ).rejects.toThrow();
      await expect(
        parameters.submitHeat('alice', f.fence.auditId, f.fence.revisionId, {
          ...declaration,
          parameters: { ...declaration.parameters, densityKgM3: 0 },
        }),
      ).rejects.toThrow();
      expect(
        await parameters.submitHeat(
          'alice',
          f.fence.auditId,
          f.fence.revisionId,
          declaration,
        ),
      ).toMatchObject({ replayed: false });
      expect(
        await parameters.submitHeat(
          'alice',
          f.fence.auditId,
          f.fence.revisionId,
          declaration,
        ),
      ).toMatchObject({ replayed: true });
      await expect(
        parameters.submitHeat('alice', f.fence.auditId, f.fence.revisionId, {
          ...declaration,
          parameters: { ...declaration.parameters, densityKgM3: 999 },
        }),
      ).rejects.toThrow('immutable');
      expect(await planStage.publish('alice', f.fence)).toMatchObject({
        replayed: true,
        planDigest: first.planDigest,
      });
      f.docs.documents.get('configuration/e2b_credits')!.expiresAt = now;
      await expect(planStage.publish('alice', f.fence)).rejects.toThrow(
        'not covered',
      );
      f.docs.documents.get('configuration/e2b_credits')!.expiresAt =
        '2026-10-31T00:00:00.000Z';
      const advance = new ScientificExecutionTransition(f.docs, f.clock);
      f.docs.documents.get(`operations/${operationId}`)!.outcome =
        'dispatching';
      await expect(advance.advance('alice', f.fence)).rejects.toThrow(
        'binding changed',
      );
      expect(f.docs.documents.get(f.base)?.stage).toBe('adapting');
      f.docs.documents.get(`operations/${operationId}`)!.outcome = 'reserved';
      const planning = await advance.advance('alice', f.fence);
      expect(planning.stage).toBe('planning');
      expect(f.docs.documents.get(`operations/${operationId}`)).toMatchObject({
        outcome: 'reserved',
        fence: planning.fence.generation,
        providerHandle: null,
      });
      await expect(advance.advance('alice', f.fence)).rejects.toThrow();
      f.docs.documents.get(f.base)!.cancellationRequestedAt = now;
      await expect(advance.advance('alice', planning.fence)).rejects.toThrow();
      f.docs.documents.get(f.base)!.cancellationRequestedAt = null;
      const executing = await advance.advance('alice', planning.fence);
      const evaluating = await advance.advance('alice', executing.fence);
      expect(evaluating.stage).toBe('evaluating');
      expect(f.docs.documents.get(`operations/${operationId}`)).toMatchObject({
        outcome: 'reserved',
        fence: evaluating.fence.generation,
        providerHandle: null,
      });
      expect(
        f.docs.documents.get(`scientificBudgetStages/${f.fence.revisionId}`)
          ?.generation,
      ).toBe(evaluating.fence.generation);
      f.docs.documents.set(
        `baselineValidationStages/${f.fence.revisionId}_adapted`,
        {
          ownerUid: 'alice',
          auditId: f.fence.auditId,
          revisionId: f.fence.revisionId,
          inputDigest: f.fence.inputDigest,
          sourceOperationId: f.request.adapted.sourceOperationId,
          operationId: f.request.adapted.evaluationOperationId,
        },
      );
      // This fixture has no thermal weights. It must not become an executable heat request.
      await expect(
        new ScientificEvaluationStage(f.docs, f.clock).prepare(
          'alice',
          evaluating.fence,
        ),
      ).rejects.toThrow('thermal_weights');
      expect(
        f.docs.documents.has(
          `scientificEvaluationStages/${f.fence.revisionId}`,
        ),
      ).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
  it('continues automatically when the comparison was published before the review', async () => {
    const f = await fixture();
    f.docs.documents.set(`fidelityStages/${f.fence.revisionId}`, {
      ownerUid: 'alice',
      ...f.fence,
      operationId: f.request.operationId,
    });
    const workspace = new WorkspaceRepository(f.docs, f.clock);
    expect(
      await workspace.submitAdapterReview(
        'alice',
        f.fence.auditId,
        f.fence.revisionId,
        f.review,
      ),
    ).toMatchObject({ allDeclaredConfirmed: true });
    expect(f.docs.documents.get(`${f.base}/adapters/current`)).toMatchObject({
      status: 'verified',
    });
    expect(f.docs.documents.has(`${f.base}/scientificQuestions/current`)).toBe(
      true,
    );
    expect(f.docs.documents.has(`${f.base}/eligibility/current`)).toBe(true);
    expect(
      await workspace.continueAdapterReview(
        'alice',
        f.fence.auditId,
        f.fence.revisionId,
        {
          schemaVersion: '1.0',
          expectedGeneration: f.fence.generation,
          expectedInputDigest: f.fence.inputDigest,
        },
      ),
    ).toMatchObject({ status: 'continued' });
    await expect(
      workspace.continueAdapterReview(
        'bob',
        f.fence.auditId,
        f.fence.revisionId,
        {
          schemaVersion: '1.0',
          expectedGeneration: f.fence.generation,
          expectedInputDigest: f.fence.inputDigest,
        },
      ),
    ).rejects.toThrow();
  });
  it('recovers continuation after a saved review encounters a temporary evidence failure', async () => {
    const f = await fixture();
    f.docs.documents.set(`fidelityStages/${f.fence.revisionId}`, {
      ownerUid: 'alice',
      ...f.fence,
      operationId: f.request.operationId,
    });
    const path = `${f.base}/numericValidations/${f.request.adapted.evaluationOperationId}`;
    f.docs.documents.get(path)!.ownerUid = 'bob';
    const workspace = new WorkspaceRepository(f.docs, f.clock);
    await expect(
      workspace.submitAdapterReview(
        'alice',
        f.fence.auditId,
        f.fence.revisionId,
        f.review,
      ),
    ).rejects.toThrow('numeric evidence changed');
    expect(f.docs.documents.has(`${f.base}/adapterReviews/current`)).toBe(true);
    f.docs.documents.get(path)!.ownerUid = 'alice';
    expect(
      await workspace.continueAdapterReview(
        'alice',
        f.fence.auditId,
        f.fence.revisionId,
        {
          schemaVersion: '1.0',
          expectedGeneration: f.fence.generation,
          expectedInputDigest: f.fence.inputDigest,
        },
      ),
    ).toMatchObject({ status: 'continued' });
    expect(f.docs.documents.has(`${f.base}/eligibility/current`)).toBe(true);
  });
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
    const savedEligibility = f.docs.documents.get(
      `${f.base}/eligibility/current`,
    )!;
    expect(savedEligibility.eligibilityInputDigest).toBe(
      await sha256(canonicalJson(savedEligibility.eligibilityInput)),
    );
    const validInputDigest = savedEligibility.eligibilityInputDigest;
    savedEligibility.eligibilityInputDigest = '0'.repeat(64);
    await expect(
      new ScientificEligibilityStage(f.docs, f.clock).assess('alice', f.fence),
    ).rejects.toThrow('input provenance changed');
    savedEligibility.eligibilityInputDigest = validInputDigest;
    const currentInput = structuredClone(savedEligibility.eligibilityInput) as {
      assertions: { evidenceIds: string[] }[];
    };
    const priorInput = structuredClone(currentInput);
    priorInput.assertions[0]!.evidenceIds = [crypto.randomUUID()];
    savedEligibility.eligibilityInput = priorInput;
    savedEligibility.eligibilityInputDigest = await sha256(
      canonicalJson(priorInput),
    );
    f.docs.documents.set(`${f.base}/plans/current`, { published: true });
    await expect(
      new ScientificEligibilityStage(f.docs, f.clock).assess('alice', f.fence),
    ).rejects.toThrow('Published plan prevents eligibility changes');
    f.docs.documents.delete(`${f.base}/plans/current`);
    expect(
      await new ScientificEligibilityStage(f.docs, f.clock).assess(
        'alice',
        f.fence,
      ),
    ).toMatchObject({ replayed: false });
    expect(
      f.docs.documents.get(`${f.base}/eligibility/current`)
        ?.eligibilityInputDigest,
    ).toBe(validInputDigest);
    expect(
      [...f.docs.documents.keys()].some((key) =>
        key.startsWith(`${f.base}/eligibilityHistory/`),
      ),
    ).toBe(true);
    const numeric = f.docs.documents.get(
      `${f.base}/numericValidations/${f.request.adapted.evaluationOperationId}`,
    )!;
    numeric.ownerUid = 'bob';
    await expect(
      new ScientificEligibilityStage(f.docs, f.clock).assess('alice', f.fence),
    ).rejects.toThrow('numeric evidence changed');
    f.docs.documents.get(
      `${f.base}/numericValidations/${f.request.adapted.evaluationOperationId}`,
    )!.ownerUid = 'alice';
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
  it('replays a saved scientific answer after eligibility assessment fails', async () => {
    const f = await fixture();
    const workspace = new WorkspaceRepository(f.docs, f.clock);
    await workspace.submitAdapterReview(
      'alice',
      f.fence.auditId,
      f.fence.revisionId,
      f.review,
    );
    await f.verify.publish('alice', f.fence, f.request.operationId);
    const prepared = await new ScientificQuestions(f.docs, f.clock).prepare(
      'alice',
      f.fence,
    );
    const answer = {
      schemaVersion: '1.0',
      questionId: prepared.questionSet.questions[0]!.id,
      selectedOptionId: 'cell_averages_physical_volumes',
      customText: '',
    };
    const request = {
      schemaVersion: '1.0',
      expectedGeneration: f.fence.generation,
      expectedInputDigest: f.fence.inputDigest,
      questionSetDigest: prepared.questionSetDigest,
      answer,
    };
    const numeric = f.docs.documents.get(
      `${f.base}/numericValidations/${f.request.adapted.evaluationOperationId}`,
    )!;
    numeric.ownerUid = 'bob';
    await expect(
      workspace.submitScientificAnswer(
        'alice',
        f.fence.auditId,
        f.fence.revisionId,
        request,
      ),
    ).rejects.toThrow();
    expect(
      f.docs.documents.get(`${f.base}/scientificQuestions/current`)?.answer,
    ).toEqual(answer);
    f.docs.documents.get(
      `${f.base}/numericValidations/${f.request.adapted.evaluationOperationId}`,
    )!.ownerUid = 'alice';
    expect(
      await workspace.submitScientificAnswer(
        'alice',
        f.fence.auditId,
        f.fence.revisionId,
        request,
      ),
    ).toMatchObject({
      replayed: true,
      assessmentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});
