import { z } from 'zod';
import {
  Count,
  Digest,
  Id,
  ResourcePolicy,
  Timestamp,
  DEFAULT_POLICY,
} from '@siphon/contracts';
import { type DocumentStore, type DocumentTransaction } from './firestore.js';
import {
  authorize,
  DispatchFence,
  requireActiveRevision,
  nativeTimestamps,
} from './audit-commands.js';
import { BudgetCounter } from './accounting.js';
import { ApiError } from './errors.js';
import { verifyUploadBytes } from './upload-bytes.js';
import { canonicalJson } from './hashing.js';

export interface DownloadObject {
  size: number;
  sha256: string;
  body: ReadableStream<Uint8Array>;
}
export interface DownloadObjectStore {
  get(key: string, signal: AbortSignal): Promise<DownloadObject | null>;
  getMany?(
    keys: readonly string[],
    signal: AbortSignal,
  ): Promise<Array<DownloadObject | null>>;
}
const periodSchema = z.object({
  counterKey: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  startsAt: Timestamp,
  endsAt: Timestamp,
});

/** Streaming length guard; R2's stored SHA-256 is checked before this stage.
 * Never forwards extra bytes. Client disconnect/deadline cancels upstream.
 */
export function boundedDownload(
  body: ReadableStream<Uint8Array>,
  bytes: number,
  signal: AbortSignal,
) {
  const reader = body.getReader();
  let received = 0;
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = () => signal.removeEventListener('abort', abort);
  const fail = () => {
    if (closed) return;
    closed = true;
    cleanup();
    controller.error(new Error('Artifact transfer interrupted'));
    void reader.cancel().catch(() => undefined);
  };
  const abort = () => fail();
  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) fail();
    },
    async pull(value) {
      if (closed) return;
      try {
        const chunk = await reader.read();
        if (closed) return;
        if (chunk.done) {
          if (received !== bytes) {
            fail();
            return;
          }
          closed = true;
          cleanup();
          reader.releaseLock();
          value.close();
        } else {
          if (
            !(chunk.value instanceof Uint8Array) ||
            chunk.value.byteLength > bytes - received
          ) {
            fail();
            return;
          }
          received += chunk.value.byteLength;
          value.enqueue(chunk.value);
        }
      } catch {
        fail();
      }
    },
    async cancel() {
      closed = true;
      cleanup();
      await reader.cancel().catch(() => undefined);
    },
  });
}

