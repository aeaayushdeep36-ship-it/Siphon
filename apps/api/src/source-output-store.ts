import { z } from 'zod';
import {
  SourceJobRequest,
  validateSourceJobResult,
  Id,
  Count,
  Digest,
  Timestamp,
  ResourcePolicy,
} from '@siphon/contracts';
import { type DocumentStore, type DocumentTransaction } from './firestore.js';
import { Operation, BudgetCounter } from './accounting.js';
import { requireActiveRevision, nativeTimestamps } from './audit-commands.js';
import { SourceExecutionBinding } from './source-executions.js';
import { SandboxTermination } from './sandbox-termination.js';
import { canonicalJson, sha256 } from './hashing.js';
import { type UploadObjectStore } from './r2-upload.js';
import { RETENTION } from './retention.js';

const Entry = z.strictObject({
  id: Id,
  name: z.string().regex(/^(manifest\.json|obs_[a-z][a-z0-9_]{0,63}\.npy)$/),
  bytes: Count,
  sha256: Digest,
});
export const SourceOutputPlan = z
  .strictObject({
    schemaVersion: z.literal('1.0'),
    operationId: Id,
    ownerUid: z.string(),
    auditId: Id,
    revisionId: Id,
    payloadDigest: Digest,
    outputDigest: Digest,
    entries: z.array(Entry).min(2).max(11),
    totalBytes: Count,
    status: z.enum(['prepared', 'stored']),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.entries.map((entry) => entry.id)).size !==
        value.entries.length ||
      new Set(value.entries.map((entry) => entry.name)).size !==
        value.entries.length ||
      value.entries.filter((entry) => entry.name === 'manifest.json').length !==
        1 ||
      value.totalBytes !==
        value.entries.reduce((sum, entry) => sum + entry.bytes, 0)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Output plan entries or total are inconsistent',
      });
  });
const Plan = SourceOutputPlan;
const periodSchema = z.object({
  counterKey: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  startsAt: Timestamp,
  endsAt: Timestamp,
});
type Request = z.infer<typeof SourceJobRequest>;

/** Persists transport-verified, still numerically UNVALIDATED source output.
 * Every attempted PUT consumes Class A before I/O; ambiguous writes never retry.
 */
