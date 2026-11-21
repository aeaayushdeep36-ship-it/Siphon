import {
  Count,
  DEFAULT_POLICY,
  e2bDispatchAllowance,
  EligibilityInput,
  Id,
  ResourcePolicy,
} from '@siphon/contracts';
import { type DocumentTransaction } from './firestore.js';
import { DispatchFence } from './audit-commands.js';
import { BudgetCounter, Operation } from './accounting.js';
import { SandboxRequest } from './e2b-client.js';
import {
  E2bCreditEvidence,
  SandboxJob,
  SandboxTemplateEvidence,
  expectedCharges,
} from './sandbox-jobs.js';
import { canonicalJson, sha256 } from './hashing.js';

/** Resolve an already-bound reservation against current accounting records.
 * This is a planning prerequisite, never an authorization to dispatch. */
export async function inspectScientificReservation(
  tx: DocumentTransaction,
  uid: string,
  expected: unknown,
  baseInput: EligibilityInput,
  revision: Record<string, unknown>,
  now: Date,
): Promise<string | null> {
  const fence = DispatchFence.parse(expected);
  const stage = await tx.get(`scientificBudgetStages/${fence.revisionId}`);
  if (!stage) return null;
  const operationId = Id.parse(stage.operationId);
  const request = SandboxRequest.parse(stage.request);
  if (
    stage.ownerUid !== uid ||
    stage.auditId !== fence.auditId ||
    stage.revisionId !== fence.revisionId ||
    stage.inputDigest !== fence.inputDigest ||
    stage.generation !== fence.generation ||
    stage.eligibilityInputDigest !== (await sha256(canonicalJson(baseInput))) ||
    request.operationId !== operationId ||
    request.auditId !== fence.auditId ||
    request.revisionId !== fence.revisionId ||
    request.inputDigest !== fence.inputDigest ||
    request.role !== 'evaluation'
  )
    throw new Error('Scientific reservation provenance changed');
  const [rawOperation, rawJob, rawTemplate, rawCredits, rawMoney, rawSeconds] =
    await tx.getMany([
      `operations/${operationId}`,
      `sandboxJobs/${operationId}`,
      `sandboxTemplates/${request.templateEvidenceId}`,
      'configuration/e2b_credits',
      'budgets/e2b_global_micro_usd',
      `budgets/e2b_seconds_${fence.revisionId}`,
    ]);
  // A crash can leave the stage record before a reservation has been bound.
  if (!rawOperation || !rawJob) return null;
  const leaseId = Id.parse(revision.slotLeaseId);
  const [lease, globalSlots, userSlots] = await tx.getMany([
    `slotLeases/${leaseId}`,
    'slots/global',
    `slots/user_${uid}`,
  ]);
  if (
    lease?.id !== leaseId ||
    lease.ownerUid !== uid ||
    lease.auditId !== fence.auditId ||
    lease.revisionId !== fence.revisionId ||
    lease.inputDigest !== fence.inputDigest ||
    lease.status !== 'held' ||
    !Array.isArray(globalSlots?.leaseIds) ||
    !globalSlots.leaseIds.includes(leaseId) ||
    !Array.isArray(userSlots?.leaseIds) ||
    !userSlots.leaseIds.includes(leaseId)
  )
    throw new Error('Scientific execution capacity is not held');
  const operation = Operation.parse(rawOperation),
    job = SandboxJob.parse(rawJob),
    template = SandboxTemplateEvidence.parse(rawTemplate),
    credits = E2bCreditEvidence.parse(rawCredits),
    money = BudgetCounter.parse(rawMoney),
    seconds = BudgetCounter.parse(rawSeconds),
    policy = ResourcePolicy.parse(revision.policy);
  const requestDigest = await sha256(canonicalJson(request));
  const cost = Count.parse(
    Number(
      BigInt(template.microUsdPerSecondCeiling) *
        BigInt(request.lifetimeSeconds),
    ),
  );
  const charges = expectedCharges(request, cost);
  if (
    operation.id !== operationId ||
    operation.ownerUid !== uid ||
    operation.auditId !== fence.auditId ||
    operation.revisionId !== fence.revisionId ||
    operation.inputDigest !== fence.inputDigest ||
    operation.fence !== fence.generation ||
    operation.outcome !== 'reserved' ||
    operation.providerHandle !== null ||
    operation.requestDigest !== requestDigest ||
    canonicalJson(operation.charges) !== canonicalJson(charges) ||
    job.operationId !== operationId ||
    job.ownerUid !== uid ||
    job.requestDigest !== requestDigest ||
    canonicalJson(job.request) !== canonicalJson(request) ||
    job.reservedMicroUsd !== cost ||
    job.evidenceDigest !==
      (await sha256(canonicalJson(job.templateEvidence))) ||
    job.evidenceDigest !== (await sha256(canonicalJson(template))) ||
    template.id !== request.templateEvidenceId ||
    template.templateId !== request.templateId ||
    template.role !== 'evaluation'
  )
    throw new Error('Scientific reservation binding changed');
  if (
    Date.parse(template.verifiedAt) > now.getTime() ||
    Date.parse(credits.verifiedAt) > now.getTime() ||
    Math.min(Date.parse(template.expiresAt), Date.parse(credits.expiresAt)) <=
      now.getTime() + request.lifetimeSeconds * 1000 ||
    request.lifetimeSeconds >
      Math.min(
        policy.sandboxLifetimeSeconds,
        DEFAULT_POLICY.sandboxLifetimeSeconds,
      ) ||
    seconds.limit >
      Math.min(policy.sandboxSeconds, DEFAULT_POLICY.sandboxSeconds) ||
    seconds.halted ||
    money.halted ||
    seconds.reserved < request.lifetimeSeconds ||
    money.reserved < cost ||
    BigInt(seconds.spent) + BigInt(seconds.reserved) > BigInt(seconds.limit) ||
    BigInt(money.spent) + BigInt(money.reserved) > BigInt(money.limit) ||
    money.limit >
      Math.min(
        e2bDispatchAllowance(credits.allocationMicroUsd, policy),
        e2bDispatchAllowance(credits.allocationMicroUsd),
      ) ||
    money.spent < credits.accountedSpentMicroUsd ||
    BigInt(money.spent - credits.accountedSpentMicroUsd) +
      BigInt(money.reserved) >
      BigInt(
        Math.min(
          e2bDispatchAllowance(credits.availableMicroUsd, policy),
          e2bDispatchAllowance(credits.availableMicroUsd),
        ),
      )
  )
    throw new Error(
      'Scientific reservation is not covered by current verified resources',
    );
  return operationId;
}
