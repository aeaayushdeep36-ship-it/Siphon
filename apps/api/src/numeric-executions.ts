import { z } from 'zod';
import {
  ObservationValidationRequest,
  validateObservationValidationResult,
  Count,
  Id,
  Digest,
  Timestamp,
  DEFAULT_POLICY,
  DiagnosticJobRequest,
  validateDiagnosticJobResult,
  ContextProposal,
  ConservationJobRequest,
  validateConservationJobResult,
  AuditPlan,
  BaselineComparison,
  AdapterProposal,
} from '@siphon/contracts';
import { type DocumentStore, type DocumentTransaction } from './firestore.js';
import { Operation, BudgetCounter } from './accounting.js';
import { canonicalJson, sha256 } from './hashing.js';
import { inspectStoredObservationSnapshot } from './stored-observations.js';
import { SandboxRequest } from './e2b-client.js';
import { SandboxTermination } from './sandbox-termination.js';
import { nativeTimestamps } from './audit-commands.js';
import { type ValidationExecutionGate } from './validation-runner.js';
import { RETENTION } from './retention.js';

const Request = z.union([
  ObservationValidationRequest,
  DiagnosticJobRequest,
  ConservationJobRequest,
]);
type Request = z.infer<typeof Request>;
const observations = (request: Request) =>
  'diagnostic' in request
    ? request.diagnostic.validation
    : 'validation' in request
      ? request.validation
      : request;
const requestOperationId = (request: Request) =>
  'diagnostic' in request
    ? request.diagnostic.operationId
    : 'operationId' in request
      ? request.operationId
      : request.evaluationOperationId;

