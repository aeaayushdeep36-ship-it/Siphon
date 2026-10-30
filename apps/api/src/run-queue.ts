import { z } from 'zod';
import {
  StartAudit,
  QueuedAuditReceipt,
  ResourcePolicy,
  DEFAULT_POLICY,
  UploadManifest,
  Answer,
  preflightUploads,
  Timestamp,
  Digest,
  Id,
  Count,
} from '@siphon/contracts';
import { type DocumentStore, type DocumentTransaction } from './firestore.js';
import {
  authorize,
  nativeTimestamps,
  receiptKey,
  stateFrom,
  requireActiveRevision,
} from './audit-commands.js';
import { persistProgress } from './progress.js';
import { transition } from './lifecycle.js';
import { canonicalJson, sha256 } from './hashing.js';
import { BudgetCounter } from './accounting.js';
import { SandboxRequest } from './e2b-client.js';
import { ApiError } from './errors.js';

export const InspectionStageJob = z.strictObject({
  schemaVersion: z.literal('1.0'),
  id: Digest,
  ownerUid: z.string().min(1).max(128),
  auditId: Id,
  revisionId: Id,
  inputDigest: Digest,
  generation: Count,
  startDigest: Digest,
  manifestDigest: Digest,
  receipt: QueuedAuditReceipt,
  operationId: Id,
  sandboxRequest: SandboxRequest.nullable(),
  leaseId: Id.nullable(),
  status: z.enum([
    'queued',
    'running',
    'preparing',
    'preparation_failed',
    'dispatching',
    'inspection_complete',
    'inspection_failed',
  ]),
  resultDigest: Digest.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type InspectionStageJob = z.infer<typeof InspectionStageJob>;

/** Revalidate immutable input/storage metadata before any compute admission. */
export async function inspectRunInputs(
  tx: DocumentTransaction,
  uid: string,
  auditId: string,
  revisionId: string,
  now: Date,
) {
  const audit = await authorize(tx, uid, auditId, false);
  const revision = await tx.get(`audits/${auditId}/revisions/${revisionId}`);
  if (!revision || revision.ownerUid !== uid)
    throw new ApiError(404, 'not_found', 'Revision was not found.');
  const state = stateFrom(revision);
  if (
    state.auditId !== auditId ||
    state.revisionId !== revisionId ||
    audit.currentRevisionId !== revisionId ||
    state.cancellationRequestedAt !== null ||
    state.stage === 'finished'
  )
    throw new ApiError(
      409,
      'stale_revision',
      'The revision is no longer available for this work.',
    );
  const policy = ResourcePolicy.parse(revision.policy);
  const bounded = { ...policy };
  for (const key of [
    'uploadFiles',
    'uploadBytes',
    'sourceBytes',
    'modelRevisionMicroUsd',
    'modelAttempts',
    'sandboxSeconds',
    'sandboxLifetimeSeconds',
    'sourceExecutions',
    'outputBytes',
  ] as const)
    bounded[key] = Math.min(policy[key], DEFAULT_POLICY[key]);
  const effective = ResourcePolicy.parse(bounded);
  const manifest = UploadManifest.parse(revision.sourceManifest);
  const answers = z.array(Answer).parse(revision.answers);
  if (
    preflightUploads(manifest, effective).status !== 'ready' ||
    state.inputDigest !==
      (await sha256(canonicalJson({ uploads: manifest, answers })))
  )
    throw new ApiError(
      422,
      'inputs_not_ready',
      'Provide a complete supported upload snapshot.',
    );
  const artifacts = await tx.getMany(
    manifest.map((entry) => `audits/${auditId}/artifacts/${entry.artifactId}`),
  );
  for (const [index, entry] of manifest.entries()) {
    const artifact = artifacts[index];
    if (
      !artifact ||
      artifact.ownerUid !== uid ||
      artifact.auditId !== auditId ||
      artifact.kind !== 'upload' ||
      artifact.lifecycle !== 'ready' ||
      artifact.path !== entry.path ||
      artifact.bytes !== entry.bytes ||
      artifact.sha256 !== entry.sha256 ||
      Date.parse(Timestamp.parse(artifact.expiresAt)) <= now.getTime()
    )
      throw new ApiError(
        422,
        'inputs_not_ready',
        'An upload is incomplete, changed or expired.',
      );
  }
  return {
    state,
    revision,
    policy: effective,
    manifest,
    manifestDigest: await sha256(canonicalJson(manifest)),
  };
}

/** Internal durable queue. It never creates a Workflow, a sandbox or model call. */
export class RunQueue {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async enqueue(
    uid: string,
    auditId: string,
    revisionId: string,
    value: unknown,
    key: string,
  ) {
    Id.parse(auditId);
    Id.parse(revisionId);
    const request = StartAudit.parse(value);
    const startDigest = await sha256(canonicalJson(request));
    const requestId = await receiptKey(
      uid,
      `POST /audits/${auditId}/revisions/${revisionId}/run`,
      key,
    );
    const jobId = await sha256(
      canonicalJson({
        uid,
        auditId,
        revisionId,
        inputDigest: request.expectedInputDigest,
        stage: 'inspection',
      }),
    );
    const now = this.clock();
    return this.store.transaction(async (tx) => {
      const snapshot = await inspectRunInputs(
        tx,
        uid,
        auditId,
        revisionId,
        now,
      );
      const [previousReceipt, previous] = await tx.getMany([
        `requests/${requestId}`,
        `stageJobs/${jobId}`,
      ]);
      if (
        previousReceipt &&
        (previousReceipt.ownerUid !== uid ||
          previousReceipt.auditId !== auditId ||
          previousReceipt.requestDigest !== startDigest)
      )
        throw new ApiError(
          409,
          'idempotency_conflict',
          'This key was already used with different input.',
        );
      if (previous) {
        const job = InspectionStageJob.parse(previous);
        if (
          job.id !== jobId ||
          job.ownerUid !== uid ||
          job.auditId !== auditId ||
          job.revisionId !== revisionId ||
          job.inputDigest !== snapshot.state.inputDigest ||
          job.manifestDigest !== snapshot.manifestDigest ||
          job.startDigest !== startDigest ||
          (previousReceipt &&
            canonicalJson(previousReceipt.result) !==
              canonicalJson(job.receipt))
        )
          throw new ApiError(
            409,
            'idempotency_conflict',
            'The queued work does not match this request.',
          );
        return { receipt: job.receipt, replayed: true };
      }
      if (previousReceipt)
        throw new Error('Queued work receipt has no durable job');
      if (
        snapshot.state.stage !== 'draft' ||
        snapshot.state.status !== 'idle' ||
        snapshot.state.generation !== request.expectedGeneration ||
        snapshot.state.inputDigest !== request.expectedInputDigest
      )
        throw new ApiError(
          409,
          'stale_revision',
          'The draft changed before it could be queued.',
        );
      const limits = {
        [`meta_revision_${revisionId}`]: snapshot.policy.modelRevisionMicroUsd,
        [`model_attempts_${revisionId}`]: snapshot.policy.modelAttempts,
        [`e2b_seconds_${revisionId}`]: snapshot.policy.sandboxSeconds,
        [`source_executions_${revisionId}`]: snapshot.policy.sourceExecutions,
        [`revision_output_bytes_${revisionId}`]: snapshot.policy.outputBytes,
      };
      const missing: Array<[string, BudgetCounter]> = [];
      const entries = Object.entries(limits);
      const counters = await tx.getMany(
        entries.map(([counterKey]) => `budgets/${counterKey}`),
      );
      for (const [index, [counterKey, limit]] of entries.entries()) {
        const record = counters[index];
        if (record) {
          const counter = BudgetCounter.parse(record);
          if (
            counter.limit > limit ||
            counter.halted ||
            counter.spent + counter.reserved > counter.limit
          )
            throw new ApiError(
              429,
              'budget_exhausted',
              'Revision allowance requires reconciliation.',
            );
        } else
          missing.push([
            counterKey,
            {
              schemaVersion: '1.0',
              limit,
              reserved: 0,
              spent: 0,
              halted: false,
            },
          ]);
      }
      const queued = transition(snapshot.state, snapshot.state, {
        kind: 'queue',
      });
      const receipt = QueuedAuditReceipt.parse({
        schemaVersion: '1.0',
        jobId,
        auditId,
        revisionId,
        inputDigest: queued.inputDigest,
        generation: queued.generation,
        stage: queued.stage,
        status: queued.status,
      });
      const job = InspectionStageJob.parse({
        schemaVersion: '1.0',
        id: jobId,
        ownerUid: uid,
        auditId,
        revisionId,
        inputDigest: queued.inputDigest,
        generation: queued.generation,
        startDigest,
        manifestDigest: snapshot.manifestDigest,
        receipt,
        operationId: crypto.randomUUID(),
        sandboxRequest: null,
        leaseId: null,
        status: 'queued',
        resultDigest: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      await persistProgress(
        tx,
        uid,
        auditId,
        snapshot.state,
        { activity: 'queued', experiments: null },
        now,
        { kind: 'queue' },
      );
      for (const [counterKey, counter] of missing)
        tx.set(`budgets/${counterKey}`, counter);
      tx.set(`stageJobs/${jobId}`, nativeTimestamps(job));
      tx.set(`requests/${requestId}`, {
        schemaVersion: '1.0',
        ownerUid: uid,
        auditId,
        requestDigest: startDigest,
        result: receipt,
        createdAt: now,
        updatedAt: now,
      });
      return { receipt, replayed: false };
    });
  }

  async start(jobId: string) {
    Digest.parse(jobId);
    return this.store.transaction(async (tx) => {
      const job = InspectionStageJob.parse(await tx.get(`stageJobs/${jobId}`));
      if (job.id !== jobId) throw new Error('Stage job key mismatch');
      const snapshot = await inspectRunInputs(
        tx,
        job.ownerUid,
        job.auditId,
        job.revisionId,
        this.clock(),
      );
      if (
        snapshot.state.generation !== job.generation ||
        snapshot.state.inputDigest !== job.inputDigest ||
        snapshot.manifestDigest !== job.manifestDigest
      )
        throw new ApiError(
          409,
          'stale_revision',
          'Queued input identities changed.',
        );
      if (job.status !== 'queued') {
        await requireActiveRevision(tx, job.ownerUid, {
          auditId: job.auditId,
          revisionId: job.revisionId,
          generation: job.generation,
          inputDigest: job.inputDigest,
        });
        if (snapshot.state.stage !== 'inspecting')
          throw new Error('Inspection job stage mismatch');
        return job;
      }
      const next = transition(snapshot.state, snapshot.state, {
        kind: 'start',
      });
      const started = InspectionStageJob.parse({
        ...job,
        generation: next.generation,
        status: 'running',
        updatedAt: this.clock().toISOString(),
      });
      await persistProgress(
        tx,
        job.ownerUid,
        job.auditId,
        snapshot.state,
        { activity: 'inspecting_upload', experiments: null },
        this.clock(),
        { kind: 'start' },
      );
      tx.set(`stageJobs/${jobId}`, nativeTimestamps(started));
      return started;
    });
  }
}
