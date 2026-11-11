import { z } from 'zod';
import { Count, EligibilityInput, Id, ResourcePolicy } from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import { DispatchFence, requireActiveRevision } from './audit-commands.js';
import { ScientificEligibilityStage } from './scientific-eligibility-stage.js';
import { assessEligibility } from './eligibility.js';
import { canonicalJson, sha256 } from './hashing.js';
import { SandboxRequest } from './e2b-client.js';
import {
  SandboxTemplateEvidence,
  expectedCharges,
  type SandboxJobs,
} from './sandbox-jobs.js';
import { AdmissionRepository } from './admission.js';
import { Operation, reserveOperation } from './accounting.js';
import { FirestoreAccountingStore } from './firestore-accounting.js';

const Configuration = z.strictObject({
  templateEvidenceId: Id,
  lifetimeSeconds: Count.refine((value) => value > 0),
});

/** Reserve one evaluation sandbox only after every non-budget prerequisite for
 * at least one released check is satisfied. Binding does not dispatch it. */
export class ScientificBudgetStage {
  constructor(
    private readonly store: DocumentStore,
    private readonly jobs: Pick<SandboxJobs, 'bind'>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async reserve(uid: string, expected: unknown) {
    const fence = DispatchFence.parse(expected);
    const base = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
    // Recompute from current owner-bound evidence before considering resources.
    await new ScientificEligibilityStage(this.store, this.clock).assess(
      uid,
      fence,
    );
    const stage = await this.store.transaction(async (tx) => {
      const state = await requireActiveRevision(tx, uid, fence);
      const [revision, eligibility, questions, prior, plan, configuration] =
        await tx.getMany([
          base,
          `${base}/eligibility/current`,
          `${base}/scientificQuestions/current`,
          `scientificBudgetStages/${fence.revisionId}`,
          `${base}/plans/current`,
          'configuration/evaluation_dispatch',
        ]);
      const input = EligibilityInput.parse(eligibility?.eligibilityInput);
      const inputDigest = await sha256(canonicalJson(input));
      const assessment = assessEligibility(input);
      const baseInput = EligibilityInput.parse({
        ...input,
        assertions: input.assertions.filter(
          (item) => item.requirement !== 'resource_budget_available',
        ),
      });
      const baseInputDigest = await sha256(canonicalJson(baseInput));
      if (
        state.stage !== 'adapting' ||
        plan ||
        eligibility?.ownerUid !== uid ||
        eligibility.auditId !== fence.auditId ||
        eligibility.revisionId !== fence.revisionId ||
        eligibility.inputDigest !== fence.inputDigest ||
        eligibility.eligibilityInputDigest !== inputDigest ||
        eligibility.assessmentDigest !==
          (await sha256(canonicalJson(assessment))) ||
        canonicalJson(eligibility.assessment) !== canonicalJson(assessment) ||
        questions?.ownerUid !== uid ||
        questions.answer == null
      )
        throw new Error('Scientific reservation prerequisites changed');
      const eligibleExceptBudget = assessEligibility(baseInput).decisions.some(
        (decision) =>
          decision.released &&
          decision.status === 'unresolved' &&
          decision.reasons.length > 0 &&
          decision.reasons.every(
            (reason) =>
              reason.requirement === 'resource_budget_available' &&
              ['missing', 'unknown'].includes(reason.code),
          ),
      );
      if (!eligibleExceptBudget)
        throw new Error('Scientific prerequisites are unresolved');
      if (prior) {
        if (
          prior.ownerUid !== uid ||
          prior.auditId !== fence.auditId ||
          prior.revisionId !== fence.revisionId ||
          prior.inputDigest !== fence.inputDigest ||
          prior.generation !== fence.generation ||
          prior.eligibilityInputDigest !== baseInputDigest
        )
          throw new Error('Scientific reservation snapshot changed');
        const operationId = Id.parse(prior.operationId);
        const request = SandboxRequest.parse(prior.request);
        if (
          request.operationId !== operationId ||
          request.auditId !== fence.auditId ||
          request.revisionId !== fence.revisionId ||
          request.inputDigest !== fence.inputDigest ||
          request.role !== 'evaluation'
        )
          throw new Error('Scientific reservation request changed');
        return { operationId, request };
      }
      const config = Configuration.parse(configuration);
      const evidence = SandboxTemplateEvidence.parse(
        await tx.get(`sandboxTemplates/${config.templateEvidenceId}`),
      );
      const policy = ResourcePolicy.parse(revision?.policy);
      const now = this.clock();
      if (
        evidence.id !== config.templateEvidenceId ||
        evidence.role !== 'evaluation' ||
        Date.parse(evidence.verifiedAt) > now.getTime() ||
        Date.parse(evidence.expiresAt) <=
          now.getTime() + config.lifetimeSeconds * 1000 ||
        config.lifetimeSeconds > policy.sandboxLifetimeSeconds
      )
        throw new Error('Verified evaluation runtime is unavailable');
      const operationId = crypto.randomUUID();
      const request = SandboxRequest.parse({
        operationId,
        auditId: fence.auditId,
        revisionId: fence.revisionId,
        inputDigest: fence.inputDigest,
        role: 'evaluation',
        templateId: evidence.templateId,
        ...(evidence.templateBuildId
          ? { templateBuildId: evidence.templateBuildId }
          : {}),
        ...(evidence.templateTag ? { templateTag: evidence.templateTag } : {}),
        templateEvidenceId: evidence.id,
        lifetimeSeconds: config.lifetimeSeconds,
      });
      tx.set(`scientificBudgetStages/${fence.revisionId}`, {
        schemaVersion: '1.0',
        ownerUid: uid,
        ...fence,
        eligibilityInputDigest: baseInputDigest,
        operationId,
        request,
        createdAt: now,
      });
      return { operationId, request };
    });
    const evidence = SandboxTemplateEvidence.parse(
      await this.store.get(
        `sandboxTemplates/${stage.request.templateEvidenceId}`,
      ),
    );
    const cost = Count.parse(
      Number(
        BigInt(evidence.microUsdPerSecondCeiling) *
          BigInt(stage.request.lifetimeSeconds),
      ),
    );
    const now = this.clock().toISOString();
    await new AdmissionRepository(this.store, this.clock).acquire(uid, fence);
    const operation = await reserveOperation(
      new FirestoreAccountingStore(this.store),
      Operation.parse({
        schemaVersion: '1.0',
        id: stage.operationId,
        ownerUid: uid,
        auditId: fence.auditId,
        revisionId: fence.revisionId,
        inputDigest: fence.inputDigest,
        fence: fence.generation,
        requestDigest: await sha256(canonicalJson(stage.request)),
        outcome: 'reserved',
        usage: null,
        providerHandle: null,
        charges: expectedCharges(stage.request, cost),
        createdAt: now,
        updatedAt: now,
      }),
    );
    if (operation.outcome !== 'reserved')
      throw new Error(
        'Scientific reservation already dispatched or reconciled',
      );
    await this.jobs.bind(stage.request);
    // Re-read current provider-credit and reservation evidence before the
    // resource requirement can become satisfied. A failure leaves the
    // reservation durable for explicit replay or reconciliation.
    await new ScientificEligibilityStage(this.store, this.clock).assess(
      uid,
      fence,
    );
    return { operationId: stage.operationId, request: stage.request };
  }
}
