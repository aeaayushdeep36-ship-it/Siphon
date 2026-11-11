import { z } from 'zod';
import {
  AdapterProposal,
  Answer,
  AuditPlan,
  BaselineComparison,
  ContextProposal,
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
import { ScientificEligibilityStage } from './scientific-eligibility-stage.js';
import { inspectScientificReservation } from './scientific-reservation.js';
import { inspectStoredObservationSnapshot } from './stored-observations.js';
import { interpretContextAnswers } from './context-questions.js';
import { assessEligibility } from './eligibility.js';
import { buildScientificPlan } from './scientific-plan.js';
import { canonicalJson, sha256 } from './hashing.js';

/** Publish an immutable plan only from a current, reserved, verified snapshot.
 * Publication does not advance the revision or authorize an evaluator. */
export class ScientificPlanStage {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async publish(uid: string, expected: unknown) {
    const fence = DispatchFence.parse(expected);
    const base = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
    await new ScientificEligibilityStage(this.store, this.clock).assess(
      uid,
      fence,
    );
    return this.store.transaction(async (tx) => {
      const audit = await authorize(tx, uid, fence.auditId, false);
      const state = await requireActiveRevision(tx, uid, fence);
      const [
        revision,
        rawContext,
        resolution,
        rawAdapter,
        rawEligibility,
        prior,
      ] = await tx.getMany([
        base,
        `${base}/context/current`,
        `${base}/contextAnswerResolution/current`,
        `${base}/adapters/current`,
        `${base}/eligibility/current`,
        `${base}/plans/current`,
      ]);
      if (
        state.stage !== 'adapting' ||
        !revision ||
        !rawContext ||
        !resolution ||
        !rawAdapter ||
        !rawEligibility
      )
        throw new Error('Scientific plan prerequisites unavailable');
      const context = ContextProposal.parse(rawContext.proposal),
        adapter = AdapterProposal.parse(rawAdapter.proposal);
      const baseline = BaselineComparison.parse(rawAdapter.baseline),
        input = EligibilityInput.parse(rawEligibility.eligibilityInput);
      const contextDigest = await sha256(canonicalJson(context)),
        adapterDigest = await sha256(canonicalJson(adapter));
      const assessment = assessEligibility(input),
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
      for (const record of [rawContext, resolution, rawAdapter, rawEligibility])
        if (record.ownerUid !== uid || record.inputDigest !== fence.inputDigest)
          throw new Error('Scientific plan ownership or input changed');
      if (
        context.auditId !== fence.auditId ||
        context.revisionId !== fence.revisionId ||
        context.inputDigest !== fence.inputDigest ||
        context.domain !== audit.domain ||
        adapter.auditId !== fence.auditId ||
        adapter.revisionId !== fence.revisionId ||
        adapter.inputDigest !== fence.inputDigest ||
        adapter.domain !== audit.domain ||
        contextDigest !== rawContext.proposalDigest ||
        adapterDigest !== rawAdapter.adapterDigest ||
        adapter.contextDigest !== contextDigest ||
        input.domain !== audit.domain ||
        input.inputDigest !== fence.inputDigest ||
        input.contextDigest !== contextDigest ||
        input.adapterDigest !== adapterDigest ||
        rawAdapter.status !== 'verified' ||
        baseline.status !== 'matched' ||
        Date.parse(Timestamp.parse(rawAdapter.expiresAt)) <= now.getTime() ||
        resolution.resolutionDigest !==
          (await sha256(canonicalJson(resolutionCore))) ||
        rawEligibility.auditId !== fence.auditId ||
        rawEligibility.revisionId !== fence.revisionId ||
        rawEligibility.eligibilityInputDigest !==
          (await sha256(canonicalJson(input))) ||
        rawEligibility.assessmentDigest !==
          (await sha256(canonicalJson(assessment))) ||
        canonicalJson(rawEligibility.assessment) !== canonicalJson(assessment)
      )
        throw new Error('Scientific plan snapshot changed');
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
      const resource = input.assertions.find(
        (item) => item.requirement === 'resource_budget_available',
      );
      if (
        !operationId ||
        resource?.state !== 'satisfied' ||
        canonicalJson(resource.evidenceIds) !== canonicalJson([operationId])
      )
        throw new Error(
          'Scientific plan requires a current evaluation reservation',
        );
      const sourceOperationId = Id.parse(rawAdapter.adaptedOperationId);
      const source = await inspectStoredObservationSnapshot(
        tx,
        uid,
        sourceOperationId,
        operationId,
        fence,
        false,
        now,
      );
      if ((await sha256(canonicalJson(source.adapter))) !== adapterDigest)
        throw new Error('Scientific plan source adapter changed');
      const basis = QuestionSet.parse(resolution.questionBasis);
      const answers = z
        .array(Answer)
        .max(100)
        .parse(revision.answers)
        .filter((answer) =>
          basis.questions.some((question) => question.id === answer.questionId),
        );
      const declarations = interpretContextAnswers(
        audit.domain,
        basis,
        answers,
      );
      const gravity = declarations.find(
        (item) => item.field === 'gravity_profile',
      );
      const profile =
        audit.domain === 'heat_diffusion'
          ? 'heat_energy_si'
          : gravity?.state === 'declared' && gravity.value === 'fixed_central'
            ? 'central_orbit_si'
            : gravity?.state === 'declared' &&
                gravity.value === 'isolated_mutual'
              ? 'isolated_orbits_si'
              : null;
      if (!profile)
        throw new Error('Scientific evaluation profile is unresolved');
      const plan = buildScientificPlan({
        planId: prior
          ? Id.parse(AuditPlan.parse(prior.plan).id)
          : crypto.randomUUID(),
        auditId: fence.auditId,
        revisionId: fence.revisionId,
        eligibilityInput: input,
        profile,
        sourceOperationId,
        sourceOutputDigest: source.plan.outputDigest,
        createdAt: prior
          ? Timestamp.parse(AuditPlan.parse(prior.plan).createdAt)
          : now.toISOString(),
      });
      const planDigest = await sha256(canonicalJson(plan));
      if (prior) {
        if (
          prior.ownerUid !== uid ||
          prior.auditId !== fence.auditId ||
          prior.revisionId !== fence.revisionId ||
          prior.inputDigest !== fence.inputDigest ||
          prior.evaluationOperationId !== operationId ||
          Date.parse(Timestamp.parse(prior.expiresAt)) <= now.getTime() ||
          prior.planDigest !== planDigest ||
          canonicalJson(prior.plan) !== canonicalJson(plan)
        )
          throw new Error('Scientific plan publication conflict');
        return { plan, planDigest, replayed: true };
      }
      tx.set(`${base}/plans/current`, {
        schemaVersion: '1.0',
        ownerUid: uid,
        auditId: fence.auditId,
        revisionId: fence.revisionId,
        inputDigest: fence.inputDigest,
        plan,
        planDigest,
        evaluationOperationId: operationId,
        createdAt: now,
        expiresAt: new Date(Timestamp.parse(rawAdapter.expiresAt)),
      });
      return { plan, planDigest, replayed: false };
    });
  }
}
