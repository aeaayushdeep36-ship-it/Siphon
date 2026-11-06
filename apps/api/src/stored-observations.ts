import {
  Id,
  ObservationValidationRequest,
  ResourcePolicy,
  SourceJobResult,
  Timestamp,
} from '@siphon/contracts';
import { type DocumentStore, type DocumentTransaction } from './firestore.js';
import { type ArtifactDownloadService } from './artifact-download.js';
import { requireActiveRevision, DispatchFence } from './audit-commands.js';
import { Operation } from './accounting.js';
import {
  SourceExecutionBinding,
  SourceExecutionApproval,
} from './source-executions.js';
import { SourceOutputPlan } from './source-output-store.js';
import { SandboxTermination } from './sandbox-termination.js';
import { verifyUploadBytes } from './upload-bytes.js';
import { sha256, canonicalJson } from './hashing.js';

/** Loads only numeric artifacts/metadata; never forwards uploaded source to a trusted VM. */
export class StoredObservationLoader {
  constructor(
    private readonly store: DocumentStore,
    private readonly downloads: Pick<ArtifactDownloadService, 'get'>,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async load(
    uid: string,
    sourceOperationId: string,
    evaluationOperationId: string,
    expected: unknown,
    signal?: AbortSignal,
  ) {
    Id.parse(sourceOperationId);
    Id.parse(evaluationOperationId);
    if (sourceOperationId === evaluationOperationId)
      throw new Error('Separate evaluation operation required');
    const fence = DispatchFence.parse(expected);
    const deadline = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(180000)])
      : AbortSignal.timeout(180000);
    deadline.throwIfAborted();
    const snapshot = await this.store.transaction((tx) =>
      inspectStoredObservationSnapshot(
        tx,
        uid,
        sourceOperationId,
        evaluationOperationId,
        fence,
        false,
        this.now(),
      ),
    );
    if (snapshot.plan.totalBytes > snapshot.policy.outputBytes)
      throw new Error('Stored observation byte policy exceeded');
    const files = new Map<string, Uint8Array<ArrayBuffer>>();
    for (const entry of snapshot.plan.entries) {
      deadline.throwIfAborted();
      await this.store.transaction((tx) =>
        requireActiveRevision(tx, uid, fence),
      );
      const response = await this.downloads.get(
        uid,
        fence.auditId,
        entry.id,
        new Request('https://siphon.invalid/internal/numeric-artifact', {
          signal: deadline,
        }),
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Stored observation read failed');
      }
      const loaded = await verifyUploadBytes(
        response.body,
        entry.bytes,
        entry.sha256,
        snapshot.policy.outputBytes,
        deadline,
      );
      files.set(entry.name, loaded.bytes);
    }
    const manifestBytes = files.get('manifest.json');
    if (!manifestBytes || manifestBytes.length > 32768)
      throw new Error('Stored observation manifest is missing');
    const manifest = SourceJobResult.parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
          manifestBytes,
        ),
      ),
    );
    if (
      (await sha256(canonicalJson(manifest))) !== snapshot.plan.outputDigest ||
      snapshot.plan.entries.length !== manifest.observations.length + 1
    )
      throw new Error('Stored observation manifest changed');
    for (const observation of manifest.observations) {
      const entry = snapshot.plan.entries.find(
        (item) => item.name === observation.filename,
      );
      if (
        !entry ||
        entry.bytes !== observation.bytes ||
        entry.sha256 !== observation.sha256
      )
        throw new Error('Stored observation descriptor changed');
    }
    const request = ObservationValidationRequest.parse({
      schemaVersion: '1.0',
      evaluationOperationId,
      sourceOperationId,
      inputDigest: fence.inputDigest,
      adapterDigest: await sha256(canonicalJson(snapshot.adapter)),
      manifest,
      mappings: snapshot.adapter.mappings,
      maximumBytes: snapshot.policy.outputBytes,
      maximumElements: Math.floor(snapshot.policy.outputBytes / 8),
    });
    await this.store.transaction((tx) => requireActiveRevision(tx, uid, fence));
    deadline.throwIfAborted();
    return {
      request,
      payloads: manifest.observations.map((item) => ({
        filename: item.filename,
        bytes: files.get(item.filename)!,
      })),
    };
  }
}

/** Shared transactional provenance validation; caller supplies a current fence.
 * Completed evaluation outcomes are accepted only for internal report finalization.
 */
