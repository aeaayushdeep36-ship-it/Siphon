import { z } from 'zod';
import {
  Count,
  Digest,
  Id,
  InspectionGate,
  InspectionJobResult,
  validateInspectionResult,
} from '@siphon/contracts';
import { evaluateInspectionGate } from './inspection-gate.js';
import { type DocumentStore } from './firestore.js';
import { RunQueue, InspectionStageJob, inspectRunInputs } from './run-queue.js';
import { nativeTimestamps, requireActiveRevision } from './audit-commands.js';
import {
  AdmissionRepository,
  confirmSandboxOperationEnded,
} from './admission.js';
import {
  SandboxTemplateEvidence,
  expectedCharges,
  type SandboxJobs,
} from './sandbox-jobs.js';
import { SandboxRequest } from './e2b-client.js';
import {
  BudgetCounter,
  Operation,
  reserveOperation,
  releaseUndispatched,
} from './accounting.js';
import { FirestoreAccountingStore } from './firestore-accounting.js';
import {
  InspectionPipeline,
  InspectionCreationReceipt,
  InspectionExecutionReceipt,
} from './inspection-pipeline.js';
import { canonicalJson, sha256 } from './hashing.js';
import { SandboxTermination } from './sandbox-termination.js';

const DispatchConfiguration = z.strictObject({
  templateEvidenceId: Id,
  lifetimeSeconds: Count.refine((value) => value > 0),
});
const fenceOf = (job: InspectionStageJob) => ({
  auditId: job.auditId,
  revisionId: job.revisionId,
  inputDigest: job.inputDigest,
  generation: job.generation,
});

/** Concrete first audit stage, not an automatic release of later scientific stages.
 * The scheduler must disable provider-step retries. Existing dispatch gates remain mandatory.
 */
export class InspectionCoordinator {
  private readonly queue: RunQueue;
  private readonly admission: AdmissionRepository;
  constructor(
    private readonly store: DocumentStore,
    private readonly sandboxes: Pick<SandboxJobs, 'bind'>,
    private readonly pipeline: Pick<InspectionPipeline, 'run'> &
      Partial<
        Pick<
          InspectionPipeline,
          'execute' | 'createSandbox' | 'executeConnected' | 'terminate'
        >
      >,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.queue = new RunQueue(store, clock);
    this.admission = new AdmissionRepository(store, clock);
  }

  private async attachLease(job: InspectionStageJob, leaseId: string) {
    return this.store.transaction(async (tx) => {
      await requireActiveRevision(tx, job.ownerUid, fenceOf(job));
      const current = InspectionStageJob.parse(
        await tx.get(`stageJobs/${job.id}`),
      );
      if (
        current.id !== job.id ||
        current.operationId !== job.operationId ||
        current.ownerUid !== job.ownerUid ||
        current.auditId !== job.auditId ||
        current.revisionId !== job.revisionId ||
        current.inputDigest !== job.inputDigest ||
        current.generation !== job.generation ||
        (current.leaseId !== null && current.leaseId !== leaseId)
      )
        throw new Error('Inspection capacity binding changed');
      if (current.status !== 'running') return null;
      const next = InspectionStageJob.parse({
        ...current,
        leaseId,
        status: 'preparing',
        updatedAt: this.clock().toISOString(),
      });
      tx.set(`stageJobs/${job.id}`, nativeTimestamps(next));
      return next;
    });
  }

