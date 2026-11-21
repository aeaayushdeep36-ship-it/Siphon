import { afterEach, describe, expect, it, vi } from 'vitest';
import { EligibilityInput, RequirementId } from '@siphon/contracts';
import { baselineExecutionFixture } from '../test/baseline-execution-fixture.js';
import { ScientificBudgetStage } from './scientific-budget-stage.js';
import { ScientificEligibilityStage } from './scientific-eligibility-stage.js';
import { assessEligibility } from './eligibility.js';
import { canonicalJson, sha256 } from './hashing.js';
import { inspectScientificReservation } from './scientific-reservation.js';

async function fixture() {
  const f = await baselineExecutionFixture();
  const evidenceId = crypto.randomUUID();
  const input = {
    schemaVersion: '1.0',
    domain: 'heat_diffusion',
    inputDigest: f.fence.inputDigest,
    contextDigest: 'b'.repeat(64),
    adapterDigest: 'c'.repeat(64),
    assertions: RequirementId.options
      .filter((key) => key !== 'resource_budget_available')
      .map((requirement) => ({
        requirement,
        state: 'satisfied',
        evidenceIds: [evidenceId],
      })),
  };
  const assessment = assessEligibility(input);
  f.docs.documents.set(`${f.base}/eligibility/current`, {
    ownerUid: 'alice',
    auditId: f.fence.auditId,
    revisionId: f.fence.revisionId,
    inputDigest: f.fence.inputDigest,
    eligibilityInput: input,
    eligibilityInputDigest: await sha256(canonicalJson(input)),
    assessment,
    assessmentDigest: await sha256(canonicalJson(assessment)),
  });
  f.docs.documents.set(`${f.base}/scientificQuestions/current`, {
    ownerUid: 'alice',
    answer: { test: 'authored' },
  });
  const id = crypto.randomUUID();
  f.docs.documents.set('configuration/evaluation_dispatch', {
    templateEvidenceId: id,
    lifetimeSeconds: 60,
  });
  f.docs.documents.set(`sandboxTemplates/${id}`, {
    schemaVersion: '1.0',
    id,
    templateId: 'authored-evaluator',
    role: 'evaluation',
    imageDigest: 'c'.repeat(64),
    runtimeDigest: 'd'.repeat(64),
    verifiedAt: f.clock().toISOString(),
    expiresAt: '2026-10-31T00:00:00.000Z',
    networkIsolationVerified: true,
    privateAccessVerified: true,
    resourceLimitsVerified: true,
    singlePrivateBuildVerified: true,
    microUsdPerSecondCeiling: 10,
  });
  vi.spyOn(ScientificEligibilityStage.prototype, 'assess').mockResolvedValue(
    {} as Awaited<ReturnType<ScientificEligibilityStage['assess']>>,
  );
  return { ...f, budget: new ScientificBudgetStage(f.docs, f.jobs, f.clock) };
}
afterEach(() => vi.restoreAllMocks());

describe('scientific budget reservation', () => {
  it('reserves and binds one evaluation without dispatch and replays the same operation', async () => {
    const f = await fixture();
    const first = await f.budget.reserve('alice', f.fence);
    const second = await f.budget.reserve('alice', f.fence);
    expect(second.operationId).toBe(first.operationId);
    expect(
      f.docs.documents.get(`operations/${first.operationId}`),
    ).toMatchObject({ outcome: 'reserved', providerHandle: null });
    expect(
      f.docs.documents.get(`sandboxJobs/${first.operationId}`),
    ).toMatchObject({ request: { role: 'evaluation' } });
    const inspect = () =>
      f.docs.transaction(async (tx) =>
        inspectScientificReservation(
          tx,
          'alice',
          f.fence,
          EligibilityInput.parse(
            (await tx.get(`${f.base}/eligibility/current`))?.eligibilityInput,
          ),
          (await tx.get(f.base))!,
          f.clock(),
        ),
      );
    expect(await inspect()).toBe(first.operationId);
    f.docs.documents.get('configuration/e2b_credits')!.availableMicroUsd = 0;
    await expect(inspect()).rejects.toThrow('not covered');
    f.docs.documents.get('configuration/e2b_credits')!.availableMicroUsd =
      20000;
    const leaseId = String(f.docs.documents.get(f.base)!.slotLeaseId);
    f.docs.documents.get(`slotLeases/${leaseId}`)!.status = 'released';
    await expect(inspect()).rejects.toThrow('capacity is not held');
    f.docs.documents.get(`slotLeases/${leaseId}`)!.status = 'held';
    f.docs.documents.get(`operations/${first.operationId}`)!.outcome =
      'dispatching';
    await expect(inspect()).rejects.toThrow('binding changed');
  });
  it('refuses unresolved non-budget facts and changed eligibility before creating an operation', async () => {
    const f = await fixture();
    f.docs.documents.get(
      `${f.base}/eligibility/current`,
    )!.eligibilityInputDigest = '0'.repeat(64);
    await expect(f.budget.reserve('alice', f.fence)).rejects.toThrow(
      'prerequisites changed',
    );
    expect(
      f.docs.documents.has(`scientificBudgetStages/${f.fence.revisionId}`),
    ).toBe(false);
  });
  it('does not reserve when a scientific fact is unknown', async () => {
    const f = await fixture();
    const saved = f.docs.documents.get(`${f.base}/eligibility/current`)!;
    const input = saved.eligibilityInput as {
      assertions: { requirement: string; state: string }[];
    };
    input.assertions.find(
      (item) => item.requirement === 'thermal_weights',
    )!.state = 'unknown';
    saved.eligibilityInputDigest = await sha256(canonicalJson(input));
    saved.assessment = assessEligibility(input);
    saved.assessmentDigest = await sha256(canonicalJson(saved.assessment));
    await expect(f.budget.reserve('alice', f.fence)).rejects.toThrow(
      'Scientific prerequisites are unresolved',
    );
    expect(
      f.docs.documents.has(`scientificBudgetStages/${f.fence.revisionId}`),
    ).toBe(false);
  });
});
