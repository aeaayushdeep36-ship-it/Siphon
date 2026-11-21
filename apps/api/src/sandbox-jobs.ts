import { z } from 'zod';
import {
  Count,
  DEFAULT_POLICY,
  e2bDispatchAllowance,
  Digest,
  Id,
  ResourcePolicy,
  Timestamp,
} from '@siphon/contracts';
import { SandboxRequest, type SandboxDispatchGate } from './e2b-client.js';
import {
  Operation,
  BudgetCounter,
  markDispatching,
  settleOperation,
} from './accounting.js';
import { type DocumentStore } from './firestore.js';
import { requireActiveRevision } from './audit-commands.js';
import { canonicalJson, sha256 } from './hashing.js';
import { FirestoreAccountingStore } from './firestore-accounting.js';
import { SandboxTermination } from './sandbox-termination.js';
import { confirmSandboxOperationEnded } from './admission.js';
import { SandboxUsageEvidence } from './sandbox-usage.js';

const ProviderId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const SandboxTemplateEvidence = z.strictObject({
  schemaVersion: z.literal('1.0'),
  id: Id,
  templateId: ProviderId,
  templateBuildId: ProviderId.optional(),
  templateTag: ProviderId.optional(),
  role: SandboxRequest.shape.role,
  imageDigest: Digest,
  runtimeDigest: Digest,
  verifiedAt: Timestamp,
  expiresAt: Timestamp,
  networkIsolationVerified: z.literal(true),
  privateAccessVerified: z.literal(true),
  resourceLimitsVerified: z.literal(true),
  singlePrivateBuildVerified: z.literal(true),
  // Set only after this exact source build has passed numeric input checks.
  numericInputValidation: z.literal('headerless-csv-npy-v1').optional(),
  // Operator-verified bound for this image's complete resource configuration,
  // including billing granularity/fees. No baked-in provider price.
  microUsdPerSecondCeiling: Count.refine((n) => n > 0),
});
export const SandboxJob = z.strictObject({
  schemaVersion: z.literal('1.0'),
  operationId: Id,
  ownerUid: z.string(),
  request: SandboxRequest,
  requestDigest: Digest,
  templateEvidence: SandboxTemplateEvidence,
  evidenceDigest: Digest,
  reservedMicroUsd: Count,
  createdAt: Timestamp,
});

export const E2bCreditEvidence = z.strictObject({
  schemaVersion: z.literal('1.0'),
  evidenceId: Id,
  allocationMicroUsd: Count,
  availableMicroUsd: Count,
  accountedSpentMicroUsd: Count,
  verifiedAt: Timestamp,
  expiresAt: Timestamp,
});

