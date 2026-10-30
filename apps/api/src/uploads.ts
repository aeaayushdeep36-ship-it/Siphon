import { z } from 'zod';
import {
  Answer,
  Id,
  ReserveUpload,
  ResourcePolicy,
  UploadEntry,
  UploadReservation,
  preflightUploads,
} from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import {
  authorize,
  nativeTimestamps,
  receiptKey,
  stateFrom,
} from './audit-commands.js';
import { ApiError } from './errors.js';
import { BudgetCounter } from './accounting.js';
import { canonicalJson, sha256 } from './hashing.js';
import { RETENTION } from './retention.js';

export class UploadRepository {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async reserve(
    uid: string,
    auditId: string,
    revisionId: string,
    value: ReserveUpload,
    key: string,
  ): Promise<{ reservation: UploadReservation; replayed: boolean }> {
    Id.parse(revisionId);
    const input = ReserveUpload.parse(value);
    const requestId = await receiptKey(
      uid,
      `POST /audits/${auditId}/revisions/${revisionId}/artifacts`,
      key,
    );
    const requestDigest = await sha256(canonicalJson(input));
    const artifactId = crypto.randomUUID();
    return this.store.transaction(async (tx) => {
      const audit = await authorize(tx, uid, auditId, false);
      const previous = await tx.get(`requests/${requestId}`);
      if (previous) {
        if (previous.requestDigest !== requestDigest)
          throw new ApiError(
            409,
            'idempotency_conflict',
            'This key was already used with different input.',
          );
        return {
          reservation: UploadReservation.parse(previous.result),
          replayed: true,
        };
      }
      if (audit.currentRevisionId !== revisionId)
        throw new ApiError(
          409,
          'stale_revision',
          'This revision is no longer current.',
        );
      const path = `audits/${auditId}/revisions/${revisionId}`;
      const record = await tx.get(path);
      if (!record || record.ownerUid !== uid)
        throw new ApiError(404, 'not_found', 'Revision was not found.');
      const state = stateFrom(record);
      if (state.auditId !== auditId || state.revisionId !== revisionId)
        throw new Error('Stored revision identity mismatch');
      if (
        state.stage !== 'draft' ||
        state.status !== 'idle' ||
        state.cancellationRequestedAt !== null
      )
        throw new ApiError(
          409,
          'revision_frozen',
          'Create a draft successor before changing these inputs.',
        );
      if (
        state.generation !== input.expectedGeneration ||
        state.inputDigest !== input.expectedInputDigest
      )
        throw new ApiError(
          409,
          'stale_revision',
          'The revision changed before this request.',
        );
      const policy = ResourcePolicy.parse(record.policy);
      const manifest = z.array(UploadEntry).parse(record.sourceManifest);
      const answers = z.array(Answer).parse(record.answers);
      if (
        (await sha256(canonicalJson({ uploads: manifest, answers }))) !==
        state.inputDigest
      )
        throw new Error('Revision input digest mismatch');
      const entry = UploadEntry.parse({
        schemaVersion: '1.0',
        artifactId,
        path: input.path,
        bytes: input.bytes,
        sha256: input.sha256,
      });
      const nextManifest = [...manifest, entry].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
      const check = preflightUploads(nextManifest, policy);
      if (check.reasons.some((reason) => reason !== 'python_source_required'))
        throw new ApiError(
          422,
          'invalid_upload_manifest',
          'The upload exceeds file limits or duplicates an existing path.',
        );
      const budgetRecord = await tx.get('budgets/r2_storage_bytes');
      if (!budgetRecord)
        throw new ApiError(
          429,
          'budget_unverified',
          'Storage allowance has not been configured.',
        );
      const budget = BudgetCounter.parse(budgetRecord);
      const reserved = BigInt(budget.reserved) + BigInt(input.bytes);
      if (
        budget.halted ||
        reserved + BigInt(budget.spent) >
          BigInt(Math.min(budget.limit, policy.storageBytes))
      )
        throw new ApiError(
          429,
          'budget_exhausted',
          'Storage allowance is exhausted.',
        );
      const now = this.clock();
      const inputDigest = await sha256(
        canonicalJson({ uploads: nextManifest, answers }),
      );
      const result = UploadReservation.parse({
        ...entry,
        auditId,
        revisionId,
        inputDigest,
        generation: state.generation + 1,
        lifecycle: 'reserved',
        uploadExpiresAt: new Date(
          now.getTime() + RETENTION.abandonedUploadHours * 3600_000,
        ).toISOString(),
        expiresAt: new Date(
          now.getTime() + RETENTION.rawDays * 86400_000,
        ).toISOString(),
      });
      tx.set(`audits/${auditId}/artifacts/${artifactId}`, {
        ...nativeTimestamps(result),
        ownerUid: uid,
        kind: 'upload',
        retentionClass: 'raw',
        retentionVersion: RETENTION.version,
        objectKey: `audits/${uid}/${auditId}/artifacts/${artifactId}/content`,
        createdAt: now,
        updatedAt: now,
      });
      tx.set(
        path,
        nativeTimestamps({
          ...record,
          sourceManifest: nextManifest,
          inputDigest,
          generation: result.generation,
          updatedAt: now.toISOString(),
        }),
      );
      tx.set(
        `audits/${auditId}`,
        nativeTimestamps({ ...audit, updatedAt: now.toISOString() }),
      );
      tx.set('budgets/r2_storage_bytes', {
        ...budget,
        reserved: Number(reserved),
      });
      tx.set(`reservations/${artifactId}`, {
        schemaVersion: '1.0',
        provider: 'r2',
        resource: 'storage_bytes',
        auditId,
        revisionId,
        artifactId,
        ownerUid: uid,
        amount: input.bytes,
        measuredUsage: null,
        disposition: 'reserved',
        reconciliationState: 'awaiting_upload',
        createdAt: now,
        updatedAt: now,
      });
      tx.set(`requests/${requestId}`, {
        schemaVersion: '1.0',
        auditId,
        ownerUid: uid,
        requestDigest,
        result,
        createdAt: now,
        updatedAt: now,
      });
      return { reservation: result, replayed: false };
    });
  }
}
