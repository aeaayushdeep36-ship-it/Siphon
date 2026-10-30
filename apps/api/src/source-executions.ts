import { z } from 'zod';
import {
  AdapterProposal,
  SourceJobRequest,
  Count,
  Digest,
  Id,
  Timestamp,
  UploadManifest,
  ResourcePolicy,
  DEFAULT_POLICY,
} from '@siphon/contracts';
import { type DocumentStore, type DocumentTransaction } from './firestore.js';
import { BudgetCounter, Operation } from './accounting.js';
import { requireActiveRevision } from './audit-commands.js';
import { canonicalJson, sha256 } from './hashing.js';
import { SandboxRequest } from './e2b-client.js';
import { type SourceExecutionGate } from './source-runner.js';

/** Trusted validator/reviewer records. No AI/user field can produce approval. */
export const ExecutionReadiness = z.strictObject({
  schemaVersion: z.literal('1.0'),
  auditId: Id,
  revisionId: Id,
  inputDigest: Digest,
  contextDigest: Digest,
  sourceManifestDigest: Digest,
  status: z.literal('ready'),
  evidenceIds: z.array(Id).min(1).max(20),
});
export const SourceExecutionApproval = z.strictObject({
  schemaVersion: z.literal('1.0'),
  id: Id,
  ownerUid: z.string(),
  payloadDigest: Digest,
  readinessDigest: Digest,
  adapter: AdapterProposal,
  executionProfile: z.literal('runpy_main_root_v1'),
  extractionProfile: z
    .enum(['adapter_v1', 'reference_v1'])
    .default('adapter_v1'),
  purpose: z.literal('baseline_observation'),
  verifiedAt: Timestamp,
  expiresAt: Timestamp,
});
export const SourceExecutionBinding = z.strictObject({
  schemaVersion: z.literal('1.0'),
  operationId: Id,
  ownerUid: z.string(),
  auditId: Id,
  revisionId: Id,
  inputDigest: Digest,
  generation: Count,
  approvalId: Id,
  extractionProfile: z
    .enum(['adapter_v1', 'reference_v1'])
    .default('adapter_v1'),
  payloadDigest: Digest,
  sandboxRequestDigest: Digest,
  reservedBytes: Count,
  status: z.enum(['bound', 'claimed']),
  sandboxId: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
const Binding = SourceExecutionBinding;

/** Baseline execution only. Experiment controls and their authorization are a
 * distinct future profile. Reservations are never released on ambiguous I/O.
 */
export class SourceExecutions implements SourceExecutionGate {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async validate(
    tx: DocumentTransaction,
    operation: Operation,
    approvalId: string,
    payloadDigest: string,
  ) {
    const state = await requireActiveRevision(tx, operation.ownerUid, {
      auditId: operation.auditId,
      revisionId: operation.revisionId,
      generation: operation.fence,
      inputDigest: operation.inputDigest,
    });
    if (state.stage !== 'adapting')
      throw new Error('Baseline source execution requires the adapter stage');
    const path = `audits/${operation.auditId}/revisions/${operation.revisionId}`;
    const revision = await tx.get(path);
    const audit = await tx.get(`audits/${operation.auditId}`);
    const manifest = UploadManifest.parse(revision?.sourceManifest);
    const policy = ResourcePolicy.parse(revision?.policy);
    const approval = SourceExecutionApproval.parse(
      await tx.get(`sourceExecutionApprovals/${approvalId}`),
    );
    const readiness = ExecutionReadiness.parse(
      (await tx.get(`${path}/readiness/current`))?.assessment,
    );
    const adapter = approval.adapter;
    const now = this.clock().getTime();
    if (
      approval.id !== approvalId ||
      approval.ownerUid !== operation.ownerUid ||
      approval.payloadDigest !== payloadDigest ||
      Date.parse(approval.verifiedAt) > now ||
      Date.parse(approval.expiresAt) <= now ||
      approval.readinessDigest !== (await sha256(canonicalJson(readiness))) ||
      readiness.auditId !== operation.auditId ||
      readiness.revisionId !== operation.revisionId ||
      readiness.inputDigest !== operation.inputDigest ||
      readiness.contextDigest !== adapter.contextDigest ||
      readiness.sourceManifestDigest !==
        (await sha256(canonicalJson(manifest))) ||
      adapter.auditId !== operation.auditId ||
      adapter.revisionId !== operation.revisionId ||
      adapter.inputDigest !== operation.inputDigest ||
      adapter.domain !== audit?.domain
    )
      throw new Error('Source execution approval or readiness is stale');
    for (const file of manifest) {
      const artifact = await tx.get(
        `audits/${operation.auditId}/artifacts/${file.artifactId}`,
      );
      if (
        !artifact ||
        artifact.ownerUid !== operation.ownerUid ||
        artifact.auditId !== operation.auditId ||
        artifact.artifactId !== file.artifactId ||
        artifact.lifecycle !== 'ready' ||
        artifact.path !== file.path ||
        artifact.bytes !== file.bytes ||
        artifact.sha256 !== file.sha256 ||
        Date.parse(Timestamp.parse(artifact.expiresAt)) <= now
      )
        throw new Error('Source input artifact is no longer available');
    }
    return { approval, adapter, manifest, policy };
  }

  async bind(value: unknown, approvalId: string) {
    const request = SourceJobRequest.parse(value);
    Id.parse(approvalId);
    const payloadDigest = await sha256(JSON.stringify(request));
    // Check actual bytes before reserving capacity or permitting sandbox creation.
    for (const file of request.files) {
      const bytes = Uint8Array.from(atob(file.dataBase64), (c) =>
        c.charCodeAt(0),
      );
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (n) => n.toString(16).padStart(2, '0'),
      ).join('');
      if (hash !== file.sha256) throw new Error('Source input hash mismatch');
    }
    return this.store.transaction(async (tx) => {
      const operation = Operation.parse(
        await tx.get(`operations/${request.operationId}`),
      );
      const checked = await this.validate(
        tx,
        operation,
        approvalId,
        payloadDigest,
      );
      const previous = await tx.get(`sourceExecutions/${operation.id}`);
      const reserved = await tx.get(
        `reservations/source_output_${operation.id}`,
      );
      const files = request.files.map((file) => ({
        schemaVersion: file.schemaVersion,
        artifactId: file.artifactId,
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
      }));
      if (
        request.inputDigest !== operation.inputDigest ||
        request.adapterDigest !==
          (await sha256(canonicalJson(checked.adapter))) ||
        request.entryArtifactId !== checked.adapter.sourceArtifactId ||
        !files.some(
          (file) =>
            file.artifactId === checked.adapter.sourceArtifactId &&
            file.sha256 === checked.adapter.sourceDigest,
        ) ||
        canonicalJson(files) !== canonicalJson(checked.manifest) ||
        canonicalJson(request.mappings) !==
          canonicalJson(checked.adapter.mappings) ||
        request.maximumOutputBytes + 32768 > checked.policy.outputBytes
      )
        throw new Error(
          'Source payload does not match the approved adapter snapshot',
        );
      if (previous) {
        const old = Binding.parse(previous);
        if (
          old.payloadDigest !== payloadDigest ||
          old.approvalId !== approvalId ||
          old.extractionProfile !== checked.approval.extractionProfile ||
          old.ownerUid !== operation.ownerUid ||
          old.operationId !== operation.id ||
          old.auditId !== operation.auditId ||
          old.revisionId !== operation.revisionId ||
          old.inputDigest !== operation.inputDigest ||
          old.generation !== operation.fence ||
          old.sandboxRequestDigest !== operation.requestDigest ||
          !reserved ||
          reserved.status !== 'reserved' ||
          reserved.amount !== old.reservedBytes ||
          reserved.operationId !== operation.id ||
          reserved.ownerUid !== operation.ownerUid ||
          reserved.auditId !== operation.auditId ||
          reserved.revisionId !== operation.revisionId ||
          reserved.payloadDigest !== payloadDigest ||
          reserved.outputCounterKey !==
            `revision_output_bytes_${operation.revisionId}`
        )
          throw new Error('Source binding or reservation conflict');
        return old;
      }
      if (operation.outcome !== 'reserved' || reserved)
        throw new Error('Source binding must precede dispatch');
      const amount = request.maximumOutputBytes + 32768;
      const outputKey = `revision_output_bytes_${operation.revisionId}`;
      const storage = BudgetCounter.parse(
        await tx.get('budgets/r2_storage_bytes'),
      );
      const output = BudgetCounter.parse(await tx.get(`budgets/${outputKey}`));
      for (const [counter, cap] of [
        [
          storage,
          Math.min(checked.policy.storageBytes, DEFAULT_POLICY.storageBytes),
        ],
        [
          output,
          Math.min(checked.policy.outputBytes, DEFAULT_POLICY.outputBytes),
        ],
      ] as const) {
        if (
          counter.halted ||
          BigInt(counter.spent) + BigInt(counter.reserved) + BigInt(amount) >
            BigInt(Math.min(counter.limit, cap))
        )
          throw new Error('Source output or storage budget exhausted');
      }
      const now = this.clock();
      const binding = Binding.parse({
        schemaVersion: '1.0',
        operationId: operation.id,
        ownerUid: operation.ownerUid,
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        inputDigest: operation.inputDigest,
        generation: operation.fence,
        approvalId,
        extractionProfile: checked.approval.extractionProfile,
        payloadDigest,
        sandboxRequestDigest: operation.requestDigest,
        reservedBytes: amount,
        status: 'bound',
        sandboxId: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      tx.set('budgets/r2_storage_bytes', {
        ...storage,
        reserved: storage.reserved + amount,
      });
      tx.set(`budgets/${outputKey}`, {
        ...output,
        reserved: output.reserved + amount,
      });
      tx.set(`sourceExecutions/${operation.id}`, {
        ...binding,
        createdAt: now,
        updatedAt: now,
      });
      tx.set(`reservations/source_output_${operation.id}`, {
        schemaVersion: '1.0',
        operationId: operation.id,
        ownerUid: operation.ownerUid,
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        resource: 'source_output_bytes',
        amount,
        outputCounterKey: outputKey,
        status: 'reserved',
        payloadDigest,
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
    profile: 'adapter_v1' | 'reference_v1' = 'adapter_v1',
  ): Promise<void> {
    const request = SourceJobRequest.parse(value);
    if (payloadDigest !== (await sha256(JSON.stringify(request))))
      throw new Error('Source claim payload mismatch');
    await this.store.transaction(async (tx) => {
      const operation = Operation.parse(
        await tx.get(`operations/${request.operationId}`),
      );
      const binding = Binding.parse(
        await tx.get(`sourceExecutions/${operation.id}`),
      );
      const checked = await this.validate(
        tx,
        operation,
        binding.approvalId,
        payloadDigest,
      );
      const job = await tx.get(`sandboxJobs/${operation.id}`);
      const sandbox = SandboxRequest.parse(job?.request);
      const handle = await tx.get(`sandboxHandles/${sandboxId}`);
      const ended = await tx.get(`sandboxTerminations/${operation.id}`);
      const reservation = await tx.get(
        `reservations/source_output_${operation.id}`,
      );
      if (
        operation.outcome !== 'dispatching' ||
        binding.status !== 'bound' ||
        binding.extractionProfile !== profile ||
        checked.approval.extractionProfile !== profile ||
        binding.payloadDigest !== payloadDigest ||
        binding.operationId !== operation.id ||
        binding.ownerUid !== operation.ownerUid ||
        binding.auditId !== operation.auditId ||
        binding.revisionId !== operation.revisionId ||
        binding.inputDigest !== operation.inputDigest ||
        binding.generation !== operation.fence ||
        binding.sandboxRequestDigest !== operation.requestDigest ||
        request.inputDigest !== operation.inputDigest ||
        sandbox.role !== 'source' ||
        sandbox.operationId !== operation.id ||
        sandbox.auditId !== operation.auditId ||
        sandbox.revisionId !== operation.revisionId ||
        sandbox.inputDigest !== operation.inputDigest ||
        job?.requestDigest !== operation.requestDigest ||
        (await sha256(canonicalJson(sandbox))) !== operation.requestDigest ||
        operation.providerHandle !== sandboxId ||
        handle?.operationId !== operation.id ||
        handle.ownerUid !== operation.ownerUid ||
        handle.auditId !== operation.auditId ||
        handle.revisionId !== operation.revisionId ||
        ended ||
        !reservation ||
        reservation.status !== 'reserved' ||
        reservation.amount !== binding.reservedBytes ||
        reservation.payloadDigest !== payloadDigest ||
        reservation.operationId !== operation.id ||
        reservation.ownerUid !== operation.ownerUid ||
        reservation.auditId !== operation.auditId ||
        reservation.revisionId !== operation.revisionId ||
        reservation.outputCounterKey !==
          `revision_output_bytes_${operation.revisionId}`
      )
        throw new Error(
          'Source execution is not authorized or was already claimed',
        );
      tx.set(`sourceExecutions/${operation.id}`, {
        ...binding,
        status: 'claimed',
        sandboxId,
        createdAt: new Date(binding.createdAt),
        updatedAt: this.clock(),
      });
    });
  }

  async authorizeCollection(operationId: string): Promise<void> {
    Id.parse(operationId);
    await this.store.transaction(async (tx) => {
      const operation = Operation.parse(
        await tx.get(`operations/${operationId}`),
      );
      const binding = Binding.parse(
        await tx.get(`sourceExecutions/${operationId}`),
      );
      await this.validate(
        tx,
        operation,
        binding.approvalId,
        binding.payloadDigest,
      );
      const reservation = await tx.get(
        `reservations/source_output_${operationId}`,
      );
      if (
        binding.status !== 'claimed' ||
        !['dispatching', 'unknown'].includes(operation.outcome) ||
        binding.operationId !== operationId ||
        binding.ownerUid !== operation.ownerUid ||
        binding.auditId !== operation.auditId ||
        binding.revisionId !== operation.revisionId ||
        binding.inputDigest !== operation.inputDigest ||
        binding.generation !== operation.fence ||
        binding.sandboxRequestDigest !== operation.requestDigest ||
        binding.sandboxId !== operation.providerHandle ||
        !reservation ||
        reservation.status !== 'reserved' ||
        reservation.amount !== binding.reservedBytes ||
        reservation.payloadDigest !== binding.payloadDigest ||
        reservation.operationId !== operation.id ||
        reservation.ownerUid !== operation.ownerUid ||
        reservation.auditId !== operation.auditId ||
        reservation.revisionId !== operation.revisionId ||
        reservation.outputCounterKey !==
          `revision_output_bytes_${operation.revisionId}`
      )
        throw new Error('Source collection is not authorized');
    });
  }
}