/** Durable creation gate; caller must separately verify role-specific readiness. */
export class SandboxJobs implements SandboxDispatchGate {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
    private readonly requireTemplatePins = false,
  ) {}

  /** Requires final usage from a trusted reconciler plus known termination.
   * Financial completion is independent of scientific success and user access.
   */
  async settle(operationId: string, evidenceId: string): Promise<Operation> {
    Id.parse(operationId);
    Id.parse(evidenceId);
    const now = this.clock();
    const { operation, usage } = await this.store.transaction(async (tx) => {
      const operation = Operation.parse(
        await tx.get(`operations/${operationId}`),
      );
      const job = SandboxJob.parse(await tx.get(`sandboxJobs/${operationId}`));
      const termination = SandboxTermination.parse(
        await tx.get(`sandboxTerminations/${operationId}`),
      );
      const evidence = SandboxUsageEvidence.parse(
        await tx.get(`sandboxUsageEvidence/${evidenceId}`),
      );
      evidence.finalizedAt = new Date(evidence.finalizedAt).toISOString();
      const prior = await tx.get(`sandboxSettlements/${operationId}`);
      const expected = expectedCharges(job.request, job.reservedMicroUsd);
      if (
        job.operationId !== operationId ||
        job.request.operationId !== operationId ||
        job.ownerUid !== operation.ownerUid ||
        job.request.auditId !== operation.auditId ||
        job.request.revisionId !== operation.revisionId ||
        job.request.inputDigest !== operation.inputDigest ||
        job.requestDigest !== operation.requestDigest ||
        job.requestDigest !== (await sha256(canonicalJson(job.request))) ||
        job.evidenceDigest !==
          (await sha256(canonicalJson(job.templateEvidence))) ||
        expected.length !== operation.charges.length ||
        expected.some(
          (charge) =>
            !operation.charges.some(
              (actual) => canonicalJson(actual) === canonicalJson(charge),
            ),
        ) ||
        termination.operationId !== operationId ||
        termination.sandboxId !== operation.providerHandle ||
        termination.ownerUid !== operation.ownerUid ||
        termination.auditId !== operation.auditId ||
        termination.revisionId !== operation.revisionId ||
        termination.inputDigest !== operation.inputDigest ||
        termination.requestDigest !== operation.requestDigest ||
        evidence.id !== evidenceId ||
        evidence.operationId !== operationId ||
        evidence.sandboxId !== operation.providerHandle ||
        evidence.requestDigest !== operation.requestDigest ||
        operation.outcome === 'reserved' ||
        Date.parse(evidence.finalizedAt) < Date.parse(termination.observedAt) ||
        Date.parse(evidence.finalizedAt) > now.getTime()
      )
        throw new Error(
          'Sandbox usage does not match the terminated operation',
        );
      const evidenceDigest = await sha256(canonicalJson(evidence));
      if (
        prior &&
        (prior.evidenceId !== evidenceId ||
          prior.evidenceDigest !== evidenceDigest)
      )
        throw new Error('Sandbox settlement evidence conflict');
      const usage = Object.fromEntries(
        operation.charges.map((charge) => [
          charge.counterKey,
          charge.unit === 'micro_usd'
            ? evidence.chargedMicroUsd
            : charge.unit === 'seconds'
              ? evidence.billableSeconds
              : 1,
        ]),
      );
      if (!prior)
        tx.set(`sandboxSettlements/${operationId}`, {
          schemaVersion: '1.0',
          operationId,
          ownerUid: operation.ownerUid,
          auditId: operation.auditId,
          revisionId: operation.revisionId,
          evidenceId,
          evidenceDigest,
          evidence: {
            ...evidence,
            finalizedAt: new Date(evidence.finalizedAt),
          },
          createdAt: now,
          updatedAt: now,
        });
      return { operation, usage };
    });
    // Persisting immutable evidence first makes a crash recoverable without
    // allowing a replacement statement to refund a different amount.
    return settleOperation(
      new FirestoreAccountingStore(this.store),
      operationId,
      operation.fence,
      usage,
      'succeeded',
      now.toISOString(),
    );
  }

  async authorizeCreate(
    value: Readonly<SandboxRequest>,
    claimedDigest: string,
  ): Promise<void> {
    const request = SandboxRequest.parse(value);
    if (
      this.requireTemplatePins &&
      (!request.templateBuildId || !request.templateTag)
    )
      throw new Error('template_build_unpinned');
    const digest = await sha256(canonicalJson(request));
    if (digest !== Digest.parse(claimedDigest))
      throw new Error('Sandbox request digest mismatch');
    const reserved = Operation.parse(
      await this.store.get(`operations/${request.operationId}`),
    );
    const accounting = new FirestoreAccountingStore(
      this.store,
      DEFAULT_POLICY,
      async (tx, operation) => {
        const now = this.clock().getTime();
        const [
          jobValue,
          evidenceValue,
          creditValue,
          moneyValue,
          revision,
          secondsValue,
          executionsValue,
        ] = await tx.getMany([
          `sandboxJobs/${operation.id}`,
          `sandboxTemplates/${request.templateEvidenceId}`,
          'configuration/e2b_credits',
          'budgets/e2b_global_micro_usd',
          `audits/${request.auditId}/revisions/${request.revisionId}`,
          `budgets/e2b_seconds_${request.revisionId}`,
          ...(request.role === 'source'
            ? [`budgets/source_executions_${request.revisionId}`]
            : []),
        ]);
        const job = SandboxJob.parse(jobValue);
        const liveEvidence = SandboxTemplateEvidence.parse(evidenceValue);
        liveEvidence.verifiedAt = new Date(
          liveEvidence.verifiedAt,
        ).toISOString();
        liveEvidence.expiresAt = new Date(liveEvidence.expiresAt).toISOString();
        const credits = E2bCreditEvidence.parse(creditValue);
        const money = BudgetCounter.parse(moneyValue);
        const policy = ResourcePolicy.parse(revision?.policy);
        if (
          job.operationId !== operation.id ||
          job.ownerUid !== operation.ownerUid ||
          operation.auditId !== request.auditId ||
          operation.revisionId !== request.revisionId ||
          operation.inputDigest !== request.inputDigest ||
          operation.requestDigest !== digest ||
          job.requestDigest !== digest ||
          canonicalJson(job.request) !== canonicalJson(request) ||
          job.evidenceDigest !==
            (await sha256(canonicalJson(job.templateEvidence))) ||
          job.evidenceDigest !== (await sha256(canonicalJson(liveEvidence)))
        )
          throw new Error('Sandbox dispatch binding or approval changed');
        if (
          Date.parse(liveEvidence.verifiedAt) > now ||
          Date.parse(credits.verifiedAt) > now ||
          Math.min(
            Date.parse(liveEvidence.expiresAt),
            Date.parse(credits.expiresAt),
          ) <=
            now + request.lifetimeSeconds * 1000
        )
          throw new Error(
            'Sandbox verification expired or does not cover requested lifetime',
          );
        const cost = Count.parse(
          Number(
            BigInt(liveEvidence.microUsdPerSecondCeiling) *
              BigInt(request.lifetimeSeconds),
          ),
        );
        const expected = expectedCharges(request, cost);
        if (
          job.reservedMicroUsd !== cost ||
          operation.charges.length !== expected.length ||
          expected.some(
            (charge) =>
              !operation.charges.some(
                (actual) => canonicalJson(actual) === canonicalJson(charge),
              ),
          )
        )
          throw new Error('Sandbox dispatch reservation changed');
        const initialAllowance = Math.min(
          e2bDispatchAllowance(credits.allocationMicroUsd, policy),
          e2bDispatchAllowance(credits.allocationMicroUsd),
        );
        const availableAllowance = Math.min(
          e2bDispatchAllowance(credits.availableMicroUsd, policy),
          e2bDispatchAllowance(credits.availableMicroUsd),
        );
        // Snapshot accounting must include all still-reserved work; subtract only
        // spending recorded since that snapshot, without resetting lifetime totals.
        if (
          money.limit > initialAllowance ||
          money.spent < credits.accountedSpentMicroUsd ||
          BigInt(money.spent - credits.accountedSpentMicroUsd) +
            BigInt(money.reserved) >
            BigInt(availableAllowance)
        )
          throw new Error(
            'Verified E2B credit allowance cannot cover outstanding work',
          );
        if (
          request.lifetimeSeconds >
          Math.min(
            policy.sandboxLifetimeSeconds,
            DEFAULT_POLICY.sandboxLifetimeSeconds,
          )
        )
          throw new Error('Sandbox lifetime policy changed');
        const seconds = BudgetCounter.parse(secondsValue);
        if (
          seconds.limit >
          Math.min(policy.sandboxSeconds, DEFAULT_POLICY.sandboxSeconds)
        )
          throw new Error('Sandbox cumulative time limit is invalid');
        if (request.role === 'source') {
          const executions = BudgetCounter.parse(executionsValue);
          if (
            executions.limit >
            Math.min(policy.sourceExecutions, DEFAULT_POLICY.sourceExecutions)
          )
            throw new Error('Source execution limit is invalid');
        }
      },
    );
    await markDispatching(
      accounting,
      request.operationId,
      reserved.fence,
      this.clock().toISOString(),
    );
  }

  async bind(value: SandboxRequest) {
    const request = SandboxRequest.parse(value);
    const requestDigest = await sha256(canonicalJson(request));
    const now = this.clock();
    return this.store.transaction(async (tx) => {
      const operation = Operation.parse(
        await tx.get(`operations/${request.operationId}`),
      );
      await requireActiveRevision(tx, operation.ownerUid, {
        auditId: request.auditId,
        revisionId: request.revisionId,
        generation: operation.fence,
        inputDigest: request.inputDigest,
      });
      if (
        operation.auditId !== request.auditId ||
        operation.revisionId !== request.revisionId ||
        operation.inputDigest !== request.inputDigest ||
        operation.requestDigest !== requestDigest
      )
        throw new Error('Sandbox request does not match reserved operation');
      const prior = await tx.get(`sandboxJobs/${operation.id}`);
      if (prior) {
        const job = SandboxJob.parse(prior);
        if (
          job.requestDigest !== requestDigest ||
          job.ownerUid !== operation.ownerUid ||
          canonicalJson(job.request) !== canonicalJson(request) ||
          job.evidenceDigest !==
            (await sha256(canonicalJson(job.templateEvidence)))
        )
          throw new Error('Sandbox job binding mismatch');
        return job;
      }
      if (operation.outcome !== 'reserved')
        throw new Error('Cannot bind a sandbox after dispatch');
      const revision = await tx.get(
        `audits/${request.auditId}/revisions/${request.revisionId}`,
      );
      const policy = ResourcePolicy.parse(revision?.policy);
      const evidence = SandboxTemplateEvidence.parse(
        await tx.get(`sandboxTemplates/${request.templateEvidenceId}`),
      );
      evidence.verifiedAt = new Date(evidence.verifiedAt).toISOString();
      evidence.expiresAt = new Date(evidence.expiresAt).toISOString();
      if (
        evidence.id !== request.templateEvidenceId ||
        evidence.templateId !== request.templateId ||
        evidence.templateBuildId !== request.templateBuildId ||
        evidence.templateTag !== request.templateTag ||
        evidence.role !== request.role ||
        Date.parse(evidence.verifiedAt) > now.getTime() ||
        Date.parse(evidence.expiresAt) <=
          now.getTime() + request.lifetimeSeconds * 1000 ||
        request.lifetimeSeconds > policy.sandboxLifetimeSeconds
      )
        throw new Error(
          'Template evidence does not cover this sandbox request',
        );
      const cost = Count.parse(
        Number(
          BigInt(evidence.microUsdPerSecondCeiling) *
            BigInt(request.lifetimeSeconds),
        ),
      );
      const expected = expectedCharges(request, cost);
      if (
        operation.charges.length !== expected.length ||
        expected.some(
          (charge) =>
            !operation.charges.some(
              (actual) => canonicalJson(actual) === canonicalJson(charge),
            ),
        )
      )
        throw new Error(
          'Sandbox reservation must cover cost, lifetime and source execution',
        );
      for (const charge of expected) {
        const counter = BudgetCounter.parse(
          await tx.get(`budgets/${charge.counterKey}`),
        );
        if (
          counter.halted ||
          counter.reserved < charge.amount ||
          (charge.unit === 'seconds' &&
            counter.limit > policy.sandboxSeconds) ||
          (charge.unit === 'attempts' &&
            counter.limit > policy.sourceExecutions)
        )
          throw new Error('Sandbox resource budget is invalid');
      }
      const job = SandboxJob.parse({
        schemaVersion: '1.0',
        operationId: operation.id,
        ownerUid: operation.ownerUid,
        request,
        requestDigest,
        templateEvidence: evidence,
        evidenceDigest: await sha256(canonicalJson(evidence)),
        reservedMicroUsd: cost,
        createdAt: now.toISOString(),
      });
      tx.set(`sandboxJobs/${operation.id}`, {
        ...job,
        createdAt: now,
        templateEvidence: {
          ...evidence,
          verifiedAt: new Date(evidence.verifiedAt),
          expiresAt: new Date(evidence.expiresAt),
        },
      });
      return job;
    });
  }

  /** Late create responses must remain journalable even after cancellation or revocation. */
  async recordCreated(operationId: string, sandboxId: string): Promise<void> {
    Id.parse(operationId);
    ProviderId.parse(sandboxId);
    await this.store.transaction(async (tx) => {
      const [operationValue, jobValue, existing] = await tx.getMany([
        `operations/${operationId}`,
        `sandboxJobs/${operationId}`,
        `sandboxHandles/${sandboxId}`,
      ]);
      const operation = Operation.parse(operationValue);
      const job = SandboxJob.parse(jobValue);
      if (
        job.operationId !== operationId ||
        job.requestDigest !== operation.requestDigest ||
        job.ownerUid !== operation.ownerUid ||
        job.request.auditId !== operation.auditId ||
        job.request.revisionId !== operation.revisionId ||
        job.request.inputDigest !== operation.inputDigest ||
        !['dispatching', 'unknown'].includes(operation.outcome)
      )
        throw new Error('Sandbox handle does not match a dispatched job');
      if (
        (operation.providerHandle !== null &&
          operation.providerHandle !== sandboxId) ||
        (existing && existing.operationId !== operationId)
      )
        throw new Error('Sandbox handle is already bound');
      if (existing && operation.providerHandle === sandboxId) return;
      const now = this.clock();
      tx.set(`operations/${operationId}`, {
        ...operation,
        providerHandle: sandboxId,
        createdAt: new Date(operation.createdAt),
        updatedAt: now,
      });
      tx.set(`sandboxHandles/${sandboxId}`, {
        schemaVersion: '1.0',
        sandboxId,
        operationId,
        ownerUid: operation.ownerUid,
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  /** Cleanup authorization uses durable linkage, never a client-supplied sandbox ID alone. */
  async authorizeKill(operationId: string, sandboxId: string): Promise<void> {
    Id.parse(operationId);
    ProviderId.parse(sandboxId);
    await this.store.transaction(async (tx) => {
      const [operationValue, handle] = await tx.getMany([
        `operations/${operationId}`,
        `sandboxHandles/${sandboxId}`,
      ]);
      const operation = Operation.parse(operationValue);
      if (
        !handle ||
        operation.providerHandle !== sandboxId ||
        handle.operationId !== operationId ||
        handle.ownerUid !== operation.ownerUid ||
        handle.auditId !== operation.auditId ||
        handle.revisionId !== operation.revisionId
      )
        throw new Error('Sandbox termination handle is not authorized');
    });
  }

  /** Only the control-plane client supplies this result after an authoritative kill response. */
  async recordTermination(
    operationId: string,
    sandboxId: string,
    outcome: 'killed' | 'not_found',
  ): Promise<void> {
    Id.parse(operationId);
    ProviderId.parse(sandboxId);
    const now = this.clock();
    await this.store.transaction(async (tx) => {
      const [operationValue, handle, jobValue, prior] = await tx.getMany([
        `operations/${operationId}`,
        `sandboxHandles/${sandboxId}`,
        `sandboxJobs/${operationId}`,
        `sandboxTerminations/${operationId}`,
      ]);
      const operation = Operation.parse(operationValue);
      const job = SandboxJob.parse(jobValue);
      if (
        !handle ||
        operation.providerHandle !== sandboxId ||
        handle.operationId !== operationId ||
        handle.ownerUid !== operation.ownerUid ||
        handle.auditId !== operation.auditId ||
        handle.revisionId !== operation.revisionId ||
        job.operationId !== operationId ||
        job.requestDigest !== operation.requestDigest ||
        operation.outcome === 'reserved'
      )
        throw new Error('Termination does not match a dispatched sandbox');
      const proof = SandboxTermination.parse({
        schemaVersion: '1.0',
        operationId,
        sandboxId,
        ownerUid: operation.ownerUid,
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        inputDigest: operation.inputDigest,
        requestDigest: operation.requestDigest,
        outcome,
        observedAt: now.toISOString(),
      });
      if (prior) {
        const saved = SandboxTermination.parse(prior);
        if (
          saved.sandboxId !== sandboxId ||
          saved.requestDigest !== proof.requestDigest ||
          saved.operationId !== operationId ||
          saved.ownerUid !== proof.ownerUid ||
          saved.auditId !== proof.auditId ||
          saved.revisionId !== proof.revisionId ||
          saved.inputDigest !== proof.inputDigest
        )
          throw new Error('Termination proof conflict');
        return;
      }
      tx.set(`sandboxTerminations/${operationId}`, {
        ...proof,
        observedAt: now,
      });
    });
    // A crash between these idempotent steps retains capacity, never frees it early.
    await confirmSandboxOperationEnded(this.store, operationId, now);
  }
}

export function expectedCharges(request: SandboxRequest, cost: number) {
  return [
    {
      counterKey: 'e2b_global_micro_usd',
      unit: 'micro_usd',
      amount: cost,
      consumeOnDispatch: false,
    },
    {
      counterKey: `e2b_seconds_${request.revisionId}`,
      unit: 'seconds',
      amount: request.lifetimeSeconds,
      consumeOnDispatch: false,
    },
    ...(request.role === 'source'
      ? [
          {
            counterKey: `source_executions_${request.revisionId}`,
            unit: 'attempts',
            amount: 1,
            consumeOnDispatch: true,
          },
        ]
      : []),
  ];
}