export class ArtifactDownloadService {
  constructor(
    private readonly store: DocumentStore,
    private readonly objects: DownloadObjectStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async inspect(
    tx: DocumentTransaction,
    uid: string,
    auditId: string,
    artifactId: string,
  ) {
    await authorize(tx, uid, auditId, false);
    const artifact = await tx.get(`audits/${auditId}/artifacts/${artifactId}`);
    if (!artifact || artifact.ownerUid !== uid)
      throw new ApiError(404, 'not_found', 'Artifact was not found.');
    if (artifact.lifecycle !== 'ready')
      throw new ApiError(
        409,
        'artifact_not_ready',
        'Artifact is not available.',
      );
    if (
      Date.parse(Timestamp.parse(artifact.expiresAt)) <= this.clock().getTime()
    )
      throw new ApiError(409, 'artifact_expired', 'Artifact has expired.');
    const revisionId = Id.parse(artifact.revisionId);
    const revision = await tx.get(`audits/${auditId}/revisions/${revisionId}`);
    if (!revision || revision.ownerUid !== uid)
      throw new Error('Artifact revision integrity failure');
    const policy = ResourcePolicy.parse(revision.policy);
    const bytes = Count.parse(artifact.bytes);
    const sha256 = Digest.parse(artifact.sha256);
    const key = `audits/${uid}/${auditId}/artifacts/${artifactId}/content`;
    if (
      artifact.objectKey !== key ||
      bytes > Math.max(policy.uploadBytes, policy.outputBytes)
    )
      throw new Error('Artifact metadata integrity failure');
    return { key, bytes, sha256, revisionId, policy };
  }

  /** Internal bounded byte handoff; no HTTP endpoint, source execution or hidden
   * retry. All reads form one preauthorized batch and no bytes leave this method
   * until the complete batch is verified and the current fence is reauthorized.
   */
  async readBatch(
    uid: string,
    expected: unknown,
    artifactIdsValue: readonly string[],
    maximumBytesValue: number,
    callerSignal?: AbortSignal,
  ) {
    const fence = DispatchFence.parse(expected);
    const artifactIds = z
      .array(Id)
      .min(1)
      .max(DEFAULT_POLICY.uploadFiles)
      .refine((ids) => new Set(ids).size === ids.length)
      .parse(artifactIdsValue);
    const maximumBytes = Count.refine(
      (value) => value > 0 && value <= DEFAULT_POLICY.uploadBytes,
    ).parse(maximumBytesValue);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
    signal.throwIfAborted();
    const operationId = `download_batch_${crypto.randomUUID()}`;
    const artifactPaths = artifactIds.map(
      (id) => `audits/${fence.auditId}/artifacts/${id}`,
    );
    const revisionPath = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
    const preloadRevisions = async (
      tx: DocumentTransaction,
      records: Array<Record<string, unknown> | null>,
    ) => {
      const revisions = records.map((artifact) => {
        if (!artifact || artifact.ownerUid !== uid)
          throw new ApiError(404, 'not_found', 'Artifact was not found.');
        return `audits/${fence.auditId}/revisions/${Id.parse(artifact.revisionId)}`;
      });
      await tx.getMany([...new Set(revisions)]);
    };
    const initial = await this.store.transaction(async (tx) => {
      const records = await tx.getMany([
        ...artifactPaths,
        'configuration/r2_class_b_period',
        `testers/${uid}`,
        `audits/${fence.auditId}`,
        revisionPath,
      ]);
      await requireActiveRevision(tx, uid, fence);
      const revision = await tx.get(revisionPath);
      const policy = ResourcePolicy.parse(revision?.policy);
      if (
        artifactIds.length > policy.uploadFiles ||
        maximumBytes > policy.uploadBytes
      )
        throw new ApiError(
          413,
          'batch_too_large',
          'Artifact batch exceeds its allowance.',
        );
      await preloadRevisions(tx, records.slice(0, artifactIds.length));
      const artifacts = [];
      let readCeiling = policy.monthlyClassB;
      for (const artifactId of artifactIds) {
        const artifact = await this.inspect(tx, uid, fence.auditId, artifactId);
        readCeiling = Math.min(readCeiling, artifact.policy.monthlyClassB);
        artifacts.push({
          artifactId,
          key: artifact.key,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          revisionId: artifact.revisionId,
        });
      }
      const total = artifacts.reduce(
        (sum, file) => sum + BigInt(file.bytes),
        0n,
      );
      if (total > BigInt(maximumBytes))
        throw new ApiError(
          413,
          'batch_too_large',
          'Artifact batch exceeds its allowance.',
        );
      const period = periodSchema.safeParse(records[artifactIds.length]);
      if (
        !period.success ||
        this.clock().getTime() < Date.parse(period.data.startsAt) ||
        this.clock().getTime() >= Date.parse(period.data.endsAt)
      )
        throw new ApiError(
          429,
          'budget_unverified',
          'R2 read accounting requires verification.',
        );
      const counter = BudgetCounter.parse(
        await tx.get(`budgets/${period.data.counterKey}`),
      );
      if (
        counter.halted ||
        BigInt(counter.spent) +
          BigInt(counter.reserved) +
          BigInt(artifacts.length) >
          BigInt(Math.min(counter.limit, readCeiling))
      )
        throw new ApiError(
          429,
          'budget_exhausted',
          'R2 read allowance is exhausted.',
        );
      const journal = {
        schemaVersion: '1.0',
        kind: 'artifact_get_batch',
        ownerUid: uid,
        ...fence,
        counterKey: period.data.counterKey,
        artifacts,
        totalBytes: Number(total),
        outcome: 'dispatching',
        createdAt: this.clock().toISOString(),
        updatedAt: this.clock().toISOString(),
      };
      signal.throwIfAborted();
      tx.set(`budgets/${period.data.counterKey}`, {
        ...counter,
        spent: counter.spent + artifacts.length,
      });
      tx.set(`operations/${operationId}`, nativeTimestamps(journal));
      return { artifacts, journal, policy };
    });
    const matchesJournal = (record: Record<string, unknown> | null) =>
      record !== null &&
      canonicalJson({ ...record, createdAt: null, updatedAt: null }) ===
        canonicalJson({ ...initial.journal, createdAt: null, updatedAt: null });
    try {
      signal.throwIfAborted();
      // Start the bounded preauthorized group before awaiting any result. Each
      // promise owns and disposes its stream; all settle before failure returns.
      const batch = this.objects.getMany
        ? await this.objects.getMany(
            initial.artifacts.map((item) => item.key),
            signal,
          )
        : null;
      if (batch && batch.length !== initial.artifacts.length) {
        await Promise.allSettled(batch.map((item) => item?.body.cancel()));
        throw new Error('Private storage batch identity count mismatch');
      }
      const results = await Promise.allSettled(
        initial.artifacts.map(async (artifact, index) => {
          const object = batch
            ? batch[index]
            : await this.objects.get(artifact.key, signal);
          if (!object)
            throw new ApiError(
              404,
              'artifact_missing',
              'Artifact content is unavailable.',
            );
          try {
            signal.throwIfAborted();
            if (
              object.size !== artifact.bytes ||
              object.sha256 !== artifact.sha256
            )
              throw new ApiError(
                503,
                'artifact_integrity',
                'Artifact integrity could not be verified.',
              );
            const verified = await verifyUploadBytes(
              object.body,
              artifact.bytes,
              artifact.sha256,
              maximumBytes,
              signal,
            );
            return {
              artifactId: artifact.artifactId,
              bytes: verified.bytes,
              sha256: verified.sha256,
            };
          } finally {
            await object.body.cancel().catch(() => undefined);
          }
        }),
      );
      const files = results.map((result) => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      });
      signal.throwIfAborted();
      await this.store.transaction(async (tx) => {
        const records = await tx.getMany([
          ...artifactPaths,
          `operations/${operationId}`,
          `testers/${uid}`,
          `audits/${fence.auditId}`,
          revisionPath,
        ]);
        await requireActiveRevision(tx, uid, fence);
        const revision = await tx.get(revisionPath);
        if (
          canonicalJson(ResourcePolicy.parse(revision?.policy)) !==
          canonicalJson(initial.policy)
        )
          throw new Error('Artifact batch policy changed');
        await preloadRevisions(tx, records.slice(0, artifactIds.length));
        const operation = records[artifactIds.length]!;
        if (!matchesJournal(operation))
          throw new Error('Artifact batch journal changed');
        for (const original of initial.artifacts) {
          const current = await this.inspect(
            tx,
            uid,
            fence.auditId,
            original.artifactId,
          );
          if (
            current.key !== original.key ||
            current.bytes !== original.bytes ||
            current.sha256 !== original.sha256 ||
            current.revisionId !== original.revisionId
          )
            throw new Error('Artifact changed during batch read');
        }
        signal.throwIfAborted();
        tx.set(
          `operations/${operationId}`,
          nativeTimestamps({
            ...operation,
            outcome: 'opened',
            updatedAt: this.clock().toISOString(),
          }),
        );
      });
      signal.throwIfAborted();
      return files;
    } catch (error) {
      // All attempts remain charged conservatively, including cancellation before
      // a provider response. An outcome update never refunds or grants access.
      try {
        await this.store.transaction(async (tx) => {
          const operation = await tx.get(`operations/${operationId}`);
          if (matchesJournal(operation))
            tx.set(
              `operations/${operationId}`,
              nativeTimestamps({
                ...operation,
                outcome: 'unknown',
                updatedAt: this.clock().toISOString(),
              }),
            );
        });
      } catch {
        /* Keep the pre-dispatch charge/journal when outcome recording is uncertain. */
      }
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        503,
        'download_unavailable',
        'Artifact download is unavailable.',
        true,
      );
    }
  }

  async get(
    uid: string,
    auditId: string,
    artifactId: string,
    request: Request,
  ): Promise<Response> {
    Id.parse(artifactId);
    if (request.headers.has('Range'))
      throw new ApiError(
        422,
        'range_unsupported',
        'Download the complete artifact.',
      );
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(30_000),
    ]);
    signal.throwIfAborted();
    const operationId = `download_${crypto.randomUUID()}`;
    const initial = await this.store.transaction(async (tx) => {
      const artifact = await this.inspect(tx, uid, auditId, artifactId);
      const period = periodSchema.safeParse(
        await tx.get('configuration/r2_class_b_period'),
      );
      if (
        !period.success ||
        this.clock().getTime() < Date.parse(period.data.startsAt) ||
        this.clock().getTime() >= Date.parse(period.data.endsAt)
      )
        throw new ApiError(
          429,
          'budget_unverified',
          'R2 read accounting requires verification.',
        );
      const counter = BudgetCounter.parse(
        await tx.get(`budgets/${period.data.counterKey}`),
      );
      if (
        counter.halted ||
        BigInt(counter.spent) + BigInt(counter.reserved) + 1n >
          BigInt(Math.min(counter.limit, artifact.policy.monthlyClassB))
      )
        throw new ApiError(
          429,
          'budget_exhausted',
          'R2 read allowance is exhausted.',
        );
      tx.set(`budgets/${period.data.counterKey}`, {
        ...counter,
        spent: counter.spent + 1,
      });
      tx.set(`operations/${operationId}`, {
        schemaVersion: '1.0',
        kind: 'artifact_get',
        ownerUid: uid,
        auditId,
        artifactId,
        revisionId: artifact.revisionId,
        counterKey: period.data.counterKey,
        outcome: 'dispatching',
        createdAt: this.clock(),
        updatedAt: this.clock(),
      });
      return artifact;
    });
    let object: DownloadObject | null = null;
    try {
      signal.throwIfAborted();
      object = await this.objects.get(initial.key, signal);
      signal.throwIfAborted();
      if (!object)
        throw new ApiError(
          404,
          'artifact_missing',
          'Artifact content is unavailable.',
        );
      if (object.size !== initial.bytes || object.sha256 !== initial.sha256)
        throw new ApiError(
          503,
          'artifact_integrity',
          'Artifact integrity could not be verified.',
        );
      await this.store.transaction(async (tx) => {
        const current = await this.inspect(tx, uid, auditId, artifactId);
        const operation = await tx.get(`operations/${operationId}`);
        if (
          !operation ||
          current.sha256 !== initial.sha256 ||
          current.bytes !== initial.bytes
        )
          throw new Error('Artifact changed during download');
        tx.set(`operations/${operationId}`, {
          ...operation,
          outcome: 'opened',
          createdAt: new Date(String(operation.createdAt)),
          updatedAt: this.clock(),
        });
      });
      signal.throwIfAborted();
      return new Response(boundedDownload(object.body, initial.bytes, signal), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="siphon-${artifactId}.bin"`,
          'Content-Length': String(initial.bytes),
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Content-SHA256': initial.sha256,
        },
      });
    } catch (error) {
      if (object) await object.body.cancel().catch(() => undefined);
      // Attempt remains charged, including an ambiguous provider failure. No retries.
      try {
        await this.store.transaction(async (tx) => {
          const operation = await tx.get(`operations/${operationId}`);
          if (operation?.outcome === 'dispatching')
            tx.set(`operations/${operationId}`, {
              ...operation,
              outcome: 'unknown',
              createdAt: new Date(String(operation.createdAt)),
              updatedAt: this.clock(),
            });
        });
      } catch {
        // The pre-dispatch charge/journal remains authoritative if settlement fails.
      }
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        503,
        'download_unavailable',
        'Artifact download is unavailable.',
        true,
      );
    }
  }
}