export class SourceOutputStore {
  constructor(
    private readonly store: DocumentStore,
    private readonly objects: UploadObjectStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async inspect(tx: DocumentTransaction, request: Request) {
    const operation = Operation.parse(
      await tx.get(`operations/${request.operationId}`),
    );
    await requireActiveRevision(tx, operation.ownerUid, {
      auditId: operation.auditId,
      revisionId: operation.revisionId,
      generation: operation.fence,
      inputDigest: operation.inputDigest,
    });
    const binding = SourceExecutionBinding.parse(
      await tx.get(`sourceExecutions/${operation.id}`),
    );
    const reservation = await tx.get(
      `reservations/source_output_${operation.id}`,
    );
    const termination = SandboxTermination.parse(
      await tx.get(`sandboxTerminations/${operation.id}`),
    );
    if (
      operation.outcome === 'reserved' ||
      binding.operationId !== operation.id ||
      binding.ownerUid !== operation.ownerUid ||
      binding.auditId !== operation.auditId ||
      binding.revisionId !== operation.revisionId ||
      binding.inputDigest !== operation.inputDigest ||
      binding.generation !== operation.fence ||
      binding.status !== 'claimed' ||
      binding.sandboxRequestDigest !== operation.requestDigest ||
      binding.payloadDigest !== (await sha256(JSON.stringify(request))) ||
      request.inputDigest !== operation.inputDigest ||
      termination.operationId !== operation.id ||
      termination.sandboxId !== binding.sandboxId ||
      termination.sandboxId !== operation.providerHandle ||
      termination.ownerUid !== operation.ownerUid ||
      termination.auditId !== operation.auditId ||
      termination.revisionId !== operation.revisionId ||
      termination.inputDigest !== operation.inputDigest ||
      termination.requestDigest !== operation.requestDigest ||
      !reservation ||
      reservation.operationId !== operation.id ||
      reservation.ownerUid !== operation.ownerUid ||
      reservation.auditId !== operation.auditId ||
      reservation.revisionId !== operation.revisionId ||
      reservation.payloadDigest !== binding.payloadDigest ||
      reservation.amount !== binding.reservedBytes ||
      reservation.outputCounterKey !==
        `revision_output_bytes_${operation.revisionId}` ||
      reservation.resource !== 'source_output_bytes'
    )
      throw new Error(
        'Source storage snapshot/reservation/termination mismatch',
      );
    return { operation, binding, reservation };
  }

  async persist(
    requestValue: unknown,
    manifestValue: unknown,
    payloads: Array<{ filename: string; bytes: Uint8Array }>,
    signal?: AbortSignal,
  ) {
    const request = SourceJobRequest.parse(requestValue);
    const manifest = validateSourceJobResult(manifestValue, request);
    const body = new Uint8Array(
      new TextEncoder().encode(canonicalJson(manifest)),
    );
    if (
      body.length > 32768 ||
      new Set(payloads.map((p) => p.filename)).size !== payloads.length ||
      payloads.length !== manifest.observations.length
    )
      throw new Error('Invalid source output set');
    const files = new Map<string, Uint8Array<ArrayBuffer>>();
    const descriptions: Array<Omit<z.infer<typeof Entry>, 'id'>> = [];
    for (const item of manifest.observations) {
      const found = payloads.find(
        (payload) => payload.filename === item.filename,
      );
      if (
        !found ||
        !(found.bytes instanceof Uint8Array) ||
        found.bytes.length !== item.bytes
      )
        throw new Error('Source output byte length mismatch');
      const bytes = new Uint8Array(found.bytes); // Own snapshot before external awaits.
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (n) => n.toString(16).padStart(2, '0'),
      ).join('');
      if (digest !== item.sha256)
        throw new Error('Source output byte hash mismatch');
      files.set(item.filename, bytes);
      descriptions.push({
        name: item.filename,
        bytes: bytes.length,
        sha256: digest,
      });
    }
    const outputDigest = await sha256(canonicalJson(manifest));
    files.set('manifest.json', body);
    descriptions.push({
      name: 'manifest.json',
      bytes: body.length,
      sha256: outputDigest,
    });
    const totalBytes = descriptions.reduce((sum, item) => sum + item.bytes, 0);
    const deadline = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(180000)])
      : AbortSignal.timeout(180000);
    deadline.throwIfAborted();
    const plan = await this.store.transaction(async (tx) => {
      const { operation, binding, reservation } = await this.inspect(
        tx,
        request,
      );
      const prior = await tx.get(`sourceOutputPlans/${operation.id}`);
      if (prior) {
        const old = Plan.parse(prior);
        if (
          old.operationId !== operation.id ||
          old.ownerUid !== operation.ownerUid ||
          old.auditId !== operation.auditId ||
          old.revisionId !== operation.revisionId ||
          old.payloadDigest !== binding.payloadDigest ||
          old.outputDigest !== outputDigest ||
          old.totalBytes !== totalBytes ||
          canonicalJson(
            old.entries.map((item) => ({
              name: item.name,
              bytes: item.bytes,
              sha256: item.sha256,
            })),
          ) !== canonicalJson(descriptions)
        )
          throw new Error('Source output plan conflict');
        if (
          old.status === 'stored' &&
          (reservation.status !== 'settled' ||
            reservation.measuredUsage !== old.totalBytes)
        )
          throw new Error('Stored source output accounting mismatch');
        return old;
      }
      if (
        reservation.status !== 'reserved' ||
        totalBytes > binding.reservedBytes
      )
        throw new Error('Source output reservation is not available');
      const now = this.clock();
      const plan = Plan.parse({
        schemaVersion: '1.0',
        operationId: operation.id,
        ownerUid: operation.ownerUid,
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        payloadDigest: binding.payloadDigest,
        outputDigest,
        entries: descriptions.map((item) => ({
          ...item,
          id: crypto.randomUUID(),
        })),
        totalBytes,
        status: 'prepared',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      for (const entry of plan.entries)
        tx.set(`audits/${operation.auditId}/artifacts/${entry.id}`, {
          schemaVersion: '1.0',
          artifactId: entry.id,
          ownerUid: operation.ownerUid,
          auditId: operation.auditId,
          revisionId: operation.revisionId,
          sourceOperationId: operation.id,
          path: entry.name,
          bytes: entry.bytes,
          sha256: entry.sha256,
          kind: 'source_output_unvalidated',
          numericValidation: 'unvalidated',
          objectKey: `audits/${operation.ownerUid}/${operation.auditId}/artifacts/${entry.id}/content`,
          lifecycle: 'reserved',
          retentionClass: 'raw',
          retentionVersion: RETENTION.version,
          expiresAt: new Date(now.getTime() + RETENTION.rawDays * 86400000),
          createdAt: now,
          updatedAt: now,
        });
      tx.set(`sourceOutputPlans/${operation.id}`, nativeTimestamps(plan));
      return plan;
    });
    if (plan.status === 'stored') return this.receipt(plan);
    for (const entry of plan.entries) {
      deadline.throwIfAborted();
      await this.put(request, plan, entry, files.get(entry.name)!, deadline);
    }
    await this.finalize(request, plan);
    return this.receipt(plan);
  }

  private receipt(plan: z.infer<typeof Plan>) {
    return {
      operationId: plan.operationId,
      artifactIds: plan.entries.map((entry) => entry.id),
      storedBytes: plan.totalBytes,
      numericValidation: 'unvalidated' as const,
    };
  }

  private async put(
    request: Request,
    plan: z.infer<typeof Plan>,
    entry: z.infer<typeof Entry>,
    bytes: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ) {
    const journalPath = `operations/source_put_${plan.operationId}_${entry.id}`;
    const artifactPath = `audits/${plan.auditId}/artifacts/${entry.id}`;
    const objectKey = `audits/${plan.ownerUid}/${plan.auditId}/artifacts/${entry.id}/content`;
    const dispatch = await this.store.transaction(async (tx) => {
      const { reservation } = await this.inspect(tx, request);
      const artifact = await tx.get(artifactPath);
      const previous = await tx.get(journalPath);
      if (
        artifact?.objectKey !== objectKey ||
        artifact.sha256 !== entry.sha256 ||
        artifact.bytes !== entry.bytes ||
        artifact.ownerUid !== plan.ownerUid ||
        artifact.revisionId !== plan.revisionId ||
        Date.parse(Timestamp.parse(artifact.expiresAt)) <=
          this.clock().getTime()
      )
        throw new Error('Source output artifact mismatch');
      if (
        previous &&
        (previous.operationId !== plan.operationId ||
          previous.ownerUid !== plan.ownerUid ||
          previous.auditId !== plan.auditId ||
          previous.revisionId !== plan.revisionId ||
          previous.artifactId !== entry.id)
      )
        throw new Error('Source storage journal identity mismatch');
      if (
        previous?.outcome === 'succeeded' &&
        ['uploaded', 'ready'].includes(String(artifact.lifecycle))
      )
        return false;
      if (previous || reservation.status !== 'reserved')
        throw new Error('Source output write requires reconciliation');
      const period = periodSchema.parse(
        await tx.get('configuration/r2_class_a_period'),
      );
      const counter = BudgetCounter.parse(
        await tx.get(`budgets/${period.counterKey}`),
      );
      const revision = await tx.get(
        `audits/${plan.auditId}/revisions/${plan.revisionId}`,
      );
      const policy = ResourcePolicy.parse(revision?.policy);
      const now = this.clock();
      if (
        now.getTime() < Date.parse(period.startsAt) ||
        now.getTime() >= Date.parse(period.endsAt) ||
        counter.halted ||
        BigInt(counter.spent) + BigInt(counter.reserved) + 1n >
          BigInt(Math.min(counter.limit, policy.monthlyClassA))
      )
        throw new Error('Source output R2 write budget unavailable');
      tx.set(`budgets/${period.counterKey}`, {
        ...counter,
        spent: counter.spent + 1,
      });
      tx.set(journalPath, {
        schemaVersion: '1.0',
        kind: 'source_output_put',
        operationId: plan.operationId,
        ownerUid: plan.ownerUid,
        auditId: plan.auditId,
        revisionId: plan.revisionId,
        artifactId: entry.id,
        counterKey: period.counterKey,
        outcome: 'dispatching',
        createdAt: now,
        updatedAt: now,
      });
      return { expiresAt: Timestamp.parse(artifact.expiresAt) };
    });
    if (!dispatch) return;
    try {
      signal.throwIfAborted();
      const transfer = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
      transfer.throwIfAborted();
      let abort = () => {};
      const interrupted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('Source storage transfer interrupted'));
        transfer.addEventListener('abort', abort, { once: true });
      });
      let saved: { size: number; sha256: string };
      try {
        saved = await Promise.race([
          this.objects.putOnce(objectKey, bytes, entry.sha256, dispatch),
          interrupted,
        ]);
      } finally {
        transfer.removeEventListener('abort', abort);
      }
      if (saved.size !== entry.bytes || saved.sha256 !== entry.sha256)
        throw new Error('Storage metadata mismatch');
      // Record confirmed storage even after cancellation; publication waits for finalize.
      await this.store.transaction(async (tx) => {
        const journal = await tx.get(journalPath),
          artifact = await tx.get(artifactPath);
        if (
          journal?.outcome !== 'dispatching' ||
          !artifact ||
          artifact.objectKey !== objectKey ||
          artifact.sha256 !== entry.sha256 ||
          artifact.bytes !== entry.bytes
        )
          throw new Error('Storage journal conflict');
        tx.set(
          journalPath,
          nativeTimestamps({
            ...journal,
            outcome: 'succeeded',
            updatedAt: this.clock().toISOString(),
          }),
        );
        tx.set(
          artifactPath,
          nativeTimestamps({
            ...artifact,
            lifecycle: 'uploaded',
            updatedAt: this.clock().toISOString(),
          }),
        );
      });
    } catch {
      await this.store
        .transaction(async (tx) => {
          const journal = await tx.get(journalPath);
          if (journal?.outcome === 'dispatching')
            tx.set(
              journalPath,
              nativeTimestamps({
                ...journal,
                outcome: 'unknown',
                updatedAt: this.clock().toISOString(),
              }),
            );
        })
        .catch(() => undefined);
      throw new Error('source_output_write_unknown');
    }
  }

  private async finalize(request: Request, plan: z.infer<typeof Plan>) {
    await this.store.transaction(async (tx) => {
      const { binding, reservation } = await this.inspect(tx, request);
      const saved = Plan.parse(
        await tx.get(`sourceOutputPlans/${plan.operationId}`),
      );
      if (saved.outputDigest !== plan.outputDigest)
        throw new Error('Source output plan changed');
      if (saved.status === 'stored') return;
      const artifacts = [];
      for (const entry of saved.entries) {
        const artifact = await tx.get(
          `audits/${plan.auditId}/artifacts/${entry.id}`,
        );
        const journal = await tx.get(
          `operations/source_put_${plan.operationId}_${entry.id}`,
        );
        if (
          !artifact ||
          artifact.lifecycle !== 'uploaded' ||
          artifact.ownerUid !== plan.ownerUid ||
          artifact.revisionId !== plan.revisionId ||
          artifact.sourceOperationId !== plan.operationId ||
          artifact.objectKey !==
            `audits/${plan.ownerUid}/${plan.auditId}/artifacts/${entry.id}/content` ||
          Date.parse(Timestamp.parse(artifact.expiresAt)) <=
            this.clock().getTime() ||
          artifact.sha256 !== entry.sha256 ||
          artifact.bytes !== entry.bytes ||
          journal?.outcome !== 'succeeded' ||
          journal.operationId !== plan.operationId ||
          journal.artifactId !== entry.id ||
          journal.ownerUid !== plan.ownerUid ||
          journal.auditId !== plan.auditId ||
          journal.revisionId !== plan.revisionId
        )
          throw new Error('Not all source output writes are confirmed');
        artifacts.push({ id: entry.id, artifact });
      }
      const storage = BudgetCounter.parse(
        await tx.get('budgets/r2_storage_bytes'),
      );
      const outputKey = z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,200}$/)
        .parse(reservation.outputCounterKey);
      const output = BudgetCounter.parse(await tx.get(`budgets/${outputKey}`));
      if (
        reservation.status !== 'reserved' ||
        saved.totalBytes > binding.reservedBytes ||
        storage.reserved < binding.reservedBytes ||
        output.reserved < binding.reservedBytes
      )
        throw new Error('Source output accounting conflict');
      for (const [key, counter] of [
        ['r2_storage_bytes', storage],
        [outputKey, output],
      ] as const) {
        const reserved = counter.reserved - binding.reservedBytes;
        const spent = Count.parse(counter.spent + saved.totalBytes);
        tx.set(`budgets/${key}`, {
          ...counter,
          reserved,
          spent,
          halted: counter.halted || spent + reserved > counter.limit,
        });
      }
      const now = this.clock();
      for (const { id, artifact } of artifacts)
        tx.set(
          `audits/${plan.auditId}/artifacts/${id}`,
          nativeTimestamps({
            ...artifact,
            lifecycle: 'ready',
            updatedAt: now.toISOString(),
          }),
        );
      tx.set(
        `reservations/source_output_${plan.operationId}`,
        nativeTimestamps({
          ...reservation,
          status: 'settled',
          measuredUsage: saved.totalBytes,
          reconciliationState: 'confirmed',
          updatedAt: now.toISOString(),
        }),
      );
      tx.set(
        `sourceOutputPlans/${plan.operationId}`,
        nativeTimestamps({
          ...saved,
          status: 'stored',
          updatedAt: now.toISOString(),
        }),
      );
    });
  }
}
