import { z } from 'zod';
import {
  Audit,
  CancellationReceipt,
  DeletionReceipt,
  Id,
  Timestamp,
} from '@siphon/contracts';
import { type DocumentStore, type DocumentTransaction } from './firestore.js';
import { ApiError } from './errors.js';
import { canonicalJson, sha256 } from './hashing.js';
import { RevisionState, transition } from './lifecycle.js';

const terminalStatuses = new Set([
  'completed',
  'partial',
  'failed',
  'cancelled',
  'unsupported',
]);

/** Restore native timestamps when writing a document previously decoded for application use. */
export function nativeTimestamps(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      key.endsWith('At') && typeof value === 'string'
        ? new Date(Timestamp.parse(value))
        : value,
    ]),
  );
}

function validateAccessIdentity(uid: string, auditId: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(uid))
    throw new ApiError(
      403,
      'unsupported_identity',
      'Identity cannot access this service.',
    );
  Id.parse(auditId);
}

function authorizedAudit(
  tester: Record<string, unknown> | null,
  record: Record<string, unknown> | null,
  uid: string,
  allowDeleted: boolean,
): Audit {
  if (tester?.active !== true)
    throw new ApiError(
      403,
      'invitation_required',
      'An active invitation is required.',
    );
  if (
    !record ||
    record.ownerUid !== uid ||
    (!allowDeleted && record.deletionRequestedAt !== null)
  )
    throw new ApiError(404, 'not_found', 'Audit was not found.');
  return Audit.parse(record);
}

export async function authorize(
  tx: DocumentTransaction | DocumentStore,
  uid: string,
  auditId: string,
  allowDeleted: boolean,
): Promise<Audit> {
  validateAccessIdentity(uid, auditId);
  const [tester, record] = await tx.getMany([
    `testers/${uid}`,
    `audits/${auditId}`,
  ]);
  return authorizedAudit(tester!, record!, uid, allowDeleted);
}

export function stateFrom(record: Record<string, unknown>): RevisionState {
  return RevisionState.parse(
    Object.fromEntries(
      Object.keys(RevisionState.shape).map((key) => [key, record[key]]),
    ),
  );
}

export async function receiptKey(
  uid: string,
  route: string,
  key: string,
): Promise<string> {
  if (!/^[\x21-\x7e]{1,128}$/.test(key))
    throw new ApiError(
      422,
      'invalid_idempotency_key',
      'Provide a valid Idempotency-Key.',
    );
  return sha256(canonicalJson({ uid, route, key }));
}

function writeMaintenance(
  tx: DocumentTransaction,
  id: string,
  audit: Audit,
  revisionId: string,
  kind: 'cancel_revision' | 'delete_audit',
  now: Date,
): void {
  tx.set(`maintenance/${id}`, {
    schemaVersion: '1.0',
    id,
    kind,
    auditId: audit.id,
    ownerUid: audit.ownerUid,
    revisionId,
    status: 'pending',
    phase: 'terminate_and_reconcile',
    cursor: null,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
  });
}

/** Durable commands only. Provider kill and recursive cleanup are performed by a maintenance worker. */
export class AuditCommands {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async cancel(
    uid: string,
    auditId: string,
    revisionId: string,
    key: string,
  ): Promise<CancellationReceipt> {
    Id.parse(revisionId);
    const requestId = await receiptKey(
      uid,
      `POST /audits/${auditId}/revisions/${revisionId}/cancel`,
      key,
    );
    const maintenanceId = await sha256(
      `cancel_revision:${auditId}:${revisionId}`,
    );
    const now = this.clock();
    return this.store.transaction(async (tx) => {
      const audit = await authorize(tx, uid, auditId, false);
      const previous = await tx.get(`requests/${requestId}`);
      if (previous) return CancellationReceipt.parse(previous.result);
      const record = await tx.get(`audits/${auditId}/revisions/${revisionId}`);
      if (!record || record.ownerUid !== uid)
        throw new ApiError(404, 'not_found', 'Revision was not found.');
      const state = stateFrom(record);
      if (state.auditId !== auditId || state.revisionId !== revisionId)
        throw new Error('Stored revision identity mismatch');
      const job = await tx.get(`maintenance/${maintenanceId}`);
      // Cancellation is idempotent even with a fresh client key; do not reset cleanup progress.
      if (state.status !== 'cancelled' && terminalStatuses.has(state.status))
        throw new ApiError(
          409,
          'already_finished',
          'This revision has already finished.',
        );
      if (
        state.status !== 'cancelled' &&
        audit.currentRevisionId !== revisionId
      )
        throw new ApiError(
          409,
          'stale_revision',
          'Only the current revision can be cancelled.',
        );
      const next =
        state.status === 'cancelled'
          ? state
          : transition(state, state, {
              kind: 'cancel',
              requestedAt: now.toISOString(),
            });
      const result = CancellationReceipt.parse({
        schemaVersion: '1.0',
        auditId,
        revisionId,
        requestedAt: next.cancellationRequestedAt,
        cleanup: job?.status === 'completed' ? 'confirmed' : 'pending',
      });
      if (state.status !== 'cancelled') {
        tx.set(
          `audits/${auditId}/revisions/${revisionId}`,
          nativeTimestamps({
            ...record,
            ...next,
            updatedAt: now.toISOString(),
          }),
        );
        tx.set(
          `audits/${auditId}`,
          nativeTimestamps({ ...audit, updatedAt: now.toISOString() }),
        );
      }
      if (!job)
        writeMaintenance(
          tx,
          maintenanceId,
          audit,
          revisionId,
          'cancel_revision',
          now,
        );
      tx.set(`requests/${requestId}`, {
        schemaVersion: '1.0',
        ownerUid: uid,
        auditId,
        result,
        createdAt: now,
        updatedAt: now,
      });
      return result;
    });
  }

