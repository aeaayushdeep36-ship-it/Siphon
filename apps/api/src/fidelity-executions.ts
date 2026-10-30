import { type DocumentStore, type DocumentTransaction } from './firestore.js';
import { requireActiveRevision } from './audit-commands.js';
import { BudgetCounter, Operation } from './accounting.js';
import { SandboxRequest } from './e2b-client.js';
import { inspectStoredObservationSnapshot } from './stored-observations.js';
import {
  FidelityRequest,
  validateFidelityResult,
  type FidelityExecutionGate,
} from './fidelity-runner.js';
import { canonicalJson, sha256 } from './hashing.js';
import {
  DEFAULT_POLICY,
  ObservationValidationResult,
  Timestamp,
} from '@siphon/contracts';
import { SandboxTermination } from './sandbox-termination.js';
import { SourceExecutionBinding } from './source-executions.js';

/** Durable comparison admission; no method here certifies adapter fidelity. */
export class FidelityExecutions implements FidelityExecutionGate {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  private async inspect(
    tx: DocumentTransaction,
    value: unknown,
    completed = false,
  ) {
    const request = FidelityRequest.parse(value),
      operation = Operation.parse(
        await tx.get(`operations/${request.operationId}`),
      );
    const fence = {
      auditId: operation.auditId,
      revisionId: operation.revisionId,
      inputDigest: operation.inputDigest,
      generation: operation.fence,
    };
    await requireActiveRevision(tx, operation.ownerUid, fence);
    if (
      operation.id !== request.operationId ||
      request.original.inputDigest !== operation.inputDigest
    )
      throw new Error('Comparison operation mismatch');
    const base = `audits/${operation.auditId}/revisions/${operation.revisionId}`;
    const snapshots = [];
    for (const [job, profile] of [
      [request.original, 'reference_v1'],
      [request.adapted, 'adapter_v1'],
    ] as const) {
      const snapshot = await inspectStoredObservationSnapshot(
        tx,
        operation.ownerUid,
        job.sourceOperationId,
        operation.id,
        fence,
        completed,
        this.clock(),
      );
      const [record, binding, validationOp, termination] = await tx.getMany([
        `${base}/numericValidations/${job.evaluationOperationId}`,
        `validationExecutions/${job.evaluationOperationId}`,
        `operations/${job.evaluationOperationId}`,
        `sandboxTerminations/${job.evaluationOperationId}`,
      ]);
      const validation = ObservationValidationResult.parse(record?.report),
        priorOperation = Operation.parse(validationOp),
        sourceBinding = SourceExecutionBinding.parse(
          await tx.get(`sourceExecutions/${job.sourceOperationId}`),
        );
      if (
        record?.ownerUid !== operation.ownerUid ||
        sourceBinding.extractionProfile !== profile ||
        record.auditId !== operation.auditId ||
        record.revisionId !== operation.revisionId ||
        record.inputDigest !== operation.inputDigest ||
        record.operationId !== job.evaluationOperationId ||
        record.sourceOperationId !== job.sourceOperationId ||
        record.adapterDigest !== job.adapterDigest ||
        Date.parse(Timestamp.parse(record.expiresAt)) <=
          this.clock().getTime() ||
        record.reportDigest !== (await sha256(canonicalJson(validation))) ||
        canonicalJson(binding?.request) !== canonicalJson(job) ||
        binding?.status !== 'published' ||
        binding.ownerUid !== operation.ownerUid ||
        binding.operationId !== job.evaluationOperationId ||
        binding.inputDigest !== operation.inputDigest ||
        priorOperation.id !== job.evaluationOperationId ||
        priorOperation.ownerUid !== operation.ownerUid ||
        priorOperation.auditId !== operation.auditId ||
        priorOperation.revisionId !== operation.revisionId ||
        priorOperation.inputDigest !== operation.inputDigest ||
        termination?.operationId !== job.evaluationOperationId ||
        termination.ownerUid !== operation.ownerUid ||
        termination.auditId !== operation.auditId ||
        termination.revisionId !== operation.revisionId ||
        termination.inputDigest !== operation.inputDigest ||
        termination.sandboxId !== priorOperation.providerHandle ||
        termination.requestDigest !== priorOperation.requestDigest ||
        validation.sourceOperationId !== job.sourceOperationId ||
        validation.evaluationOperationId !== job.evaluationOperationId ||
        validation.adapterDigest !== job.adapterDigest ||
        validation.inputDigest !== operation.inputDigest ||
        snapshot.plan.outputDigest !==
          (await sha256(canonicalJson(job.manifest))) ||
        (await sha256(canonicalJson(snapshot.adapter))) !== job.adapterDigest
      )
        throw new Error(
          'Comparison requires both published numeric validations',
        );
      snapshots.push(snapshot);
    }
    return { request, operation, snapshots };
  }
  async bind(uid: string, value: unknown) {
    const request = FidelityRequest.parse(value),
      digest = await sha256(canonicalJson(request));
    return this.store.transaction(async (tx) => {
      const { operation, snapshots } = await this.inspect(tx, request);
      const prior = await tx.get(`fidelityExecutions/${operation.id}`),
        other = await tx.getMany([
          `validationExecutions/${operation.id}`,
          `diagnosticExecutions/${operation.id}`,
          `conservationExecutions/${operation.id}`,
        ]);
      if (operation.ownerUid !== uid || other.some(Boolean))
        throw new Error('Comparison operation unavailable');
      const key = `revision_output_bytes_${operation.revisionId}`;
      const [rawBudget, reservation] = await tx.getMany([
        `budgets/${key}`,
        `reservations/fidelity_report_${operation.id}`,
      ]);
      const budget = BudgetCounter.parse(rawBudget);
      if (prior) {
        if (
          prior.ownerUid !== uid ||
          prior.payloadDigest !== digest ||
          canonicalJson(prior.request) !== canonicalJson(request) ||
          reservation?.status !== 'reserved' ||
          reservation.amount !== 32768 ||
          reservation.payloadDigest !== digest
        )
          throw new Error('Comparison binding conflict');
        return;
      }
      if (operation.outcome !== 'reserved' || reservation)
        throw new Error('Comparison must bind before dispatch');
      if (
        budget.halted ||
        BigInt(budget.reserved) + BigInt(budget.spent) + 32768n >
          BigInt(
            Math.min(
              budget.limit,
              snapshots[0]!.policy.outputBytes,
              DEFAULT_POLICY.outputBytes,
            ),
          )
      )
        throw new Error('Comparison output allowance exhausted');
      tx.set(`budgets/${key}`, {
        ...budget,
        reserved: budget.reserved + 32768,
      });
      tx.set(`reservations/fidelity_report_${operation.id}`, {
        schemaVersion: '1.0',
        operationId: operation.id,
        ownerUid: uid,
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        outputCounterKey: key,
        amount: 32768,
        payloadDigest: digest,
        status: 'reserved',
        createdAt: this.clock(),
        updatedAt: this.clock(),
      });
      tx.set(`fidelityExecutions/${operation.id}`, {
        schemaVersion: '1.0',
        operationId: operation.id,
        ownerUid: uid,
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        inputDigest: operation.inputDigest,
        generation: operation.fence,
        request,
        payloadDigest: digest,
        sandboxRequestDigest: operation.requestDigest,
        status: 'bound',
        sandboxId: null,
        createdAt: this.clock(),
        updatedAt: this.clock(),
      });
    });
  }
  async claim(value: unknown, digest: string, sandboxId: string) {
    const request = FidelityRequest.parse(value);
    if (digest !== (await sha256(canonicalJson(request))))
      throw new Error('Comparison payload changed');
    await this.store.transaction(async (tx) => {
      const { operation, snapshots } = await this.inspect(tx, request);
      const [binding, job, handle, termination] = await tx.getMany([
        `fidelityExecutions/${operation.id}`,
        `sandboxJobs/${operation.id}`,
        `sandboxHandles/${sandboxId}`,
        `sandboxTerminations/${operation.id}`,
      ]);
      const sandbox = SandboxRequest.parse(job?.request);
      if (
        binding?.status !== 'bound' ||
        binding.ownerUid !== operation.ownerUid ||
        binding.payloadDigest !== digest ||
        binding.sandboxRequestDigest !== operation.requestDigest ||
        canonicalJson(binding.request) !== canonicalJson(request) ||
        operation.outcome !== 'dispatching' ||
        operation.providerHandle !== sandboxId ||
        snapshots.some((s) => s.source.providerHandle === sandboxId) ||
        sandbox.role !== 'evaluation' ||
        sandbox.operationId !== operation.id ||
        sandbox.auditId !== operation.auditId ||
        sandbox.revisionId !== operation.revisionId ||
        sandbox.inputDigest !== operation.inputDigest ||
        job?.requestDigest !== operation.requestDigest ||
        (await sha256(canonicalJson(sandbox))) !== operation.requestDigest ||
        handle?.operationId !== operation.id ||
        handle.ownerUid !== operation.ownerUid ||
        handle.auditId !== operation.auditId ||
        handle.revisionId !== operation.revisionId ||
        termination
      )
        throw new Error('Comparison requires a fresh authorized evaluator');
      tx.set(`fidelityExecutions/${operation.id}`, {
        ...binding,
        status: 'claimed',
        sandboxId,
        updatedAt: this.clock(),
      });
    });
  }
  async authorizeResult(operationId: string) {
    await this.store.transaction(async (tx) => {
      const binding = await tx.get(`fidelityExecutions/${operationId}`);
      const { operation } = await this.inspect(tx, binding?.request);
      const [handle, termination] = await tx.getMany([
        `sandboxHandles/${String(binding?.sandboxId)}`,
        `sandboxTerminations/${operationId}`,
      ]);
      if (
        operation.id !== operationId ||
        binding?.status !== 'claimed' ||
        binding.ownerUid !== operation.ownerUid ||
        binding.payloadDigest !==
          (await sha256(canonicalJson(binding.request))) ||
        operation.outcome !== 'dispatching' ||
        operation.providerHandle !== binding.sandboxId ||
        handle?.operationId !== operationId ||
        handle.ownerUid !== operation.ownerUid ||
        termination
      )
        throw new Error('Comparison execution no longer authorized');
    });
  }

