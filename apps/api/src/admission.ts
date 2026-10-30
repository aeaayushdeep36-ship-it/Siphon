import { z } from 'zod';
import {
  Count,
  Audit,
  Digest,
  DEFAULT_POLICY,
  Id,
  ResourcePolicy,
  Timestamp,
} from '@siphon/contracts';
import { type DocumentStore, type DocumentTransaction } from './firestore.js';
import {
  DispatchFence,
  nativeTimestamps,
  requireActiveRevision,
  stateFrom,
} from './audit-commands.js';
import { ApiError } from './errors.js';
import { Operation } from './accounting.js';
import { sha256 } from './hashing.js';
import { SandboxTermination } from './sandbox-termination.js';

const capacitySchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  leaseIds: z.array(Id).refine((ids) => new Set(ids).size === ids.length),
  updatedAt: Timestamp,
});
const quotaSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  count: Count,
  updatedAt: Timestamp,
});
const leaseSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  id: Id,
  ownerUid: z.string(),
  auditId: Id,
  revisionId: Id,
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['held', 'released']),
  dispatchMayHaveStarted: z.boolean(),
  pendingOperations: Count.default(0),
  // Legacy records cannot establish a complete operation inventory.
  untrackedDispatch: z.boolean().default(true),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
type Lease = z.infer<typeof leaseSchema>;
type Fence = z.infer<typeof DispatchFence>;

const leaseOperationSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  operationId: Id,
  leaseId: Id,
  ownerUid: z.string(),
  auditId: Id,
  revisionId: Id,
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['pending', 'completed']),
  completionKind: z.enum(['model_response', 'sandbox_termination']).nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

async function capacity(tx: DocumentTransaction, path: string, now: Date) {
  return capacityValue(await tx.get(path), now);
}
function capacityValue(
  value: Record<string, unknown> | null | undefined,
  now: Date,
) {
  return capacitySchema.parse(
    value ?? {
      schemaVersion: '1.0',
      leaseIds: [],
      updatedAt: now.toISOString(),
    },
  );
}

function assertLease(lease: Lease, uid: string, fence: Fence): void {
  if (
    lease.ownerUid !== uid ||
    lease.auditId !== fence.auditId ||
    lease.revisionId !== fence.revisionId ||
    lease.inputDigest !== fence.inputDigest ||
    lease.status !== 'held'
  )
    throw new ApiError(
      409,
      'stale_lease',
      'Execution capacity is no longer held.',
    );
}

/** Internal orchestration port, not dispatch authorization by itself.
 * Provider gates must also reserve money/time, validate readiness and journal dispatch.
 * No time-based reclamation: a possibly dispatched lease needs provider reconciliation.
 */
