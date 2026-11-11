import { AuditPlan, EligibilityInput, Id, Timestamp } from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import {
  DispatchFence,
  nativeTimestamps,
  requireActiveRevision,
} from './audit-commands.js';
import { Operation } from './accounting.js';
import { inspectScientificReservation } from './scientific-reservation.js';
import { inspectStoredObservationSnapshot } from './stored-observations.js';
import { persistProgress } from './progress.js';
import { transition } from './lifecycle.js';
import { canonicalJson, sha256 } from './hashing.js';
import { assessEligibility } from './eligibility.js';
import { HeatParameterValues } from './scientific-parameters.js';

/** Move exactly one stage while atomically carrying a still-undispatched
 * evaluation reservation to the next revision generation. This does not
 * create a sandbox, bind a numeric request, or authorize dispatch. */
export class ScientificExecutionTransition {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async advance(uid: string, expected: unknown) {
    const fence = DispatchFence.parse(expected);
    const base = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
    return this.store.transaction(async (tx) => {
      const state = await requireActiveRevision(tx, uid, fence);
      const target: 'planning' | 'executing' | 'evaluating' | null =
        state.stage === 'adapting'
          ? 'planning'
          : state.stage === 'planning'
            ? 'executing'
            : state.stage === 'executing'
              ? 'evaluating'
              : null;
      if (!target)
        throw new Error('Scientific execution cannot advance from this stage');
      const [revision, rawPlan, eligibility, stage, parameters] =
        await tx.getMany([
          base,
          `${base}/plans/current`,
          `${base}/eligibility/current`,
          `scientificBudgetStages/${fence.revisionId}`,
          `${base}/scientificParameters/current`,
        ]);
      if (!revision || !rawPlan || !eligibility || !stage)
        throw new Error('Scientific plan or reservation is unavailable');
      const plan = AuditPlan.parse(rawPlan.plan),
        input = EligibilityInput.parse(eligibility.eligibilityInput),
        now = this.clock();
      const planDigest = await sha256(canonicalJson(plan));
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
        eligibility.ownerUid !== uid ||
        eligibility.auditId !== fence.auditId ||
        eligibility.revisionId !== fence.revisionId ||
        eligibility.inputDigest !== fence.inputDigest ||
        eligibility.eligibilityInputDigest !==
          (await sha256(canonicalJson(input))) ||
        canonicalJson(eligibility.assessment) !==
          canonicalJson(plan.assessment) ||
        canonicalJson(assessEligibility(input)) !==
          canonicalJson(plan.assessment)
      )
        throw new Error('Scientific plan snapshot changed');
      if (plan.domain === 'heat_diffusion') {
        if (!parameters)
          throw new Error('Declared thermal parameters are required');
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
          throw new Error(
            'Declared thermal parameters are unavailable or changed',
          );
      }
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
      if (
        !operationId ||
        rawPlan.evaluationOperationId !== operationId ||
        input.assertions.find(
          (item) => item.requirement === 'resource_budget_available',
        )?.state !== 'satisfied' ||
        canonicalJson(
          input.assertions.find(
            (item) => item.requirement === 'resource_budget_available',
          )?.evidenceIds,
        ) !== canonicalJson([operationId])
      )
        throw new Error('Scientific evaluation reservation changed');
      const selected = plan.checks.filter(
        (item) => item.selection === 'selected',
      );
      if (
        !selected.length ||
        plan.experiments.length !== 1 ||
        selected.some(
          (item) =>
            item.experimentIds.length !== 1 ||
            item.experimentIds[0] !== plan.experiments[0]?.id,
        )
      )
        throw new Error(
          'Scientific plan has no executable observation experiment',
        );
      const sourceId = Id.parse(plan.experiments[0]?.sourceOperationId);
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
        (await sha256(canonicalJson(source.adapter))) !== plan.adapterDigest
      )
        throw new Error('Scientific experiment provenance changed');
      const operation = Operation.parse(
        await tx.get(`operations/${operationId}`),
      );
      const event = {
        kind: 'advance' as const,
        stage: target,
        reason: 'Advance the reviewed scientific plan.',
      };
      const next = transition(state, fence, event);
      await persistProgress(
        tx,
        uid,
        fence.auditId,
        fence,
        {
          activity:
            target === 'planning'
              ? 'planning_checks'
              : target === 'executing'
                ? 'running_experiment'
                : 'evaluating_evidence',
          experiments: { planned: 1, completed: 0 },
        },
        now,
        event,
      );
      tx.set(
        `operations/${operationId}`,
        nativeTimestamps({
          ...operation,
          fence: next.generation,
          updatedAt: now.toISOString(),
        }),
      );
      tx.set(
        `scientificBudgetStages/${fence.revisionId}`,
        nativeTimestamps({
          ...stage,
          generation: next.generation,
          updatedAt: now.toISOString(),
        }),
      );
      return {
        fence: { ...fence, generation: next.generation },
        stage: target,
        operationId,
        planDigest,
      };
    });
  }
}