  async recordCandidate(operationId: string, value: unknown) {
    return this.store.transaction(async (tx) => {
      const binding = await tx.get(`fidelityExecutions/${operationId}`);
      const { request, operation } = await this.inspect(tx, binding?.request);
      const [handle, termination, prior, reservation] = await tx.getMany([
        `sandboxHandles/${String(binding?.sandboxId)}`,
        `sandboxTerminations/${operationId}`,
        `fidelityCandidates/${operationId}`,
        `reservations/fidelity_report_${operationId}`,
      ]);
      const result = validateFidelityResult(value, request),
        encoded = canonicalJson(result),
        digest = await sha256(encoded);
      if (
        operation.id !== operationId ||
        operation.outcome !== 'dispatching' ||
        binding?.status !== 'claimed' ||
        binding.ownerUid !== operation.ownerUid ||
        binding.payloadDigest !== (await sha256(canonicalJson(request))) ||
        binding.sandboxId !== operation.providerHandle ||
        handle?.operationId !== operationId ||
        handle.ownerUid !== operation.ownerUid ||
        termination ||
        reservation?.status !== 'reserved' ||
        reservation.payloadDigest !== binding.payloadDigest ||
        new TextEncoder().encode(encoded).length > 32768
      )
        throw new Error('Comparison candidate is not authorized');
      if (prior) {
        if (
          prior.resultDigest !== digest ||
          canonicalJson(prior.result) !== encoded
        )
          throw new Error('Comparison candidate conflict');
        return { resultDigest: digest };
      }
      tx.set(`fidelityCandidates/${operationId}`, {
        schemaVersion: '1.0',
        operationId,
        ownerUid: operation.ownerUid,
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        inputDigest: operation.inputDigest,
        payloadDigest: binding.payloadDigest,
        result,
        resultDigest: digest,
        createdAt: this.clock(),
      });
      return { resultDigest: digest };
    });
  }

