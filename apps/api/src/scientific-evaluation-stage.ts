import { z } from 'zod';
import {
  AdapterProposal,
  Answer,
  AuditPlan,
  BaselineComparison,
  ConservationJobRequest,
  EligibilityInput,
  Id,
  QuestionSet,
  Timestamp,
} from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import {
  authorize,
  DispatchFence,
  requireActiveRevision,
} from './audit-commands.js';
import { inspectScientificReservation } from './scientific-reservation.js';
import { inspectStoredObservationSnapshot } from './stored-observations.js';
import { FidelityRequest } from './fidelity-runner.js';
import { HeatParameterValues } from './scientific-parameters.js';
import { interpretContextAnswers } from './context-questions.js';
import { SandboxRequest } from './e2b-client.js';
import { canonicalJson, sha256 } from './hashing.js';
import { assessEligibility } from './eligibility.js';

/** Builds a durable request from the saved plan and baseline, without running
 * source or dispatching a sandbox. The execution gate rechecks all evidence. */
export class ScientificEvaluationStage {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async prepare(uid: string, expected: unknown) {
    const fence = DispatchFence.parse(expected),
      base = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
    return this.store.transaction(async (tx) => {
      const audit = await authorize(tx, uid, fence.auditId, false);
      const state = await requireActiveRevision(tx, uid, fence);
      const [
        revision,
        rawPlan,
        rawAdapter,
        resolution,
        eligibility,
        budget,
        parameters,
        prior,
      ] = await tx.getMany([
        base,
        `${base}/plans/current`,
        `${base}/adapters/current`,
        `${base}/contextAnswerResolution/current`,
        `${base}/eligibility/current`,
        `scientificBudgetStages/${fence.revisionId}`,
        `${base}/scientificParameters/current`,
        `scientificEvaluationStages/${fence.revisionId}`,
      ]);
      if (
        state.stage !== 'evaluating' ||
        !revision ||
        !rawPlan ||
        !rawAdapter ||
        !resolution ||
        !eligibility ||
        !budget
      )
        throw new Error('Scientific evaluator prerequisites unavailable');
      const plan = AuditPlan.parse(rawPlan.plan),
        adapter = AdapterProposal.parse(rawAdapter.proposal),
        input = EligibilityInput.parse(eligibility.eligibilityInput);
      const planDigest = await sha256(canonicalJson(plan)),
        adapterDigest = await sha256(canonicalJson(adapter)),
        now = this.clock();
      const resolutionCore = Object.fromEntries(
        Object.entries(resolution).filter(
          ([key]) =>
            ![
              'ownerUid',
              'resolutionDigest',
              'createdAt',
              'updatedAt',
            ].includes(key),
        ),
      );
      if (
        rawPlan.ownerUid !== uid ||
        rawPlan.auditId !== fence.auditId ||
        rawPlan.revisionId !== fence.revisionId ||
        rawPlan.inputDigest !== fence.inputDigest ||
        rawPlan.planDigest !== planDigest ||
        Date.parse(Timestamp.parse(rawPlan.expiresAt)) <= now.getTime() ||
        plan.auditId !== fence.auditId ||
        plan.revisionId !== fence.revisionId ||
        plan.inputDigest !== fence.inputDigest ||
        plan.domain !== audit.domain ||
        rawAdapter.ownerUid !== uid ||
        rawAdapter.inputDigest !== fence.inputDigest ||
        rawAdapter.status !== 'verified' ||
        BaselineComparison.parse(rawAdapter.baseline).status !== 'matched' ||
        Date.parse(Timestamp.parse(rawAdapter.expiresAt)) <= now.getTime() ||
        rawAdapter.adapterDigest !== adapterDigest ||
        plan.adapterDigest !== adapterDigest ||
        adapter.contextDigest !== plan.contextDigest ||
        eligibility.ownerUid !== uid ||
        eligibility.auditId !== fence.auditId ||
        eligibility.revisionId !== fence.revisionId ||
        eligibility.inputDigest !== fence.inputDigest ||
        eligibility.eligibilityInputDigest !==
          (await sha256(canonicalJson(input))) ||
        canonicalJson(eligibility.assessment) !==
          canonicalJson(plan.assessment) ||
        canonicalJson(assessEligibility(input)) !==
          canonicalJson(plan.assessment) ||
        resolution.ownerUid !== uid ||
        resolution.inputDigest !== fence.inputDigest ||
        resolution.resolutionDigest !==
          (await sha256(canonicalJson(resolutionCore)))
      )
        throw new Error('Scientific evaluator snapshot changed');
      const baseInput = EligibilityInput.parse({
        ...input,
        assertions: input.assertions.filter(
          (item) => item.requirement !== 'resource_budget_available',
        ),
      });
      const operationId = await inspectScientificReservation(
        tx,
        uid,
        fence,
        baseInput,
        revision,
        now,
      );
      if (!operationId || rawPlan.evaluationOperationId !== operationId)
        throw new Error('Scientific evaluator reservation unavailable');
      const sourceId = Id.parse(rawAdapter.adaptedOperationId);
      const source = await inspectStoredObservationSnapshot(
        tx,
        uid,
        sourceId,
        operationId,
        fence,
        false,
        now,
      );
      if (
        source.plan.outputDigest !== plan.experiments[0]?.resultDigest ||
        (await sha256(canonicalJson(source.adapter))) !== adapterDigest
      )
        throw new Error('Scientific evaluator observations changed');
      const comparisonId = Id.parse(rawAdapter.comparisonOperationId);
      const [comparison, validation] = await tx.getMany([
        `fidelityExecutions/${comparisonId}`,
        `baselineValidationStages/${fence.revisionId}_adapted`,
      ]);
      const fidelity = FidelityRequest.parse(comparison?.request);
      if (
        comparison?.ownerUid !== uid ||
        comparison.auditId !== fence.auditId ||
        comparison.revisionId !== fence.revisionId ||
        comparison.inputDigest !== fence.inputDigest ||
        comparison.operationId !== comparisonId ||
        comparison.status !== 'published' ||
        comparison.payloadDigest !== (await sha256(canonicalJson(fidelity))) ||
        fidelity.adapted.sourceOperationId !== sourceId ||
        fidelity.adapted.adapterDigest !== adapterDigest ||
        validation?.ownerUid !== uid ||
        validation.auditId !== fence.auditId ||
        validation.revisionId !== fence.revisionId ||
        validation.inputDigest !== fence.inputDigest ||
        validation.sourceOperationId !== sourceId ||
        validation.operationId !== fidelity.adapted.evaluationOperationId
      )
        throw new Error('Scientific baseline validation changed');
      const basis = QuestionSet.parse(resolution.questionBasis);
      const answers = z
        .array(Answer)
        .max(100)
        .parse(revision.answers)
        .filter((answer) =>
          basis.questions.some((question) => question.id === answer.questionId),
        );
      const declared = interpretContextAnswers(
        audit.domain,
        basis,
        answers,
      ).find((item) => item.field === 'gravity_profile');
      let profile: unknown;
      if (audit.domain === 'heat_diffusion') {
        const values = HeatParameterValues.parse(parameters?.parameters);
        if (
          parameters?.ownerUid !== uid ||
          parameters.auditId !== fence.auditId ||
          parameters.revisionId !== fence.revisionId ||
          parameters.inputDigest !== fence.inputDigest ||
          parameters.planDigest !== planDigest ||
          parameters.declaration !== 'user_supplied' ||
          parameters.parametersDigest !== (await sha256(canonicalJson(values)))
        )
          throw new Error('Thermal parameters changed');
        const isBalance = plan.checks.some(
          (item) => item.checkId === 'H_BALANCE' && item.selection === 'selected',
        );
        profile = {
          kind: isBalance ? 'heat_balance_si' : 'heat_energy_si',
          ...values,
        };
      } else if (
        declared?.state === 'declared' &&
        declared.value === 'fixed_central'
      )
        profile = { kind: 'central_orbit_si' };
      else if (
        declared?.state === 'declared' &&
        declared.value === 'isolated_mutual'
      )
        profile = { kind: 'isolated_orbits_si' };
      else throw new Error('Orbital profile is unresolved');
      const selected = plan.checks.filter(
        (item) => item.selection === 'selected',
      );
      const oldRequest = prior
        ? ConservationJobRequest.parse(prior.request)
        : null;
      const evidenceIds = Object.fromEntries(
        selected.map((item) => [
          item.checkId,
          oldRequest?.evidenceIds[item.checkId] ?? crypto.randomUUID(),
        ]),
      );
      const policies = Object.fromEntries(
        selected.map((item) => [
          item.checkId,
          plan.accuracyPolicies[item.checkId],
        ]),
      );
      const request = ConservationJobRequest.parse({
        schemaVersion: '1.0',
        diagnostic: {
          schemaVersion: '1.0',
          auditId: fence.auditId,
          revisionId: fence.revisionId,
          operationId,
          contextDigest: plan.contextDigest,
          validation: fidelity.adapted,
          profile,
        },
        eligibility: plan.assessment,
        planDigest,
        evidenceIds,
        policies,
      });
      const requestDigest = await sha256(canonicalJson(request));
      const sandbox = SandboxRequest.parse(budget.request);
      if (sandbox.operationId !== operationId)
        throw new Error('Scientific sandbox request changed');
      if (prior) {
        if (
          prior.ownerUid !== uid ||
          prior.auditId !== fence.auditId ||
          prior.revisionId !== fence.revisionId ||
          prior.inputDigest !== fence.inputDigest ||
          prior.generation !== fence.generation ||
          prior.requestDigest !== requestDigest ||
          canonicalJson(prior.request) !== canonicalJson(request)
        )
          throw new Error('Scientific evaluation request conflict');
        return { request, sandbox, requestDigest, replayed: true };
      }
      tx.set(`scientificEvaluationStages/${fence.revisionId}`, {
        schemaVersion: '1.0',
        ownerUid: uid,
        ...fence,
        request,
        requestDigest,
        createdAt: now,
      });
      return { request, sandbox, requestDigest, replayed: false };
    });
  }
}