export async function inspectStoredObservationSnapshot(
  tx: DocumentTransaction,
  uid: string,
  sourceOperationId: string,
  evaluationOperationId: string,
  expected: unknown,
  allowCompletedEvaluation = false,
  now = new Date(),
) {
  Id.parse(sourceOperationId);
  Id.parse(evaluationOperationId);
  if (sourceOperationId === evaluationOperationId)
    throw new Error('Separate evaluation operation required');
  const fence = DispatchFence.parse(expected);
  await requireActiveRevision(tx, uid, fence);
  const source = Operation.parse(
    await tx.get(`operations/${sourceOperationId}`),
  );
  const evaluation = Operation.parse(
    await tx.get(`operations/${evaluationOperationId}`),
  );
  if (
    source.id !== sourceOperationId ||
    evaluation.id !== evaluationOperationId
  )
    throw new Error('Stored observation operation key mismatch');
  const binding = SourceExecutionBinding.parse(
    await tx.get(`sourceExecutions/${sourceOperationId}`),
  );
  const approval = SourceExecutionApproval.parse(
    await tx.get(`sourceExecutionApprovals/${binding.approvalId}`),
  );
  const plan = SourceOutputPlan.parse(
    await tx.get(`sourceOutputPlans/${sourceOperationId}`),
  );
  const termination = SandboxTermination.parse(
    await tx.get(`sandboxTerminations/${sourceOperationId}`),
  );
  const revision = await tx.get(
    `audits/${fence.auditId}/revisions/${fence.revisionId}`,
  );
  const policy = ResourcePolicy.parse(revision?.policy);
  for (const op of [source, evaluation])
    if (
      op.ownerUid !== uid ||
      op.auditId !== fence.auditId ||
      op.revisionId !== fence.revisionId ||
      op.inputDigest !== fence.inputDigest
    )
      throw new Error('Evaluation artifact identity mismatch');
  if (
    evaluation.fence !== fence.generation ||
    !(
      allowCompletedEvaluation
        ? ['reserved', 'dispatching', 'unknown', 'succeeded', 'failed']
        : ['reserved', 'dispatching']
    ).includes(evaluation.outcome) ||
    source.outcome === 'reserved' ||
    binding.operationId !== sourceOperationId ||
    binding.ownerUid !== uid ||
    binding.auditId !== fence.auditId ||
    binding.revisionId !== fence.revisionId ||
    binding.inputDigest !== fence.inputDigest ||
    binding.generation !== source.fence ||
    binding.status !== 'claimed' ||
    binding.sandboxRequestDigest !== source.requestDigest ||
    approval.id !== binding.approvalId ||
    approval.ownerUid !== uid ||
    approval.payloadDigest !== binding.payloadDigest ||
    approval.extractionProfile !== binding.extractionProfile ||
    approval.adapter.auditId !== fence.auditId ||
    approval.adapter.revisionId !== fence.revisionId ||
    approval.adapter.inputDigest !== fence.inputDigest ||
    plan.operationId !== sourceOperationId ||
    plan.ownerUid !== uid ||
    plan.auditId !== fence.auditId ||
    plan.revisionId !== fence.revisionId ||
    plan.status !== 'stored' ||
    plan.payloadDigest !== binding.payloadDigest ||
    termination.operationId !== sourceOperationId ||
    termination.sandboxId !== source.providerHandle ||
    termination.sandboxId !== binding.sandboxId ||
    termination.ownerUid !== uid ||
    termination.auditId !== fence.auditId ||
    termination.revisionId !== fence.revisionId ||
    termination.inputDigest !== fence.inputDigest ||
    termination.requestDigest !== source.requestDigest
  )
    throw new Error(
      'Stored observations lack matching execution/termination provenance',
    );
  for (const entry of plan.entries) {
    const artifact = await tx.get(
      `audits/${fence.auditId}/artifacts/${entry.id}`,
    );
    if (
      !artifact ||
      artifact.ownerUid !== uid ||
      artifact.auditId !== fence.auditId ||
      artifact.revisionId !== fence.revisionId ||
      artifact.sourceOperationId !== sourceOperationId ||
      artifact.lifecycle !== 'ready' ||
      artifact.kind !== 'source_output_unvalidated' ||
      artifact.path !== entry.name ||
      artifact.bytes !== entry.bytes ||
      artifact.sha256 !== entry.sha256 ||
      Date.parse(Timestamp.parse(artifact.expiresAt)) <= now.getTime()
    )
      throw new Error('Stored observation artifact does not match its plan');
  }
  return { plan, adapter: approval.adapter, policy, source, evaluation };
}