export class AdmissionRepository {
  private readonly policy: ResourcePolicy;
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
    policy: ResourcePolicy = DEFAULT_POLICY,
  ) {
    this.policy = ResourcePolicy.parse(policy);
  }

  async acquire(uid: string, expected: Fence): Promise<Lease> {
    const fence = DispatchFence.parse(expected);
    const id = crypto.randomUUID();
    const now = this.clock();
    return this.store.transaction(async (tx) => {
      await requireActiveRevision(tx, uid, fence);
      const path = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
      const revision = await tx.get(path);
      if (!revision) throw new Error('Revision disappeared');
      const policy = ResourcePolicy.parse(revision.policy);
      const global = await capacity(tx, 'slots/global', now);
      const user = await capacity(tx, `slots/user_${uid}`, now);
      if (revision.slotLeaseId != null) {
        const lease = leaseSchema.parse(
          await tx.get(`slotLeases/${Id.parse(revision.slotLeaseId)}`),
        );
        assertLease(lease, uid, fence);
        if (
          !global.leaseIds.includes(lease.id) ||
          !user.leaseIds.includes(lease.id)
        )
          throw new Error('Capacity ledger is inconsistent');
        return lease;
      }
      if (
        global.leaseIds.length >=
          Math.min(
            policy.globalActiveRevisions,
            this.policy.globalActiveRevisions,
          ) ||
        user.leaseIds.length >=
          Math.min(policy.userActiveRevisions, this.policy.userActiveRevisions)
      )
        throw new ApiError(
          429,
          'capacity_exhausted',
          'Execution capacity is occupied.',
          true,
        );
      const lease = leaseSchema.parse({
        schemaVersion: '1.0',
        id,
        ownerUid: uid,
        auditId: fence.auditId,
        revisionId: fence.revisionId,
        inputDigest: fence.inputDigest,
        status: 'held',
        dispatchMayHaveStarted: false,
        pendingOperations: 0,
        untrackedDispatch: false,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      tx.set('slots/global', {
        ...global,
        leaseIds: [...global.leaseIds, id],
        updatedAt: now,
      });
      tx.set(`slots/user_${uid}`, {
        ...user,
        leaseIds: [...user.leaseIds, id],
        updatedAt: now,
      });
      tx.set(`slotLeases/${id}`, nativeTimestamps(lease));
      tx.set(
        path,
        nativeTimestamps({
          ...revision,
          slotLeaseId: id,
          updatedAt: now.toISOString(),
        }),
      );
      return lease;
    });
  }

  /** Invoke before the FIRST possible paid dispatch, never after contacting a provider.
   * A crash after this commit consumes admission conservatively; it is not refundable.
   * Repeated calls do not authorize repeated provider calls: operation journaling is separate.
   */
  async markDispatching(
    uid: string,
    expected: Fence,
    leaseId: string,
  ): Promise<void> {
    const fence = DispatchFence.parse(expected);
    Id.parse(leaseId);
    const now = this.clock();
    await this.store.transaction(async (tx) => {
      const commit = await prepareAdmissionDispatch(
        tx,
        uid,
        fence,
        leaseId,
        now,
        this.policy,
      );
      commit();
    });
  }

  /** Only safe before markDispatching. No force flag, timeout refund or client release. */
  async releaseUnused(
    uid: string,
    expected: Fence,
    leaseId: string,
  ): Promise<void> {
    return this.release(uid, expected, leaseId, false);
  }

  /** Live workflow release after every tracked operation has confirmed completion. */
  async releaseReconciled(
    uid: string,
    expected: Fence,
    leaseId: string,
  ): Promise<void> {
    return this.release(uid, expected, leaseId, true);
  }

  /** Server maintenance only. Frees capacity, not artifacts or money; never marks cleanup complete. */
  async releaseForMaintenance(
    maintenanceId: string,
  ): Promise<'released' | 'no_lease'> {
    Digest.parse(maintenanceId);
    const now = this.clock();
    return this.store.transaction(async (tx) => {
      const job = await tx.get(`maintenance/${maintenanceId}`);
      if (
        !job ||
        job.id !== maintenanceId ||
        !['cancel_revision', 'delete_audit'].includes(String(job.kind))
      )
        throw new Error('Invalid capacity maintenance task');
      const auditId = Id.parse(job.auditId);
      const revisionId = Id.parse(job.revisionId);
      const expectedId = await sha256(
        job.kind === 'cancel_revision'
          ? `cancel_revision:${auditId}:${revisionId}`
          : `delete_audit:${auditId}`,
      );
      if (expectedId !== maintenanceId)
        throw new Error('Maintenance identity mismatch');
      const audit = Audit.parse(await tx.get(`audits/${auditId}`));
      const path = `audits/${auditId}/revisions/${revisionId}`;
      const revision = await tx.get(path);
      if (
        !revision ||
        revision.ownerUid !== audit.ownerUid ||
        job.ownerUid !== audit.ownerUid
      )
        throw new Error('Maintenance ownership mismatch');
      const state = stateFrom(revision);
      if (
        state.auditId !== auditId ||
        state.revisionId !== revisionId ||
        (job.kind === 'delete_audit'
          ? audit.deletionRequestedAt === null
          : state.status !== 'cancelled' ||
            state.cancellationRequestedAt === null)
      )
        throw new Error(
          'Maintenance requires durable cancellation or deletion',
        );
      if (revision.activeOperationId != null)
        throw new ApiError(
          409,
          'reconciliation_required',
          'Active execution must be reconciled.',
        );
      if (revision.slotLeaseId == null) {
        tx.set(
          `maintenance/${maintenanceId}`,
          nativeTimestamps({
            ...job,
            capacityReleasedAt: job.capacityReleasedAt ?? now.toISOString(),
            updatedAt: now.toISOString(),
          }),
        );
        return 'no_lease';
      }
      const leaseId = Id.parse(revision.slotLeaseId);
      const lease = leaseSchema.parse(await tx.get(`slotLeases/${leaseId}`));
      assertLease(lease, audit.ownerUid, state);
      if (
        lease.pendingOperations !== 0 ||
        (lease.dispatchMayHaveStarted && lease.untrackedDispatch)
      )
        throw new ApiError(
          409,
          'reconciliation_required',
          'Uncertain execution still holds capacity.',
        );
      const global = await capacity(tx, 'slots/global', now);
      const user = await capacity(tx, `slots/user_${audit.ownerUid}`, now);
      if (
        !global.leaseIds.includes(leaseId) ||
        !user.leaseIds.includes(leaseId)
      )
        throw new Error('Capacity ledger is inconsistent');
      tx.set('slots/global', {
        ...global,
        leaseIds: global.leaseIds.filter((id) => id !== leaseId),
        updatedAt: now,
      });
      tx.set(`slots/user_${audit.ownerUid}`, {
        ...user,
        leaseIds: user.leaseIds.filter((id) => id !== leaseId),
        updatedAt: now,
      });
      tx.set(
        `slotLeases/${leaseId}`,
        nativeTimestamps({
          ...lease,
          status: 'released',
          updatedAt: now.toISOString(),
        }),
      );
      tx.set(
        path,
        nativeTimestamps({
          ...revision,
          slotLeaseId: null,
          updatedAt: now.toISOString(),
        }),
      );
      tx.set(
        `maintenance/${maintenanceId}`,
        nativeTimestamps({
          ...job,
          capacityReleasedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        }),
      );
      return 'released';
    });
  }

  private async release(
    uid: string,
    expected: Fence,
    leaseId: string,
    reconciled: boolean,
  ): Promise<void> {
    const fence = DispatchFence.parse(expected);
    Id.parse(leaseId);
    const now = this.clock();
    await this.store.transaction(async (tx) => {
      await requireActiveRevision(tx, uid, fence);
      const path = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
      const revision = await tx.get(path);
      const lease = leaseSchema.parse(await tx.get(`slotLeases/${leaseId}`));
      if (lease.id !== leaseId) throw new Error('Capacity lease key mismatch');
      if (lease.status === 'released') {
        const global = await capacity(tx, 'slots/global', now);
        const user = await capacity(tx, `slots/user_${uid}`, now);
        if (
          lease.ownerUid !== uid ||
          lease.auditId !== fence.auditId ||
          lease.revisionId !== fence.revisionId ||
          lease.inputDigest !== fence.inputDigest ||
          !revision ||
          revision.slotLeaseId === leaseId ||
          global.leaseIds.includes(leaseId) ||
          user.leaseIds.includes(leaseId) ||
          lease.pendingOperations !== 0 ||
          (lease.dispatchMayHaveStarted && lease.untrackedDispatch)
        )
          throw new Error(
            'Released capacity lease identity or ledger mismatch',
          );
        return;
      }
      assertLease(lease, uid, fence);
      if (
        !revision ||
        revision.slotLeaseId !== leaseId ||
        (lease.dispatchMayHaveStarted &&
          (!reconciled ||
            lease.untrackedDispatch ||
            lease.pendingOperations !== 0))
      )
        throw new ApiError(
          409,
          'reconciliation_required',
          'Capacity cannot be released without execution reconciliation.',
        );
      const global = await capacity(tx, 'slots/global', now);
      const user = await capacity(tx, `slots/user_${uid}`, now);
      if (
        !global.leaseIds.includes(leaseId) ||
        !user.leaseIds.includes(leaseId)
      )
        throw new Error('Capacity ledger is inconsistent');
      tx.set('slots/global', {
        ...global,
        leaseIds: global.leaseIds.filter((id) => id !== leaseId),
        updatedAt: now,
      });
      tx.set(`slots/user_${uid}`, {
        ...user,
        leaseIds: user.leaseIds.filter((id) => id !== leaseId),
        updatedAt: now,
      });
      tx.set(
        `slotLeases/${leaseId}`,
        nativeTimestamps({
          ...lease,
          status: 'released',
          updatedAt: now.toISOString(),
        }),
      );
      tx.set(
        path,
        nativeTimestamps({
          ...revision,
          slotLeaseId: null,
          updatedAt: now.toISOString(),
        }),
      );
    });
  }
}

/** Read/validate now, return writes to apply after all accounting reads/checks.
 * The caller MUST invoke the closure inside the same transaction; no provider I/O.
 */
export async function prepareAdmissionDispatch(
  tx: DocumentTransaction,
  uid: string,
  fence: Fence,
  leaseId: string,
  now: Date,
  serverPolicy: ResourcePolicy = DEFAULT_POLICY,
  operation?: Operation,
): Promise<() => void> {
  DispatchFence.parse(fence);
  Id.parse(leaseId);
  ResourcePolicy.parse(serverPolicy);
  const day = now.toISOString().slice(0, 10);
  const writes: Array<() => void> = [];
  const write = (path: string, value: Record<string, unknown>) => {
    writes.push(() => tx.set(path, value));
  };
  await requireActiveRevision(tx, uid, fence);
  const path = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
  const [revision, leaseValue, globalValue, userValue, priorLink] =
    await tx.getMany([
      path,
      `slotLeases/${leaseId}`,
      'slots/global',
      `slots/user_${uid}`,
      ...(operation ? [`leaseOperations/${operation.id}`] : []),
    ]);
  const lease = leaseSchema.parse(leaseValue);
  assertLease(lease, uid, fence);
  if (!revision || revision.slotLeaseId !== leaseId)
    throw new ApiError(
      409,
      'stale_lease',
      'Revision does not hold this capacity.',
    );
  const global = capacityValue(globalValue, now);
  const user = capacityValue(userValue, now);
  if (!global.leaseIds.includes(leaseId) || !user.leaseIds.includes(leaseId))
    throw new Error('Capacity ledger is inconsistent');
  const policy = ResourcePolicy.parse(revision.policy);
  if (operation) {
    Operation.parse(operation);
    if (
      operation.ownerUid !== uid ||
      operation.auditId !== fence.auditId ||
      operation.revisionId !== fence.revisionId ||
      operation.inputDigest !== fence.inputDigest ||
      operation.fence !== fence.generation ||
      operation.outcome !== 'reserved'
    )
      throw new Error('Dispatch operation identity mismatch');
    if (priorLink)
      throw new Error('Dispatch operation is already linked to capacity');
  }
  if (revision.admittedAt == null) {
    const globalPath = `dailyQuotas/global_${day}`;
    const userPath = `dailyQuotas/user_${uid}_${day}`;
    const empty = {
      schemaVersion: '1.0',
      count: 0,
      updatedAt: now.toISOString(),
    };
    const [globalRecord, userRecord] = await tx.getMany([globalPath, userPath]);
    const globalQuota = quotaSchema.parse(globalRecord ?? empty);
    const userQuota = quotaSchema.parse(userRecord ?? empty);
    if (
      globalQuota.count >=
        Math.min(
          policy.globalDailyAdmissions,
          serverPolicy.globalDailyAdmissions,
        ) ||
      userQuota.count >=
        Math.min(policy.userDailyAdmissions, serverPolicy.userDailyAdmissions)
    )
      throw new ApiError(
        429,
        'admission_exhausted',
        'Daily audit admission limit reached.',
        true,
      );
    write(globalPath, {
      ...globalQuota,
      count: globalQuota.count + 1,
      updatedAt: now,
    });
    write(userPath, {
      ...userQuota,
      count: userQuota.count + 1,
      updatedAt: now,
    });
  } else {
    Timestamp.parse(revision.admittedAt);
  }
  write(
    path,
    nativeTimestamps({
      ...revision,
      admittedAt: revision.admittedAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    }),
  );
  write(
    `slotLeases/${leaseId}`,
    nativeTimestamps({
      ...lease,
      dispatchMayHaveStarted: true,
      pendingOperations: Count.parse(
        lease.pendingOperations + (operation ? 1 : 0),
      ),
      untrackedDispatch: lease.untrackedDispatch || !operation,
      updatedAt: now.toISOString(),
    }),
  );

  if (operation)
    write(`leaseOperations/${operation.id}`, {
      schemaVersion: '1.0',
      operationId: operation.id,
      leaseId,
      ownerUid: uid,
      auditId: fence.auditId,
      revisionId: fence.revisionId,
      inputDigest: fence.inputDigest,
      requestDigest: operation.requestDigest,
      status: 'pending',
      completionKind: null,
      createdAt: now,
      updatedAt: now,
    });

  return () => {
    for (const write of writes) write();
  };
}

/** Called only by ModelJobs after verified model-response settlement, not by clients
 * or generic financial settlement.
 */
export async function confirmModelOperationEnded(
  store: DocumentStore,
  operationId: string,
  now: Date,
): Promise<void> {
  return confirmOperationEnded(store, operationId, now, 'model_response');
}

export async function confirmSandboxOperationEnded(
  store: DocumentStore,
  operationId: string,
  now: Date,
): Promise<void> {
  return confirmOperationEnded(store, operationId, now, 'sandbox_termination');
}

async function confirmOperationEnded(
  store: DocumentStore,
  operationId: string,
  now: Date,
  kind: 'model_response' | 'sandbox_termination',
): Promise<void> {
  Id.parse(operationId);
  await store.transaction(async (tx) => {
    const rawLink = await tx.get(`leaseOperations/${operationId}`);
    // Older untracked operations cannot free a slot through this path.
    if (!rawLink) return;
    const link = leaseOperationSchema.parse(rawLink);
    const [operationValue, job, leaseValue, proofValue] = await tx.getMany([
      `operations/${operationId}`,
      `${kind === 'model_response' ? 'modelJobs' : 'sandboxJobs'}/${operationId}`,
      `slotLeases/${link.leaseId}`,
      ...(kind === 'sandbox_termination'
        ? [`sandboxTerminations/${operationId}`]
        : []),
    ]);
    const operation = Operation.parse(operationValue);
    if (kind === 'sandbox_termination') {
      const proof = SandboxTermination.parse(proofValue);
      if (
        proof.operationId !== operationId ||
        proof.sandboxId !== operation.providerHandle ||
        proof.ownerUid !== operation.ownerUid ||
        proof.auditId !== operation.auditId ||
        proof.revisionId !== operation.revisionId ||
        proof.inputDigest !== operation.inputDigest ||
        proof.requestDigest !== operation.requestDigest ||
        operation.outcome === 'reserved'
      )
        throw new Error('Sandbox termination identity mismatch');
    }
    const lease = leaseSchema.parse(leaseValue);
    if (
      !job ||
      job.operationId !== operationId ||
      job.requestDigest !== operation.requestDigest ||
      link.operationId !== operationId ||
      link.ownerUid !== operation.ownerUid ||
      link.auditId !== operation.auditId ||
      link.revisionId !== operation.revisionId ||
      link.inputDigest !== operation.inputDigest ||
      link.requestDigest !== operation.requestDigest ||
      lease.ownerUid !== link.ownerUid ||
      lease.auditId !== link.auditId ||
      lease.revisionId !== link.revisionId ||
      lease.inputDigest !== link.inputDigest ||
      (kind === 'model_response' &&
        (!['succeeded', 'failed'].includes(operation.outcome) ||
          !operation.usage))
    )
      throw new Error(
        'Completion does not prove this tracked model operation ended',
      );
    if (link.status === 'completed') {
      if (link.completionKind !== kind)
        throw new Error('Invalid completion proof');
      return;
    }
    if (lease.status !== 'held' || lease.pendingOperations < 1)
      throw new Error('Capacity operation inventory is inconsistent');
    tx.set(
      `slotLeases/${lease.id}`,
      nativeTimestamps({
        ...lease,
        pendingOperations: lease.pendingOperations - 1,
        updatedAt: now.toISOString(),
      }),
    );
    tx.set(
      `leaseOperations/${operationId}`,
      nativeTimestamps({
        ...link,
        status: 'completed',
        completionKind: kind,
        updatedAt: now.toISOString(),
      }),
    );
  });
}