  async remove(
    uid: string,
    auditId: string,
    key: string,
  ): Promise<DeletionReceipt> {
    const requestId = await receiptKey(uid, `DELETE /audits/${auditId}`, key);
    const maintenanceId = await sha256(`delete_audit:${auditId}`);
    const now = this.clock();
    return this.store.transaction(async (tx) => {
      const audit = await authorize(tx, uid, auditId, true);
      const previous = await tx.get(`requests/${requestId}`);
      if (previous) return DeletionReceipt.parse(previous.result);
      const revisionPath = `audits/${auditId}/revisions/${audit.currentRevisionId}`;
      const record = await tx.get(revisionPath);
      if (!record || record.ownerUid !== uid)
        throw new Error('Current revision missing');
      const state = stateFrom(record);
      if (
        state.auditId !== auditId ||
        state.revisionId !== audit.currentRevisionId
      )
        throw new Error('Stored revision identity mismatch');
      const job = await tx.get(`maintenance/${maintenanceId}`);
      const requestedAt = audit.deletionRequestedAt ?? now.toISOString();
      const result = DeletionReceipt.parse({
        schemaVersion: '1.0',
        auditId,
        requestedAt,
        cleanup: job?.status === 'completed' ? 'confirmed' : 'pending',
      });
      if (audit.deletionRequestedAt === null) {
        tx.set(
          `audits/${auditId}`,
          nativeTimestamps({
            ...audit,
            deletionRequestedAt: requestedAt,
            updatedAt: now.toISOString(),
          }),
        );
        if (!terminalStatuses.has(state.status)) {
          const next = transition(state, state, {
            kind: 'cancel',
            requestedAt,
          });
          tx.set(
            revisionPath,
            nativeTimestamps({
              ...record,
              ...next,
              updatedAt: now.toISOString(),
            }),
          );
        }
      }
      if (!job)
        writeMaintenance(
          tx,
          maintenanceId,
          audit,
          audit.currentRevisionId,
          'delete_audit',
          now,
        );
      tx.set(`requests/${requestId}`, {
        schemaVersion: '1.0',
        ownerUid: uid,
        auditId,
        result,
        createdAt: now,
        updatedAt: now,
      });
      return result;
    });
  }
}

export const DispatchFence = z.strictObject({
  auditId: Id,
  revisionId: Id,
  generation: z.number().int().nonnegative(),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Invoke inside the SAME transaction as budget reservation/result publication, never as a precheck. */
export async function requireActiveRevision(
  tx: DocumentTransaction,
  uid: string,
  expected: z.infer<typeof DispatchFence>,
): Promise<RevisionState> {
  const fence = DispatchFence.parse(expected);
  validateAccessIdentity(uid, fence.auditId);
  const [tester, auditRecord, record] = await tx.getMany([
    `testers/${uid}`,
    `audits/${fence.auditId}`,
    `audits/${fence.auditId}/revisions/${fence.revisionId}`,
  ]);
  const audit = authorizedAudit(tester!, auditRecord!, uid, false);
  if (!record || record.ownerUid !== uid)
    throw new ApiError(404, 'not_found', 'Revision was not found.');
  const state = stateFrom(record);
  if (
    audit.currentRevisionId !== fence.revisionId ||
    state.auditId !== fence.auditId ||
    state.revisionId !== fence.revisionId ||
    state.generation !== fence.generation ||
    state.inputDigest !== fence.inputDigest ||
    state.cancellationRequestedAt !== null ||
    state.status !== 'running'
  )
    throw new ApiError(
      409,
      'stale_revision',
      'Revision is no longer authorized to publish or dispatch work.',
    );
  return state;
}