  private async prepare(job: InspectionStageJob) {
    const prepared = await this.store.transaction(async (tx) => {
      const snapshot = await inspectRunInputs(
        tx,
        job.ownerUid,
        job.auditId,
        job.revisionId,
        this.clock(),
      );
      const current = InspectionStageJob.parse(
        await tx.get(`stageJobs/${job.id}`),
      );
      if (
        current.id !== job.id ||
        current.ownerUid !== job.ownerUid ||
        current.auditId !== job.auditId ||
        current.revisionId !== job.revisionId ||
        current.generation !== snapshot.state.generation ||
        current.inputDigest !== snapshot.state.inputDigest ||
        current.manifestDigest !== snapshot.manifestDigest ||
        current.operationId !== job.operationId ||
        current.status !== 'preparing' ||
        current.leaseId !== job.leaseId ||
        !current.leaseId
      )
        throw new Error('Inspection preparation snapshot changed');
      if (current.sandboxRequest)
        return { job: current, request: current.sandboxRequest };
      const config = DispatchConfiguration.parse(
        await tx.get('configuration/inspection_dispatch'),
      );
      const evidence = SandboxTemplateEvidence.parse(
        await tx.get(`sandboxTemplates/${config.templateEvidenceId}`),
      );
      const seconds = BudgetCounter.parse(
        await tx.get(`budgets/e2b_seconds_${job.revisionId}`),
      );
      const deadline = this.clock().getTime() + config.lifetimeSeconds * 1000;
      if (
        evidence.id !== config.templateEvidenceId ||
        evidence.role !== 'inspection' ||
        Date.parse(evidence.verifiedAt) > this.clock().getTime() ||
        Date.parse(evidence.expiresAt) <= deadline ||
        config.lifetimeSeconds > snapshot.policy.sandboxLifetimeSeconds ||
        seconds.halted ||
        seconds.limit > snapshot.policy.sandboxSeconds ||
        BigInt(seconds.spent) +
          BigInt(seconds.reserved) +
          BigInt(config.lifetimeSeconds) >
          BigInt(seconds.limit)
      )
        throw new Error(
          'Verified inspection configuration or time allowance is unavailable',
        );
      const request = SandboxRequest.parse({
        operationId: current.operationId,
        auditId: current.auditId,
        revisionId: current.revisionId,
        inputDigest: current.inputDigest,
        role: 'inspection',
        templateId: evidence.templateId,
        ...(evidence.templateBuildId
          ? { templateBuildId: evidence.templateBuildId }
          : {}),
        ...(evidence.templateTag ? { templateTag: evidence.templateTag } : {}),
        templateEvidenceId: evidence.id,
        lifetimeSeconds: config.lifetimeSeconds,
      });
      const next = InspectionStageJob.parse({
        ...current,
        sandboxRequest: request,
        updatedAt: this.clock().toISOString(),
      });
      tx.set(`stageJobs/${job.id}`, nativeTimestamps(next));
      return { job: next, request };
    });
    // Freeze the exact cost evidence with SandboxJobs.bind. Read the immutable
    // verified rate here solely to reserve the same counter amounts beforehand.
    const evidence = SandboxTemplateEvidence.parse(
      await this.store.get(
        `sandboxTemplates/${prepared.request.templateEvidenceId}`,
      ),
    );
    const cost = Count.parse(
      Number(
        BigInt(evidence.microUsdPerSecondCeiling) *
          BigInt(prepared.request.lifetimeSeconds),
      ),
    );
    const now = this.clock().toISOString();
    await reserveOperation(
      new FirestoreAccountingStore(this.store),
      Operation.parse({
        schemaVersion: '1.0',
        id: job.operationId,
        auditId: job.auditId,
        revisionId: job.revisionId,
        ownerUid: job.ownerUid,
        inputDigest: job.inputDigest,
        fence: job.generation,
        requestDigest: await sha256(canonicalJson(prepared.request)),
        outcome: 'reserved',
        charges: expectedCharges(prepared.request, cost),
        usage: null,
        providerHandle: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
    await this.sandboxes.bind(prepared.request);
    return prepared;
  }

  private async claim(job: InspectionStageJob) {
    return this.store.transaction(async (tx) => {
      const [currentValue, operationValue] = await tx.getMany([
        `stageJobs/${job.id}`,
        `operations/${job.operationId}`,
        `testers/${job.ownerUid}`,
        `audits/${job.auditId}`,
        `audits/${job.auditId}/revisions/${job.revisionId}`,
      ]);
      await requireActiveRevision(tx, job.ownerUid, fenceOf(job));
      const current = InspectionStageJob.parse(currentValue);
      const operation = Operation.parse(operationValue);
      if (
        current.id !== job.id ||
        current.ownerUid !== job.ownerUid ||
        current.generation !== job.generation ||
        current.operationId !== operation.id ||
        current.leaseId !== job.leaseId ||
        canonicalJson(current.sandboxRequest) !==
          canonicalJson(job.sandboxRequest)
      )
        throw new Error('Inspection dispatch claim changed');
      if (current.status !== 'preparing') return false;
      if (
        !job.sandboxRequest ||
        operation.ownerUid !== job.ownerUid ||
        operation.auditId !== job.auditId ||
        operation.revisionId !== job.revisionId ||
        operation.inputDigest !== job.inputDigest ||
        operation.fence !== job.generation ||
        operation.outcome !== 'reserved' ||
        operation.requestDigest !==
          (await sha256(canonicalJson(job.sandboxRequest)))
      )
        throw new Error('Inspection dispatch has no matching reservation');
      tx.set(
        `stageJobs/${job.id}`,
        nativeTimestamps({
          ...current,
          status: 'dispatching',
          updatedAt: this.clock().toISOString(),
        }),
      );
      return true;
    });
  }

  /** Durable phase 1: no provider I/O; only its winning delivery owns preparation.
   * A scheduler checkpoints the returned bounded metadata, never uploaded bytes.
   */
  async begin(jobId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const job = await this.queue.start(jobId);
    if (job.status === 'inspection_failed')
      return {
        action: 'failed' as const,
        jobId,
        operationId: job.operationId,
      };
    if (job.status === 'dispatching' || job.status === 'inspection_complete')
      return {
        action: 'recover' as const,
        jobId,
        operationId: job.operationId,
      };
    if (job.status === 'preparing' || job.status === 'preparation_failed')
      return {
        action: 'wait' as const,
        jobId,
        operationId: job.operationId,
      };
    const lease = await this.admission.acquire(job.ownerUid, fenceOf(job));
    const attached = await this.attachLease(job, lease.id);
    if (!attached)
      return {
        action: 'wait' as const,
        jobId,
        operationId: job.operationId,
      };
    return { action: 'prepare' as const, job: attached };
  }

  /** Durable phase 2: exact reservations and sandbox binding are idempotent.
   * This method performs no provider call and accepts only a matching held phase.
   */
  async reserve(value: unknown, signal?: AbortSignal) {
    const checkpoint = InspectionStageJob.parse(value);
    if (checkpoint.status !== 'preparing' || !checkpoint.leaseId)
      throw new Error('Inspection reservation has no preparation claim');
    const job = InspectionStageJob.parse(
      await this.store.get(`stageJobs/${checkpoint.id}`),
    );
    // Validate the checkpoint before entering the cleanup owner path. Otherwise a
    // corrupted resume payload could attempt to refund some other operation.
    if (
      job.status !== 'preparing' ||
      !job.leaseId ||
      canonicalJson({
        ...job,
        sandboxRequest: null,
        updatedAt: checkpoint.updatedAt,
      }) !== canonicalJson({ ...checkpoint, sandboxRequest: null }) ||
      (checkpoint.sandboxRequest !== null &&
        canonicalJson(checkpoint.sandboxRequest) !==
          canonicalJson(job.sandboxRequest))
    )
      throw new Error('Inspection preparation checkpoint changed');
    try {
      signal?.throwIfAborted();
      const prepared = await this.prepare(job);
      signal?.throwIfAborted();
      return prepared.job;
    } catch (error) {
      // Only this validated preparation claim can attempt cleanup. No provider call has
      // occurred here, so a known undispatched reservation can be released.
      try {
        // Close preparation atomically against the dispatch claim *before* any
        // refund. A concurrently claimed provider phase must keep its allowance.
        await this.store.transaction(async (tx) => {
          const current = InspectionStageJob.parse(
            await tx.get(`stageJobs/${job.id}`),
          );
          if (
            current.id !== job.id ||
            current.ownerUid !== job.ownerUid ||
            current.auditId !== job.auditId ||
            current.revisionId !== job.revisionId ||
            current.inputDigest !== job.inputDigest ||
            current.generation !== job.generation ||
            current.status !== 'preparing' ||
            current.operationId !== job.operationId ||
            current.leaseId !== job.leaseId
          )
            throw new Error('Preparation cleanup identity changed');
          tx.set(
            `stageJobs/${job.id}`,
            nativeTimestamps({
              ...current,
              status: 'preparation_failed',
              updatedAt: this.clock().toISOString(),
            }),
          );
        });
        const operation = await this.store.get(`operations/${job.operationId}`);
        if (operation)
          await releaseUndispatched(
            new FirestoreAccountingStore(this.store),
            job.operationId,
            job.generation,
            this.clock().toISOString(),
          );
        await this.admission.releaseUnused(
          job.ownerUid,
          fenceOf(job),
          job.leaseId,
        );
      } catch {
        /* Ambiguous cleanup retains durable phase/lease records for maintenance. */
      }
      throw error;
    }
  }

  /** Durable phase 3: the only phase allowed to invoke the provider pipeline.
   * It must not be automatically retried. Re-delivery can inspect its journal,
   * but a successful durable claim never grants permission for a second VM.
   */
  async dispatch(value: unknown, signal?: AbortSignal) {
    const job = InspectionStageJob.parse(value);
    if (job.status !== 'preparing' || !job.leaseId || !job.sandboxRequest)
      throw new Error('Inspection dispatch has no prepared request');
    signal?.throwIfAborted();
    if (!(await this.claim(job))) return;
    // After this durable claim, even a crash before the provider call is treated
    // conservatively. Recovery reads evidence, never invokes this pipeline again.
    try {
      await this.pipeline.run(
        job.ownerUid,
        job.sandboxRequest,
        fenceOf(job),
        signal,
      );
    } catch (error) {
      await this.recordKnownFailure(job).catch(() => undefined);
      throw error;
    }
  }

  /** Hosted provider phase. Failure is a bounded receipt for the following
   * cleanup phase, never permission to retry source retrieval or VM creation.
   */
  async execute(value: unknown, signal?: AbortSignal) {
    if (!this.pipeline.execute || !this.pipeline.terminate)
      throw new Error('Inspection phase transport is not configured');
    const job = InspectionStageJob.parse(value);
    if (job.status !== 'preparing' || !job.leaseId || !job.sandboxRequest)
      throw new Error('Inspection dispatch has no prepared request');
    signal?.throwIfAborted();
    if (!(await this.claim(job)))
      return {
        status: 'already_claimed' as const,
        jobId: job.id,
        operationId: job.operationId,
      };
    const receipt = InspectionExecutionReceipt.parse(
      await this.pipeline.execute(
        job.ownerUid,
        job.sandboxRequest,
        fenceOf(job),
        signal,
      ),
    );
    if (receipt.operationId !== job.operationId)
      throw new Error('Inspection receipt identity mismatch');
    return {
      status: 'execution_finished' as const,
      jobId: job.id,
      operationId: job.operationId,
      receipt,
    };
  }

  /** Hosted creation child: atomically claim the dispatch before one provider
   * create, then return only a bounded receipt for the next phase.
   */
  async createSandbox(value: unknown, signal?: AbortSignal) {
    if (!this.pipeline.createSandbox || !this.pipeline.terminate)
      throw new Error('Inspection create phase transport is not configured');
    const job = InspectionStageJob.parse(value);
    if (job.status !== 'preparing' || !job.leaseId || !job.sandboxRequest)
      throw new Error('Inspection create phase has no prepared request');
    signal?.throwIfAborted();
    if (!(await this.claim(job)))
      return {
        status: 'already_claimed' as const,
        jobId: job.id,
        operationId: job.operationId,
      };
    const receipt = InspectionCreationReceipt.parse(
      await this.pipeline.createSandbox(
        job.sandboxRequest,
        fenceOf(job),
        signal,
      ),
    );
    if (receipt.operationId !== job.operationId)
      throw new Error('Inspection create receipt identity mismatch');
    return {
      status: 'creation_finished' as const,
      jobId: job.id,
      operationId: job.operationId,
      receipt,
    };
  }

  /** Hosted execution child: reconnects only to the sandbox handle already
   * journaled by the create phase. Runner claims remain single-use in Firestore.
   */
  async executeConnected(value: unknown, signal?: AbortSignal) {
    if (!this.pipeline.executeConnected || !this.pipeline.terminate)
      throw new Error('Inspection execution phase transport is not configured');
    const job = InspectionStageJob.parse(value);
    if (job.status !== 'dispatching' || !job.leaseId || !job.sandboxRequest)
      throw new Error('Inspection execution has no dispatched request');
    signal?.throwIfAborted();
    const operation = Operation.parse(
      await this.store.get(`operations/${job.operationId}`),
    );
    if (
      operation.id !== job.operationId ||
      operation.ownerUid !== job.ownerUid ||
      operation.auditId !== job.auditId ||
      operation.revisionId !== job.revisionId ||
      operation.inputDigest !== job.inputDigest ||
      operation.fence !== job.generation ||
      operation.requestDigest !==
        (await sha256(canonicalJson(job.sandboxRequest))) ||
      operation.outcome !== 'dispatching'
    )
      throw new Error('Inspection execution operation changed');
    if (!operation.providerHandle)
      return {
        status: 'execution_finished' as const,
        jobId: job.id,
        operationId: job.operationId,
        receipt: InspectionExecutionReceipt.parse({
          schemaVersion: '1.0',
          status: 'execution_failed',
          operationId: job.operationId,
          sandboxId: null,
          failureCode: 'create_unknown',
        }),
      };
    const receipt = InspectionExecutionReceipt.parse(
      await this.pipeline.executeConnected(
        job.ownerUid,
        job.sandboxRequest,
        fenceOf(job),
        operation.providerHandle,
        signal,
      ),
    );
    if (
      receipt.operationId !== job.operationId ||
      receipt.sandboxId !== operation.providerHandle
    )
      throw new Error('Inspection execution receipt identity mismatch');
    return {
      status: 'execution_finished' as const,
      jobId: job.id,
      operationId: job.operationId,
      receipt,
    };
  }

  /** Separate short cleanup phase. Durable operation linkage, not a returned
   * receipt alone, supplies authority. No uploaded session is reconnected.
   */
  async cleanup(jobId: string) {
    Digest.parse(jobId);
    if (!this.pipeline.terminate)
      throw new Error('Inspection cleanup transport is not configured');
    const job = InspectionStageJob.parse(
      await this.store.get(`stageJobs/${jobId}`),
    );
    const [operationValue, terminationValue] = await Promise.all([
      this.store.get(`operations/${job.operationId}`),
      this.store.get(`sandboxTerminations/${job.operationId}`),
    ]);
    const operation = Operation.parse(operationValue);
    if (
      job.id !== jobId ||
      !job.sandboxRequest ||
      !job.leaseId ||
      !['dispatching', 'inspection_complete', 'inspection_failed'].includes(
        job.status,
      ) ||
      operation.id !== job.operationId ||
      operation.ownerUid !== job.ownerUid ||
      operation.auditId !== job.auditId ||
      operation.revisionId !== job.revisionId ||
      operation.inputDigest !== job.inputDigest ||
      operation.fence !== job.generation ||
      operation.requestDigest !==
        (await sha256(canonicalJson(job.sandboxRequest)))
    )
      throw new Error('Inspection cleanup identity mismatch');
    if (terminationValue) {
      const proof = SandboxTermination.parse(terminationValue);
      if (
        proof.operationId !== operation.id ||
        proof.sandboxId !== operation.providerHandle ||
        proof.ownerUid !== operation.ownerUid ||
        proof.auditId !== operation.auditId ||
        proof.revisionId !== operation.revisionId ||
        proof.inputDigest !== operation.inputDigest ||
        proof.requestDigest !== operation.requestDigest ||
        operation.outcome === 'reserved'
      )
        throw new Error('Inspection cleanup termination mismatch');
      // recordTermination journals proof before updating pending inventory. A
      // crash between those commits must be repaired without another provider kill.
      await confirmSandboxOperationEnded(
        this.store,
        operation.id,
        this.clock(),
      );
      return {
        jobId,
        operationId: job.operationId,
        cleanup: 'confirmed' as const,
      };
    }
    const cleanup =
      operation.providerHandle === null
        ? ('pending' as const)
        : await this.pipeline.terminate(operation.id, operation.providerHandle);
    return { jobId, operationId: job.operationId, cleanup };
  }

  /** Fenced evidence/failure reconciliation after cleanup; never provider execute.
   * Known unused/terminated work may release only its corresponding safe resources.
   */
  async finish(jobId: string) {
    Digest.parse(jobId);
    let job = InspectionStageJob.parse(
      await this.store.get(`stageJobs/${jobId}`),
    );
    if (job.id !== jobId)
      throw new Error('Inspection completion identity mismatch');
    if (job.status === 'dispatching') {
      await this.recordKnownFailure(job);
      job = InspectionStageJob.parse(
        await this.store.get(`stageJobs/${jobId}`),
      );
    }
    if (job.status === 'inspection_failed')
      return {
        status: 'inspection_failed' as const,
        jobId,
        operationId: job.operationId,
      };
    return this.recover(jobId);
  }

  /** Local/internal composition. Hosted orchestration uses the phases separately
   * with retries disabled, then recovers from durable evidence in its own step.
   */
  async run(jobId: string, signal?: AbortSignal) {
    const initial = await this.begin(jobId, signal);
    if (initial.action === 'failed')
      return {
        status: 'inspection_failed' as const,
        jobId,
        operationId: initial.operationId,
      };
    if (initial.action === 'wait')
      return {
        status: 'awaiting_reconciliation' as const,
        jobId,
        operationId: initial.operationId,
      };
    if (initial.action === 'prepare') {
      const prepared = await this.reserve(initial.job, signal);
      await this.dispatch(prepared, signal);
    }
    return this.recover(jobId);
  }

  private async recordKnownFailure(job: InspectionStageJob) {
    const facts = await this.store.transaction(async (tx) => {
      await requireActiveRevision(tx, job.ownerUid, fenceOf(job));
      const current = InspectionStageJob.parse(
        await tx.get(`stageJobs/${job.id}`),
      );
      const operation = Operation.parse(
        await tx.get(`operations/${job.operationId}`),
      );
      const inspection = await tx.get(
        `audits/${job.auditId}/revisions/${job.revisionId}/inspection/current`,
      );
      const proof = await tx.get(`sandboxTerminations/${job.operationId}`);
      if (
        current.id !== job.id ||
        current.status !== 'dispatching' ||
        current.operationId !== job.operationId ||
        operation.id !== job.operationId ||
        operation.ownerUid !== job.ownerUid ||
        operation.auditId !== job.auditId ||
        operation.revisionId !== job.revisionId ||
        operation.inputDigest !== job.inputDigest ||
        operation.fence !== job.generation ||
        !job.sandboxRequest ||
        operation.requestDigest !==
          (await sha256(canonicalJson(job.sandboxRequest)))
      )
        throw new Error('Inspection failure identity mismatch');
      if (inspection) return { kind: 'published' as const };
      if (operation.outcome === 'reserved') return { kind: 'unused' as const };
      if (!proof) return { kind: 'unknown' as const };
      const termination = SandboxTermination.parse(proof);
      if (
        termination.operationId !== operation.id ||
        termination.sandboxId !== operation.providerHandle ||
        termination.ownerUid !== job.ownerUid ||
        termination.auditId !== job.auditId ||
        termination.revisionId !== job.revisionId ||
        termination.inputDigest !== job.inputDigest ||
        termination.requestDigest !== operation.requestDigest
      )
        throw new Error('Inspection failure termination mismatch');
      return { kind: 'terminated' as const };
    });
    if (facts.kind === 'published' || facts.kind === 'unknown') return;
    if (facts.kind === 'unused') {
      await releaseUndispatched(
        new FirestoreAccountingStore(this.store),
        job.operationId,
        job.generation,
        this.clock().toISOString(),
      );
      await this.admission.releaseUnused(
        job.ownerUid,
        fenceOf(job),
        job.leaseId!,
      );
    } else
      await this.admission.releaseReconciled(
        job.ownerUid,
        fenceOf(job),
        job.leaseId!,
      );
    await this.store.transaction(async (tx) => {
      await requireActiveRevision(tx, job.ownerUid, fenceOf(job));
      const current = InspectionStageJob.parse(
        await tx.get(`stageJobs/${job.id}`),
      );
      if (
        current.id !== job.id ||
        current.status !== 'dispatching' ||
        current.operationId !== job.operationId
      )
        throw new Error('Inspection failure checkpoint changed');
      tx.set(
        `stageJobs/${job.id}`,
        nativeTimestamps({
          ...current,
          status: 'inspection_failed',
          updatedAt: this.clock().toISOString(),
        }),
      );
    });
  }

  async recover(jobId: string) {
    Digest.parse(jobId);
    const completion = await this.store.transaction(async (tx) => {
      const job = InspectionStageJob.parse(await tx.get(`stageJobs/${jobId}`));
      if (
        job.id !== jobId ||
        !job.sandboxRequest ||
        !job.leaseId ||
        !['dispatching', 'inspection_complete'].includes(job.status)
      )
        throw new Error('Inspection recovery has no claimed request');
      await requireActiveRevision(tx, job.ownerUid, fenceOf(job));
      const snapshot = await inspectRunInputs(
        tx,
        job.ownerUid,
        job.auditId,
        job.revisionId,
        this.clock(),
      );
      if (
        snapshot.state.stage !== 'inspecting' ||
        snapshot.manifestDigest !== job.manifestDigest
      )
        throw new Error('Inspection recovery source snapshot changed');
      const [operationValue, inspection, claim, terminationValue] =
        await tx.getMany([
          `operations/${job.operationId}`,
          `audits/${job.auditId}/revisions/${job.revisionId}/inspection/current`,
          `inspectionExecutions/${job.operationId}`,
          `sandboxTerminations/${job.operationId}`,
        ]);
      const operation = Operation.parse(operationValue);
      if (!inspection || !terminationValue) return { job, next: null };
      const termination = SandboxTermination.parse(terminationValue);
      const resultDigest = Digest.parse(inspection.resultDigest);
      const gate = InspectionGate.parse(inspection.gate);
      const sources = [];
      const entries = snapshot.manifest.filter((item) =>
        item.path.endsWith('.py'),
      );
      const evidence = await tx.getMany(
        entries.map(
          (entry) =>
            `audits/${job.auditId}/revisions/${job.revisionId}/inspectionSources/${entry.artifactId}`,
        ),
      );
      for (const [index, entry] of entries.entries()) {
        const source = evidence[index];
        if (
          !source ||
          source.ownerUid !== job.ownerUid ||
          source.operationId !== job.operationId ||
          source.inputDigest !== job.inputDigest ||
          source.artifactId !== entry.artifactId
        )
          throw new Error('Inspection recovery source evidence mismatch');
        sources.push({
          artifactId: entry.artifactId,
          inspection: validateInspectionResult(source.inspection, entry.sha256),
        });
      }
      const result = InspectionJobResult.parse({
        schemaVersion: '1.0',
        operationId: job.operationId,
        inputDigest: job.inputDigest,
        sources,
      });
      const recomputedGate = evaluateInspectionGate(
        snapshot.manifest,
        sources.map((source) => ({
          artifactId: source.artifactId,
          result: source.inspection,
        })),
        snapshot.policy,
      );
      if (
        (await sha256(canonicalJson(result))) !== resultDigest ||
        canonicalJson(gate) !== canonicalJson(recomputedGate) ||
        canonicalJson(inspection.sourceArtifactIds) !==
          canonicalJson(sources.map((source) => source.artifactId))
      )
        throw new Error('Inspection recovery result digest or gate changed');
      if (
        operation.id !== job.operationId ||
        operation.ownerUid !== job.ownerUid ||
        operation.auditId !== job.auditId ||
        operation.revisionId !== job.revisionId ||
        operation.inputDigest !== job.inputDigest ||
        operation.fence !== job.generation ||
        operation.requestDigest !==
          (await sha256(canonicalJson(job.sandboxRequest))) ||
        inspection.ownerUid !== job.ownerUid ||
        inspection.operationId !== operation.id ||
        inspection.inputDigest !== job.inputDigest ||
        claim?.status !== 'published' ||
        claim.operationId !== operation.id ||
        claim.ownerUid !== job.ownerUid ||
        claim.auditId !== job.auditId ||
        claim.revisionId !== job.revisionId ||
        claim.inputDigest !== job.inputDigest ||
        claim.generation !== job.generation ||
        claim.resultDigest !== resultDigest ||
        claim.sandboxId !== operation.providerHandle ||
        termination.operationId !== operation.id ||
        termination.sandboxId !== operation.providerHandle ||
        termination.ownerUid !== job.ownerUid ||
        termination.auditId !== job.auditId ||
        termination.revisionId !== job.revisionId ||
        termination.inputDigest !== job.inputDigest ||
        termination.requestDigest !== operation.requestDigest ||
        (job.resultDigest !== null && job.resultDigest !== resultDigest)
      )
        throw new Error('Inspection recovery evidence identity mismatch');
      if (job.status !== 'inspection_complete')
        tx.set(
          `stageJobs/${jobId}`,
          nativeTimestamps({
            ...job,
            status: 'inspection_complete',
            resultDigest,
            updatedAt: this.clock().toISOString(),
          }),
        );
      return { job: { ...job, resultDigest }, next: gate.next };
    });
    if (completion.next === null)
      return {
        status: 'awaiting_reconciliation' as const,
        jobId,
        operationId: completion.job.operationId,
      };
    await this.admission.releaseReconciled(
      completion.job.ownerUid,
      fenceOf(completion.job),
      completion.job.leaseId!,
    );
    return {
      status: 'inspection_complete' as const,
      jobId,
      operationId: completion.job.operationId,
      resultDigest: completion.job.resultDigest!,
      next: completion.next,
    };
  }
}