  async publish(operationId: string) {
    return this.store.transaction(async (tx) => {
      const binding = await tx.get(`fidelityExecutions/${operationId}`),
        { request, operation } = await this.inspect(tx, binding?.request, true);
      const path = `audits/${operation.auditId}/revisions/${operation.revisionId}/baselineComparisons/${operationId}`;
      const [candidate, rawTermination, reservation, rawBudget, prior] =
        await tx.getMany([
          `fidelityCandidates/${operationId}`,
          `sandboxTerminations/${operationId}`,
          `reservations/fidelity_report_${operationId}`,
          `budgets/revision_output_bytes_${operation.revisionId}`,
          path,
        ]);
      const termination = SandboxTermination.parse(rawTermination),
        result = validateFidelityResult(
          candidate?.result ?? prior?.result,
          request,
        ),
        encoded = canonicalJson(result),
        digest = await sha256(encoded),
        bytes = new TextEncoder().encode(encoded).length,
        budget = BudgetCounter.parse(rawBudget);
      if (prior) {
        if (
          binding?.status !== 'published' ||
          binding.ownerUid !== operation.ownerUid ||
          binding.payloadDigest !== (await sha256(canonicalJson(request))) ||
          prior.operationId !== operationId ||
          prior.ownerUid !== operation.ownerUid ||
          prior.auditId !== operation.auditId ||
          prior.revisionId !== operation.revisionId ||
          prior.inputDigest !== operation.inputDigest ||
          prior.payloadDigest !== binding.payloadDigest ||
          prior.resultDigest !== digest ||
          reservation?.status !== 'settled' ||
          reservation.measuredUsage !== bytes ||
          reservation.payloadDigest !== binding.payloadDigest ||
          termination.operationId !== operationId ||
          termination.ownerUid !== operation.ownerUid ||
          termination.auditId !== operation.auditId ||
          termination.revisionId !== operation.revisionId ||
          termination.inputDigest !== operation.inputDigest ||
          termination.requestDigest !== operation.requestDigest ||
          termination.sandboxId !== operation.providerHandle ||
          termination.sandboxId !== binding.sandboxId
        )
          throw new Error('Published comparison conflict');
        return { resultDigest: digest, replayed: true };
      }
      if (
        binding?.status !== 'claimed' ||
        binding.ownerUid !== operation.ownerUid ||
        binding.payloadDigest !== (await sha256(canonicalJson(request))) ||
        candidate?.ownerUid !== operation.ownerUid ||
        candidate.operationId !== operationId ||
        candidate.payloadDigest !== binding.payloadDigest ||
        candidate.resultDigest !== digest ||
        termination.operationId !== operationId ||
        termination.ownerUid !== operation.ownerUid ||
        termination.auditId !== operation.auditId ||
        termination.revisionId !== operation.revisionId ||
        termination.inputDigest !== operation.inputDigest ||
        termination.requestDigest !== operation.requestDigest ||
        termination.sandboxId !== operation.providerHandle ||
        termination.sandboxId !== binding.sandboxId ||
        reservation?.status !== 'reserved' ||
        reservation.amount !== 32768 ||
        reservation.payloadDigest !== binding.payloadDigest ||
        budget.reserved < 32768 ||
        bytes > 32768 ||
        candidate.auditId !== operation.auditId ||
        candidate.revisionId !== operation.revisionId ||
        candidate.inputDigest !== operation.inputDigest
      )
        throw new Error(
          'Comparison publication requires the matching terminated evaluator',
        );
      tx.set(`budgets/revision_output_bytes_${operation.revisionId}`, {
        ...budget,
        reserved: budget.reserved - 32768,
        spent: budget.spent + bytes,
      });
      tx.set(`reservations/fidelity_report_${operationId}`, {
        ...reservation,
        status: 'settled',
        measuredUsage: bytes,
        updatedAt: this.clock(),
      });
      tx.set(path, {
        schemaVersion: '1.0',
        operationId,
        ownerUid: operation.ownerUid,
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        inputDigest: operation.inputDigest,
        payloadDigest: binding.payloadDigest,
        result,
        resultDigest: digest,
        originalOperationId: request.original.sourceOperationId,
        adaptedOperationId: request.adapted.sourceOperationId,
        createdAt: this.clock(),
      });
      tx.set(`fidelityExecutions/${operationId}`, {
        ...binding,
        status: 'published',
        updatedAt: this.clock(),
      });
      tx.delete(`fidelityCandidates/${operationId}`);
      return { resultDigest: digest, replayed: false };
    });
  }
}
