import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequirementId } from '@siphon/contracts';
import { TestDocuments } from '../test/document-store.js';
import { diagnosticsFixture } from '../test/diagnostics-fixture.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { buildContextQuestions } from './context-questions.js';
import { buildScientificPlan } from './scientific-plan.js';
import { assessEligibility } from './eligibility.js';
import { ScientificEvaluationStage } from './scientific-evaluation-stage.js';
import * as reservation from './scientific-reservation.js';
import * as observations from './stored-observations.js';
import { canonicalJson, sha256 } from './hashing.js';

afterEach(() => vi.restoreAllMocks());
describe('scientific evaluation request', () => {
  it('binds a fixed-central plan to the validated baseline and replays the same evidence ids', async () => {
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
    Object.assign(revision, {
      stage: 'evaluating',
      status: 'running',
      generation: 3,
    });
    const fence = {
      auditId: audit.id,
      revisionId: audit.currentRevisionId,
      inputDigest: String(revision.inputDigest),
      generation: 3,
    };
    const example = await diagnosticsFixture();
    const sourceId = crypto.randomUUID(),
      operationId = crypto.randomUUID(),
      validationId = crypto.randomUUID();
    const adapter = {
      schemaVersion: '1.0',
      auditId: audit.id,
      revisionId: fence.revisionId,
      inputDigest: fence.inputDigest,
      contextDigest: 'c'.repeat(64),
      sourceArtifactId: crypto.randomUUID(),
      sourceDigest: 'd'.repeat(64),
      domain: 'orbital_dynamics',
      handler: 'script_globals_v1',
      mappings: example.request.validation.mappings,
    };
    const adapterDigest = await sha256(canonicalJson(adapter));
    const adapted = {
      ...example.request.validation,
      evaluationOperationId: validationId,
      sourceOperationId: sourceId,
      inputDigest: fence.inputDigest,
      adapterDigest,
      manifest: {
        ...example.request.validation.manifest,
        operationId: sourceId,
        inputDigest: fence.inputDigest,
        adapterDigest,
      },
    };
    const originalId = crypto.randomUUID();
    const original = {
      ...adapted,
      evaluationOperationId: crypto.randomUUID(),
      sourceOperationId: originalId,
      manifest: { ...adapted.manifest, operationId: originalId },
    };
    const comparisonId = crypto.randomUUID(),
      fidelity = {
        schemaVersion: '1.0',
        operationId: comparisonId,
        original,
        adapted,
      };
    const common = {
      ownerUid: 'alice',
      auditId: audit.id,
      revisionId: fence.revisionId,
      inputDigest: fence.inputDigest,
    };
    const input = {
      schemaVersion: '1.0',
      domain: 'orbital_dynamics',
      inputDigest: fence.inputDigest,
      contextDigest: adapter.contextDigest,
      adapterDigest,
      assertions: RequirementId.options.map((requirement) => ({
        requirement,
        state:
          requirement === 'isolated_mutual_gravity' ? 'violated' : 'satisfied',
        evidenceIds: [
          requirement === 'resource_budget_available'
            ? operationId
            : crypto.randomUUID(),
        ],
      })),
    };
    const plan = buildScientificPlan({
      planId: crypto.randomUUID(),
      auditId: audit.id,
      revisionId: fence.revisionId,
      eligibilityInput: input,
      profile: 'central_orbit_si',
      sourceOperationId: sourceId,
      sourceOutputDigest: 'e'.repeat(64),
      createdAt: '2026-11-10T18:00:00.000Z',
    });
    const planDigest = await sha256(canonicalJson(plan));
    docs.documents.set(`${base}/plans/current`, {
      ...common,
      plan,
      planDigest,
      evaluationOperationId: operationId,
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    docs.documents.set(`${base}/adapters/current`, {
      ...common,
      proposal: adapter,
      adapterDigest,
      status: 'verified',
      baseline: {
        schemaVersion: '1.0',
        status: 'matched',
        comparedElements: 11,
        observations: adapter.mappings.map((mapping) => ({
          key: mapping.key,
          status: 'matched',
          reason: null,
        })),
      },
      expiresAt: '2026-12-01T00:00:00.000Z',
      adaptedOperationId: sourceId,
      comparisonOperationId: comparisonId,
    });
    docs.documents.set(`${base}/eligibility/current`, {
      ...common,
      eligibilityInput: input,
      eligibilityInputDigest: await sha256(canonicalJson(input)),
      assessment: assessEligibility(input),
    });
    const questions = buildContextQuestions({
      auditId: audit.id,
      revisionId: fence.revisionId,
      inputDigest: fence.inputDigest,
      domain: 'orbital_dynamics',
    });
    const gravity = questions.questions.find(
      (item) => item.key === 'context.gravity_profile',
    )!;
    revision.answers = [
      {
        schemaVersion: '1.0',
        questionId: gravity.id,
        selectedOptionId: 'fixed_central',
        customText: '',
      },
    ];
    const resolution = { ...common, questionBasis: questions };
    const resolutionCore = Object.fromEntries(
      Object.entries(resolution).filter(([key]) => key !== 'ownerUid'),
    );
    docs.documents.set(`${base}/contextAnswerResolution/current`, {
      ...resolution,
      resolutionDigest: await sha256(canonicalJson(resolutionCore)),
    });
    docs.documents.set(`fidelityExecutions/${comparisonId}`, {
      ...common,
      operationId: comparisonId,
      status: 'published',
      request: fidelity,
      payloadDigest: await sha256(canonicalJson(fidelity)),
    });
    docs.documents.set(`baselineValidationStages/${fence.revisionId}_adapted`, {
      ...common,
      sourceOperationId: sourceId,
      operationId: validationId,
    });
    docs.documents.set(`scientificBudgetStages/${fence.revisionId}`, {
      request: {
        operationId,
        auditId: audit.id,
        revisionId: fence.revisionId,
        inputDigest: fence.inputDigest,
        role: 'evaluation',
        templateId: 'authored-evaluator',
        templateEvidenceId: crypto.randomUUID(),
        lifetimeSeconds: 60,
      },
    });
    vi.spyOn(reservation, 'inspectScientificReservation').mockResolvedValue(
      operationId,
    );
    vi.spyOn(
      observations,
      'inspectStoredObservationSnapshot',
    ).mockResolvedValue({
      plan: { outputDigest: 'e'.repeat(64) },
      adapter,
    } as never);
    const stage = new ScientificEvaluationStage(
      docs,
      () => new Date('2026-11-10T18:01:00.000Z'),
    );
    const first = await stage.prepare('alice', fence);
    expect(first.request.diagnostic.profile).toEqual({
      kind: 'central_orbit_si',
    });
    expect(Object.keys(first.request.evidenceIds).sort()).toEqual([
      'O_ANGULAR',
      'O_ENERGY',
    ]);
    expect(await stage.prepare('alice', fence)).toMatchObject({
      replayed: true,
      requestDigest: first.requestDigest,
      request: { evidenceIds: first.request.evidenceIds },
    });
    await expect(stage.prepare('bob', fence)).rejects.toThrow();
    docs.documents.get(`fidelityExecutions/${comparisonId}`)!.payloadDigest =
      '0'.repeat(64);
    await expect(stage.prepare('alice', fence)).rejects.toThrow(
      'baseline validation changed',
    );
  });
});