const Binding = z.strictObject({
  schemaVersion: z.literal('1.0'),
  operationId: Id,
  ownerUid: z.string(),
  auditId: Id,
  revisionId: Id,
  inputDigest: Digest,
  generation: Count,
  payloadDigest: Digest,
  sandboxRequestDigest: Digest,
  request: Request,
  status: z.enum(['bound', 'claimed', 'published']),
  sandboxId: z.string().nullable(),
  reservedReportBytes: z.literal(32768),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

/** Shared durable lifecycle; each concrete service fixes its own protocol/collections. */
export class NumericExecutions implements ValidationExecutionGate {
  protected constructor(
    private readonly store: DocumentStore,
    private readonly mode: 'validation' | 'diagnostics' | 'conservation',
    private readonly clock: () => Date = () => new Date(),
  ) {}
  private parse(value: unknown): Request {
    return this.mode === 'conservation'
      ? ConservationJobRequest.parse(value)
      : this.mode === 'validation'
        ? ObservationValidationRequest.parse(value)
        : DiagnosticJobRequest.parse(value);
  }
  private validateResult(value: unknown, request: Request) {
    return this.mode === 'conservation'
      ? validateConservationJobResult(value, request)
      : this.mode === 'validation'
        ? validateObservationValidationResult(value, request)
        : validateDiagnosticJobResult(value, request);
  }
  private bindingPath(id: string) {
    return `${this.mode === 'conservation' ? 'conservationExecutions' : this.mode === 'validation' ? 'validationExecutions' : 'diagnosticExecutions'}/${id}`;
  }
  private candidatePath(id: string) {
    return `${this.mode === 'conservation' ? 'conservationCandidates' : this.mode === 'validation' ? 'validationCandidates' : 'diagnosticCandidates'}/${id}`;
  }
  private reservationPath(id: string) {
    return `reservations/${this.mode === 'conservation' ? 'conservation' : this.mode === 'validation' ? 'validation' : 'diagnostic'}_report_${id}`;
  }
  private reportPath(operation: Operation) {
    return `audits/${operation.auditId}/revisions/${operation.revisionId}/${this.mode === 'conservation' ? 'evidence' : this.mode === 'validation' ? 'numericValidations' : 'numericDiagnostics'}/${operation.id}`;
  }
  private async inspect(
    tx: DocumentTransaction,
    value: Request,
    completed = false,
  ) {
    const request = observations(this.parse(value));
    const operationId = requestOperationId(value);
    const evaluation = Operation.parse(
      await tx.get(`operations/${operationId}`),
    );
    if (evaluation.id !== operationId)
      throw new Error('Evaluation operation key mismatch');
    const snapshot = await inspectStoredObservationSnapshot(
      tx,
      evaluation.ownerUid,
      request.sourceOperationId,
      evaluation.id,
      {
        auditId: evaluation.auditId,
        revisionId: evaluation.revisionId,
        generation: evaluation.fence,
        inputDigest: evaluation.inputDigest,
      },
      completed,
      this.clock(),
    );
    const revision = await tx.get(
      `audits/${evaluation.auditId}/revisions/${evaluation.revisionId}`,
    );
    if (
      !['adapting', 'evaluating'].includes(String(revision?.stage)) ||
      request.inputDigest !== evaluation.inputDigest ||
      request.adapterDigest !==
        (await sha256(canonicalJson(snapshot.adapter))) ||
      canonicalJson(request.mappings) !==
        canonicalJson(snapshot.adapter.mappings) ||
      (await sha256(canonicalJson(request.manifest))) !==
        snapshot.plan.outputDigest ||
      request.maximumBytes >
        Math.min(snapshot.policy.outputBytes, DEFAULT_POLICY.outputBytes) ||
      request.maximumElements >
        Math.floor(
          Math.min(snapshot.policy.outputBytes, DEFAULT_POLICY.outputBytes) / 8,
        )
    )
      throw new Error(
        'Validation input does not match the current stored observation snapshot',
      );
    const excludedSandboxIds = [snapshot.source.providerHandle];
    const diagnostic = 'diagnostic' in value ? value.diagnostic : value;
    if ('validation' in diagnostic) {
      const previous = Binding.parse(
        await tx.get(`validationExecutions/${request.evaluationOperationId}`),
      );
      const priorOperation = Operation.parse(
        await tx.get(`operations/${request.evaluationOperationId}`),
      );
      const report = await tx.get(
        `audits/${evaluation.auditId}/revisions/${evaluation.revisionId}/numericValidations/${request.evaluationOperationId}`,
      );
      const termination = SandboxTermination.parse(
        await tx.get(`sandboxTerminations/${request.evaluationOperationId}`),
      );
      const verifiedReport = validateObservationValidationResult(
        report?.report,
        request,
      );
      const context = await tx.get(
        `audits/${evaluation.auditId}/revisions/${evaluation.revisionId}/context/current`,
      );
      const proposal = ContextProposal.parse(context?.proposal);
      const shape = (key: string) =>
        request.mappings.find((item) => item.key === key)?.expectedShape ?? [];
      const isHeat = diagnostic.profile.kind.startsWith('heat_');
      if (
        revision?.stage !== 'evaluating' ||
        diagnostic.auditId !== evaluation.auditId ||
        diagnostic.revisionId !== evaluation.revisionId ||
        diagnostic.contextDigest !== snapshot.adapter.contextDigest ||
        context?.ownerUid !== evaluation.ownerUid ||
        context.inputDigest !== evaluation.inputDigest ||
        context.proposalDigest !== diagnostic.contextDigest ||
        (await sha256(canonicalJson(context.proposal))) !==
          diagnostic.contextDigest ||
        proposal.auditId !== evaluation.auditId ||
        proposal.revisionId !== evaluation.revisionId ||
        proposal.inputDigest !== evaluation.inputDigest ||
        proposal.domain !== snapshot.adapter.domain ||
        (isHeat
          ? shape('thermal_weights').reduce((a, b) => a * b, 1) >
            snapshot.policy.heatCells
          : (shape('positions')[1] ?? Infinity) >
            snapshot.policy.orbitalBodies) ||
        (isHeat
          ? snapshot.adapter.domain !== 'heat_diffusion'
          : snapshot.adapter.domain !== 'orbital_dynamics') ||
        previous.status !== 'published' ||
        previous.operationId !== request.evaluationOperationId ||
        previous.ownerUid !== evaluation.ownerUid ||
        previous.auditId !== evaluation.auditId ||
        previous.revisionId !== evaluation.revisionId ||
        previous.inputDigest !== evaluation.inputDigest ||
        previous.sandboxRequestDigest !== priorOperation.requestDigest ||
        previous.generation !== priorOperation.fence ||
        previous.payloadDigest !== (await sha256(canonicalJson(request))) ||
        canonicalJson(previous.request) !== canonicalJson(request) ||
        priorOperation.id !== request.evaluationOperationId ||
        priorOperation.outcome === 'reserved' ||
        priorOperation.ownerUid !== evaluation.ownerUid ||
        priorOperation.auditId !== evaluation.auditId ||
        priorOperation.revisionId !== evaluation.revisionId ||
        priorOperation.inputDigest !== evaluation.inputDigest ||
        report?.operationId !== priorOperation.id ||
        report.ownerUid !== evaluation.ownerUid ||
        report.auditId !== evaluation.auditId ||
        report.revisionId !== evaluation.revisionId ||
        report.inputDigest !== evaluation.inputDigest ||
        report.sourceOperationId !== request.sourceOperationId ||
        report.adapterDigest !== request.adapterDigest ||
        report.reportDigest !== (await sha256(canonicalJson(verifiedReport))) ||
        Date.parse(Timestamp.parse(report.expiresAt)) <=
          this.clock().getTime() ||
        termination.operationId !== priorOperation.id ||
        termination.sandboxId !== priorOperation.providerHandle ||
        termination.sandboxId !== previous.sandboxId ||
        termination.sandboxId === snapshot.source.providerHandle ||
        termination.ownerUid !== evaluation.ownerUid ||
        termination.auditId !== evaluation.auditId ||
        termination.revisionId !== evaluation.revisionId ||
        termination.inputDigest !== evaluation.inputDigest ||
        termination.requestDigest !== priorOperation.requestDigest
      )
        throw new Error(
          'Diagnostics require current context and previously published numeric validation',
        );
      excludedSandboxIds.push(termination.sandboxId);
    }
    if ('diagnostic' in value) {
      const originalSandbox = await this.inspectCurrentPlan(
        tx,
        value,
        evaluation,
        snapshot.plan.outputDigest,
        completed,
      );
      excludedSandboxIds.push(originalSandbox);
    }
    return { ...snapshot, excludedSandboxIds };
  }
  private async inspectCurrentPlan(
    tx: DocumentTransaction,
    request: z.infer<typeof ConservationJobRequest>,
    operation: Operation,
    sourceOutputDigest: string,
    completed: boolean,
  ) {
    const base = `audits/${operation.auditId}/revisions/${operation.revisionId}`;
    const [rawAdapter, rawPlan] = await tx.getMany([
      `${base}/adapters/current`,
      `${base}/plans/current`,
    ]);
    const adapter = AdapterProposal.parse(rawAdapter?.proposal);
    const baseline = BaselineComparison.parse(rawAdapter?.baseline);
    const plan = AuditPlan.parse(rawPlan?.plan);
    const diagnostic = request.diagnostic;
    const validation = diagnostic.validation;
    const digest = await sha256(canonicalJson(plan));
    for (const record of [rawAdapter, rawPlan]) {
      if (
        !record ||
        record.ownerUid !== operation.ownerUid ||
        record.inputDigest !== operation.inputDigest ||
        Date.parse(Timestamp.parse(record.expiresAt)) <= this.clock().getTime()
      )
        throw new Error('Conservation stage record is stale or unavailable');
    }
    const selected = plan.checks.filter(
      (check) => check.selection === 'selected',
    );
    if (
      rawAdapter?.status !== 'verified' ||
      baseline.status !== 'matched' ||
      rawAdapter.adapterDigest !== validation.adapterDigest ||
      (await sha256(canonicalJson(adapter))) !== validation.adapterDigest ||
      rawAdapter.adaptedOperationId !== validation.sourceOperationId ||
      rawAdapter.originalOperationId === rawAdapter.adaptedOperationId ||
      adapter.auditId !== operation.auditId ||
      adapter.revisionId !== operation.revisionId ||
      adapter.inputDigest !== operation.inputDigest ||
      adapter.contextDigest !== diagnostic.contextDigest ||
      plan.auditId !== operation.auditId ||
      plan.revisionId !== operation.revisionId ||
      plan.inputDigest !== operation.inputDigest ||
      plan.domain !== adapter.domain ||
      plan.contextDigest !== diagnostic.contextDigest ||
      plan.adapterDigest !== validation.adapterDigest ||
      rawPlan?.planDigest !== digest ||
      request.planDigest !== digest ||
      canonicalJson(plan.assessment) !== canonicalJson(request.eligibility) ||
      canonicalJson(Object.keys(request.evidenceIds).sort()) !==
        canonicalJson(selected.map((check) => check.checkId).sort()) ||
      canonicalJson(baseline.observations.map((entry) => entry.key).sort()) !==
        canonicalJson(validation.mappings.map((entry) => entry.key).sort()) ||
      baseline.comparedElements !==
        validation.mappings.reduce(
          (sum, entry) => sum + entry.expectedShape.reduce((a, b) => a * b, 1),
          0,
        )
    )
      throw new Error(
        'Conservation requires the current verified adapter and deterministic plan',
      );
    for (const check of selected) {
      const policy = plan.accuracyPolicies[check.checkId];
      if (
        !policy ||
        canonicalJson(policy) !==
          canonicalJson(request.policies[check.checkId]) ||
        check.experimentIds.length !== 1 ||
        check.experimentIds[0] !== validation.sourceOperationId
      )
        throw new Error(
          'Conservation accuracy policy or experiment assignment mismatch',
        );
    }
    const experiment = plan.experiments.find(
      (entry) => entry.id === validation.sourceOperationId,
    );
    if (
      !experiment ||
      experiment.status !== 'completed' ||
      experiment.resultDigest !== sourceOutputDigest
    )
      throw new Error('Conservation experiment lacks stored result provenance');
    const originalId = Id.parse(rawAdapter!.originalOperationId);
    const original = await inspectStoredObservationSnapshot(
      tx,
      operation.ownerUid,
      originalId,
      operation.id,
      {
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        generation: operation.fence,
        inputDigest: operation.inputDigest,
      },
      completed,
      this.clock(),
    );
    if (
      (await sha256(canonicalJson(original.adapter))) !==
      validation.adapterDigest
    )
      throw new Error(
        'Original baseline adapter differs from the matched snapshot',
      );
    if (!original.source.providerHandle)
      throw new Error('Original baseline termination handle missing');
    return original.source.providerHandle;
  }
  async bind(value: unknown, expectedOwnerUid?: string) {
    const request = this.parse(value);
    const payloadDigest = await sha256(canonicalJson(request));
    return this.store.transaction(async (tx) => {
      const snapshot = await this.inspect(tx, request);
      const operation = snapshot.evaluation;
      if (
        expectedOwnerUid !== undefined &&
        operation.ownerUid !== expectedOwnerUid
      )
        throw new Error('Numeric execution owner mismatch');
      const prior = await tx.get(this.bindingPath(operation.id));
      const other = await tx.get(
        `${this.mode === 'validation' ? 'diagnosticExecutions' : 'validationExecutions'}/${operation.id}`,
      );
      const reservation = await tx.get(this.reservationPath(operation.id));
      const conserved = await tx.get(
        `${this.mode === 'conservation' ? 'diagnosticExecutions' : 'conservationExecutions'}/${operation.id}`,
      );
      if (other || conserved)
        throw new Error(
          'Numeric operation is already bound to another job kind',
        );
      if (prior) {
        const old = Binding.parse(prior);
        this.assertReservation(reservation, operation, old);
        if (
          old.operationId !== operation.id ||
          old.ownerUid !== operation.ownerUid ||
          old.auditId !== operation.auditId ||
          old.revisionId !== operation.revisionId ||
          old.inputDigest !== operation.inputDigest ||
          old.generation !== operation.fence ||
          old.sandboxRequestDigest !== operation.requestDigest ||
          old.payloadDigest !== payloadDigest ||
          canonicalJson(old.request) !== canonicalJson(request) ||
          reservation?.status !== 'reserved' ||
          reservation.amount !== 32768
        )
          throw new Error('Validation execution binding conflict');
        return old;
      }
      if (operation.outcome !== 'reserved' || reservation)
        throw new Error('Validation binding must precede dispatch');
      const key = `revision_output_bytes_${operation.revisionId}`;
      const output = BudgetCounter.parse(await tx.get(`budgets/${key}`));
      if (
        output.halted ||
        BigInt(output.spent) + BigInt(output.reserved) + 32768n >
          BigInt(
            Math.min(
              output.limit,
              snapshot.policy.outputBytes,
              DEFAULT_POLICY.outputBytes,
            ),
          )
      )
        throw new Error('Validation report output allowance exhausted');
      const now = this.clock();
      const binding = Binding.parse({
        schemaVersion: '1.0',
        operationId: operation.id,
        ownerUid: operation.ownerUid,
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        inputDigest: operation.inputDigest,
        generation: operation.fence,
        payloadDigest,
        sandboxRequestDigest: operation.requestDigest,
        request,
        status: 'bound',
        sandboxId: null,
        reservedReportBytes: 32768,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      tx.set(`budgets/${key}`, {
        ...output,
        reserved: output.reserved + 32768,
      });
      tx.set(this.bindingPath(operation.id), nativeTimestamps(binding));
      tx.set(this.reservationPath(operation.id), {
        schemaVersion: '1.0',
        operationId: operation.id,
        ownerUid: operation.ownerUid,
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        outputCounterKey: key,
        amount: 32768,
        payloadDigest,
        status: 'reserved',
        createdAt: now,
        updatedAt: now,
      });
      return binding;
    });
  }
  async claim(
    value: unknown,
    payloadDigest: string,
    sandboxId: string,
  ): Promise<void> {
    const request = this.parse(value);
    if (payloadDigest !== (await sha256(canonicalJson(request))))
      throw new Error('Validation payload digest mismatch');
    await this.store.transaction(async (tx) => {
      const snapshot = await this.inspect(tx, request);
      const operation = snapshot.evaluation;
      const binding = Binding.parse(
        await tx.get(this.bindingPath(operation.id)),
      );
      const job = await tx.get(`sandboxJobs/${operation.id}`);
      const sandbox = SandboxRequest.parse(job?.request);
      const handle = await tx.get(`sandboxHandles/${sandboxId}`);
      const termination = await tx.get(`sandboxTerminations/${operation.id}`);
      const reservation = await tx.get(this.reservationPath(operation.id));
      this.assertBinding(binding, operation, payloadDigest);
      this.assertReservation(reservation, operation, binding);
      if (
        binding.status !== 'bound' ||
        canonicalJson(binding.request) !== canonicalJson(request) ||
        operation.outcome !== 'dispatching' ||
        operation.providerHandle !== sandboxId ||
        snapshot.excludedSandboxIds.includes(sandboxId) ||
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
        termination ||
        reservation?.status !== 'reserved' ||
        reservation.amount !== 32768 ||
        reservation.payloadDigest !== payloadDigest
      )
        throw new Error(
          'Validation requires a fresh authorized evaluation sandbox',
        );
      tx.set(
        this.bindingPath(operation.id),
        nativeTimestamps({
          ...binding,
          status: 'claimed',
          sandboxId,
          updatedAt: this.clock().toISOString(),
        }),
      );
    });
  }
  private assertBinding(
    binding: z.infer<typeof Binding>,
    operation: Operation,
    digest: string,
  ) {
    if (
      binding.operationId !== operation.id ||
      binding.ownerUid !== operation.ownerUid ||
      binding.auditId !== operation.auditId ||
      binding.revisionId !== operation.revisionId ||
      binding.inputDigest !== operation.inputDigest ||
      binding.generation !== operation.fence ||
      binding.sandboxRequestDigest !== operation.requestDigest ||
      binding.payloadDigest !== digest
    )
      throw new Error('Validation execution identity mismatch');
  }
  private assertReservation(
    reservation: Record<string, unknown> | null,
    operation: Operation,
    binding: z.infer<typeof Binding>,
  ) {
    if (
      !reservation ||
      reservation.operationId !== operation.id ||
      reservation.ownerUid !== operation.ownerUid ||
      reservation.auditId !== operation.auditId ||
      reservation.revisionId !== operation.revisionId ||
      reservation.amount !== 32768 ||
      reservation.payloadDigest !== binding.payloadDigest ||
      reservation.outputCounterKey !==
        `revision_output_bytes_${operation.revisionId}`
    )
      throw new Error('Validation report reservation identity mismatch');
  }
  async authorizeResult(operationId: string): Promise<void> {
    Id.parse(operationId);
    await this.store.transaction(async (tx) => {
      const binding = Binding.parse(
        await tx.get(this.bindingPath(operationId)),
      );
      if (binding.operationId !== operationId)
        throw new Error('Validation binding key mismatch');
      const { evaluation } = await this.inspect(tx, binding.request);
      this.assertBinding(
        binding,
        evaluation,
        await sha256(canonicalJson(binding.request)),
      );
      if (
        binding.status !== 'claimed' ||
        binding.sandboxId !== evaluation.providerHandle
      )
        throw new Error('Validation result is not authorized');
    });
  }
  /** Private recovery journal, not user-visible validation evidence. */
  async recordCandidate(operationId: string, value: unknown) {
    Id.parse(operationId);
    return this.store.transaction(async (tx) => {
      const binding = Binding.parse(
        await tx.get(this.bindingPath(operationId)),
      );
      if (binding.operationId !== operationId)
        throw new Error('Validation binding key mismatch');
      const { evaluation: operation } = await this.inspect(
        tx,
        binding.request,
        true,
      );
      this.assertBinding(
        binding,
        operation,
        await sha256(canonicalJson(binding.request)),
      );
      const result = this.validateResult(value, binding.request);
      const encoded = canonicalJson(result),
        digest = await sha256(encoded);
      if (
        new TextEncoder().encode(encoded).length > 32768 ||
        binding.status === 'bound' ||
        binding.sandboxId !== operation.providerHandle
      )
        throw new Error('Validation candidate is not authorized');
      const previous = await tx.get(this.candidatePath(operationId));
      const published = await tx.get(this.reportPath(operation));
      const reservation = await tx.get(this.reservationPath(operationId));
      this.assertReservation(reservation, operation, binding);
      if (binding.status === 'published') {
        if (
          published?.operationId !== operationId ||
          published.reportDigest !== digest ||
          reservation?.status !== 'settled'
        )
          throw new Error('Published validation differs from candidate');
        return { reportDigest: digest, replayed: true };
      }
      if (reservation?.status !== 'reserved')
        throw new Error('Validation candidate reservation is unavailable');
      if (previous) {
        this.assertCandidate(previous, operation, binding, digest);
        if ((await sha256(canonicalJson(previous.report))) !== digest)
          throw new Error('Validation candidate content changed');
        return { reportDigest: digest, replayed: true };
      }
      const now = this.clock();
      tx.set(this.candidatePath(operationId), {
        schemaVersion: '1.0',
        operationId,
        ownerUid: operation.ownerUid,
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        inputDigest: operation.inputDigest,
        sourceOperationId: observations(binding.request).sourceOperationId,
        payloadDigest: binding.payloadDigest,
        report: result,
        reportDigest: digest,
        retentionClass: 'report',
        retentionVersion: RETENTION.version,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + RETENTION.reportDays * 86400000),
      });
      return { reportDigest: digest, replayed: false };
    });
  }
  private assertCandidate(
    candidate: Record<string, unknown>,
    operation: Operation,
    binding: z.infer<typeof Binding>,
    digest: string,
  ) {
    if (
      candidate.operationId !== operation.id ||
      candidate.ownerUid !== operation.ownerUid ||
      candidate.auditId !== operation.auditId ||
      candidate.revisionId !== operation.revisionId ||
      candidate.inputDigest !== operation.inputDigest ||
      candidate.sourceOperationId !==
        observations(binding.request).sourceOperationId ||
      candidate.payloadDigest !== binding.payloadDigest ||
      candidate.reportDigest !== digest ||
      Date.parse(Timestamp.parse(candidate.expiresAt)) <= this.clock().getTime()
    )
      throw new Error(
        'Validation candidate is stale or conflicts with this operation',
      );
  }
  async publish(operationId: string, value?: unknown) {
    Id.parse(operationId);
    return this.store.transaction(async (tx) => {
      const binding = Binding.parse(
        await tx.get(this.bindingPath(operationId)),
      );
      if (binding.operationId !== operationId)
        throw new Error('Validation binding key mismatch');
      const snapshot = await this.inspect(tx, binding.request, true);
      const operation = snapshot.evaluation;
      this.assertBinding(
        binding,
        operation,
        await sha256(canonicalJson(binding.request)),
      );
      const termination = SandboxTermination.parse(
        await tx.get(`sandboxTerminations/${operationId}`),
      );
      const path = this.reportPath(operation);
      const previous = await tx.get(path);
      const candidate = await tx.get(this.candidatePath(operationId));
      const result = this.validateResult(
        value ?? candidate?.report ?? previous?.report,
        binding.request,
      );
      const encoded = canonicalJson(result),
        bytes = new TextEncoder().encode(encoded).length;
      const digest = await sha256(encoded);
      if (candidate) {
        this.assertCandidate(candidate, operation, binding, digest);
        if ((await sha256(canonicalJson(candidate.report))) !== digest)
          throw new Error('Validation candidate content changed');
      }
      const reservation = await tx.get(this.reservationPath(operationId));
      this.assertReservation(reservation, operation, binding);
      const outputKey = `revision_output_bytes_${operation.revisionId}`;
      const output = BudgetCounter.parse(await tx.get(`budgets/${outputKey}`));
      if (
        binding.status === 'bound' ||
        bytes > 32768 ||
        termination.operationId !== operationId ||
        termination.sandboxId !== binding.sandboxId ||
        termination.sandboxId !== operation.providerHandle ||
        termination.ownerUid !== operation.ownerUid ||
        termination.auditId !== operation.auditId ||
        termination.revisionId !== operation.revisionId ||
        termination.inputDigest !== operation.inputDigest ||
        termination.requestDigest !== operation.requestDigest
      )
        throw new Error(
          'Validation publication requires confirmed evaluation termination',
        );
      if (previous) {
        if (
          previous.operationId !== operationId ||
          previous.ownerUid !== operation.ownerUid ||
          previous.auditId !== operation.auditId ||
          previous.revisionId !== operation.revisionId ||
          previous.reportDigest !== digest ||
          reservation?.status !== 'settled' ||
          reservation.measuredUsage !== bytes ||
          binding.status !== 'published'
        )
          throw new Error('Validation report is immutable');
        return { reportDigest: digest, replayed: true };
      }
      if (
        binding.status !== 'claimed' ||
        reservation?.status !== 'reserved' ||
        reservation.amount !== 32768 ||
        reservation.payloadDigest !== binding.payloadDigest ||
        output.reserved < 32768
      )
        throw new Error('Validation report reservation conflict');
      const now = this.clock();
      const reserved = output.reserved - 32768,
        spent = Count.parse(output.spent + bytes);
      tx.set(`budgets/${outputKey}`, {
        ...output,
        reserved,
        spent,
        halted: output.halted || spent + reserved > output.limit,
      });
      tx.set(path, {
        schemaVersion: '1.0',
        operationId,
        ownerUid: operation.ownerUid,
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        sourceOperationId: observations(binding.request).sourceOperationId,
        inputDigest: operation.inputDigest,
        adapterDigest: observations(binding.request).adapterDigest,
        ...('diagnostic' in binding.request
          ? {
              contextDigest: binding.request.diagnostic.contextDigest,
              planDigest: binding.request.planDigest,
            }
          : {}),
        report: result,
        reportDigest: digest,
        retentionClass: 'report',
        retentionVersion: RETENTION.version,
        expiresAt: candidate
          ? new Date(Timestamp.parse(candidate.expiresAt))
          : new Date(now.getTime() + RETENTION.reportDays * 86400000),
        createdAt: candidate
          ? new Date(Timestamp.parse(candidate.createdAt))
          : now,
        updatedAt: now,
      });
      if (candidate) tx.delete(this.candidatePath(operationId));
      tx.set(
        this.bindingPath(operationId),
        nativeTimestamps({
          ...binding,
          status: 'published',
          updatedAt: now.toISOString(),
        }),
      );
      tx.set(
        this.reservationPath(operationId),
        nativeTimestamps({
          ...reservation,
          status: 'settled',
          measuredUsage: bytes,
          reconciliationState: 'confirmed',
          updatedAt: now.toISOString(),
        }),
      );
      return { reportDigest: digest, replayed: false };
    });
  }
}
