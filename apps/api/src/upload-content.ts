import { z } from 'zod';
import {
  Count,
  Digest,
  Id,
  ResourcePolicy,
  Timestamp,
  UploadEntry,
} from '@siphon/contracts';
import { type DocumentStore, type DocumentTransaction } from './firestore.js';
import { authorize, nativeTimestamps, stateFrom } from './audit-commands.js';
import { BudgetCounter } from './accounting.js';
import { ApiError } from './errors.js';
import { type UploadObjectStore } from './r2-upload.js';
import { verifyUploadBytes } from './upload-bytes.js';

const periodSchema = z.object({
  counterKey: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  startsAt: Timestamp,
  endsAt: Timestamp,
});

export class UploadContentService {
  constructor(
    private readonly store: DocumentStore,
    private readonly objects: UploadObjectStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async inspect(
    tx: DocumentTransaction,
    uid: string,
    auditId: string,
    revisionId: string,
    artifactId: string,
  ) {
    const audit = await authorize(tx, uid, auditId, false);
    const revision = await tx.get(`audits/${auditId}/revisions/${revisionId}`);
    const artifact = await tx.get(`audits/${auditId}/artifacts/${artifactId}`);
    if (
      !revision ||
      revision.ownerUid !== uid ||
      !artifact ||
      artifact.ownerUid !== uid ||
      artifact.revisionId !== revisionId
    )
      throw new ApiError(404, 'not_found', 'Upload was not found.');
    const state = stateFrom(revision);
    const entry = z
      .array(UploadEntry)
      .parse(revision.sourceManifest)
      .find((value) => value.artifactId === artifactId);
    if (
      !entry ||
      entry.sha256 !== artifact.sha256 ||
      entry.bytes !== artifact.bytes ||
      entry.path !== artifact.path
    )
      throw new Error('Upload manifest integrity failure');
    if (state.auditId !== auditId || state.revisionId !== revisionId)
      throw new Error('Revision identity mismatch');
    if (
      Date.parse(Timestamp.parse(artifact.expiresAt)) <= this.clock().getTime()
    )
      throw new ApiError(409, 'artifact_expired', 'Upload has expired.');
    if (artifact.lifecycle !== 'ready') {
      if (
        artifact.lifecycle !== 'reserved' ||
        audit.currentRevisionId !== revisionId ||
        state.status !== 'idle' ||
        state.stage !== 'draft'
      )
        throw new ApiError(
          409,
          'revision_frozen',
          'Upload is no longer writable.',
        );
      if (
        Date.parse(Timestamp.parse(artifact.uploadExpiresAt)) <=
        this.clock().getTime()
      )
        throw new ApiError(
          409,
          'artifact_expired',
          'Upload reservation has expired.',
        );
    }
    const objectKey = `audits/${uid}/${auditId}/artifacts/${artifactId}/content`;
    if (artifact.objectKey !== objectKey)
      throw new Error('Object key integrity failure');
    return {
      artifact,
      entry,
      policy: ResourcePolicy.parse(revision.policy),
      objectKey,
    };
  }

  async put(
    uid: string,
    auditId: string,
    revisionId: string,
    artifactId: string,
    request: Request,
  ) {
    Id.parse(revisionId);
    Id.parse(artifactId);
    const initial = await this.store.transaction((tx) =>
      this.inspect(tx, uid, auditId, revisionId, artifactId),
    );
    const length = request.headers.get('Content-Length');
    const digest = request.headers.get('X-Content-SHA256');
    if (
      length !== String(initial.entry.bytes) ||
      digest !== initial.entry.sha256
    )
      throw new ApiError(
        422,
        'upload_precondition',
        'Provide the reserved Content-Length and X-Content-SHA256.',
      );
    const verified = await verifyUploadBytes(
      request.body,
      initial.entry.bytes,
      initial.entry.sha256,
      initial.policy.uploadBytes,
      AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
    );
    const operationId = `upload_${artifactId}`;
    const dispatch = await this.store.transaction(async (tx) => {
      const current = await this.inspect(
        tx,
        uid,
        auditId,
        revisionId,
        artifactId,
      );
      if (current.artifact.lifecycle === 'ready') return false;
      const operation = await tx.get(`operations/${operationId}`);
      if (operation)
        throw new ApiError(
          409,
          'upload_outcome_pending',
          'An upload attempt already exists and must be reconciled.',
        );
      const period = periodSchema.parse(
        await tx.get('configuration/r2_class_a_period'),
      );
      const now = this.clock();
      if (
        now.getTime() < Date.parse(period.startsAt) ||
        now.getTime() >= Date.parse(period.endsAt)
      )
        throw new ApiError(
          429,
          'budget_unverified',
          'R2 accounting period requires verification.',
        );
      const counter = BudgetCounter.parse(
        await tx.get(`budgets/${period.counterKey}`),
      );
      if (
        counter.halted ||
        BigInt(counter.spent) + BigInt(counter.reserved) + 1n >
          BigInt(Math.min(counter.limit, current.policy.monthlyClassA))
      )
        throw new ApiError(
          429,
          'budget_exhausted',
          'R2 write allowance is exhausted.',
        );
      tx.set(`budgets/${period.counterKey}`, {
        ...counter,
        spent: counter.spent + 1,
      });
      tx.set(`operations/${operationId}`, {
        schemaVersion: '1.0',
        kind: 'upload_put',
        auditId,
        revisionId,
        artifactId,
        ownerUid: uid,
        outcome: 'dispatching',
        counterKey: period.counterKey,
        bytes: current.entry.bytes,
        sha256: current.entry.sha256,
        createdAt: now,
        updatedAt: now,
      });
      return true;
    });
    if (!dispatch)
      return {
        schemaVersion: '1.0',
        artifactId,
        lifecycle: 'ready',
        sha256: verified.sha256,
        bytes: verified.bytes.length,
      };
    try {
      const result = await this.objects.putOnce(
        initial.objectKey,
        verified.bytes,
        verified.sha256,
        { expiresAt: Timestamp.parse(initial.artifact.expiresAt) },
      );
      if (
        Count.parse(result.size) !== initial.entry.bytes ||
        Digest.parse(result.sha256) !== initial.entry.sha256
      )
        throw new Error('Stored content integrity mismatch');
      await this.store.transaction(async (tx) => {
        const current = await this.inspect(
          tx,
          uid,
          auditId,
          revisionId,
          artifactId,
        );
        const operation = await tx.get(`operations/${operationId}`);
        const reservation = await tx.get(`reservations/${artifactId}`);
        const counter = BudgetCounter.parse(
          await tx.get('budgets/r2_storage_bytes'),
        );
        if (
          !operation ||
          operation.outcome !== 'dispatching' ||
          !reservation ||
          reservation.disposition !== 'reserved' ||
          reservation.amount !== initial.entry.bytes ||
          counter.reserved < initial.entry.bytes
        )
          throw new Error('Upload accounting mismatch');
        const now = this.clock();
        tx.set(
          `audits/${auditId}/artifacts/${artifactId}`,
          nativeTimestamps({
            ...current.artifact,
            lifecycle: 'ready',
            updatedAt: now.toISOString(),
          }),
        );
        tx.set('budgets/r2_storage_bytes', {
          ...counter,
          reserved: counter.reserved - initial.entry.bytes,
          spent: Count.parse(counter.spent + initial.entry.bytes),
        });
        tx.set(
          `reservations/${artifactId}`,
          nativeTimestamps({
            ...reservation,
            measuredUsage: initial.entry.bytes,
            disposition: 'settled',
            reconciliationState: 'confirmed',
            updatedAt: now.toISOString(),
          }),
        );
        tx.set(
          `operations/${operationId}`,
          nativeTimestamps({
            ...operation,
            outcome: 'succeeded',
            updatedAt: now.toISOString(),
          }),
        );
      });
    } catch {
      // A write may have succeeded even when the provider or commit response was lost.
      // Retain storage and operation accounting; never retry automatically or publish bytes.
      await this.store
        .transaction(async (tx) => {
          const operation = await tx.get(`operations/${operationId}`);
          if (operation?.outcome === 'dispatching')
            tx.set(
              `operations/${operationId}`,
              nativeTimestamps({
                ...operation,
                outcome: 'unknown',
                updatedAt: this.clock().toISOString(),
              }),
            );
        })
        .catch(() => undefined);
      throw new ApiError(
        503,
        'upload_outcome_unknown',
        'Upload outcome requires reconciliation. Do not create another write attempt.',
      );
    }
    return {
      schemaVersion: '1.0',
      artifactId,
      lifecycle: 'ready',
      sha256: verified.sha256,
      bytes: verified.bytes.length,
    };
  }
}
