import {
  ConservationJobRequest,
  Id,
  ResourcePolicy,
  Timestamp,
  validateConservationJobResult,
} from '@siphon/contracts';
import type { AiConfiguration } from './ai-config.js';
import { DispatchFence, requireActiveRevision } from './audit-commands.js';
import { Operation } from './accounting.js';
import type { DocumentStore, DocumentTransaction } from './firestore.js';
import { canonicalJson, sha256 } from './hashing.js';
import { prepareInvestigationRequest } from './investigation-request.js';
import { SandboxTermination } from './sandbox-termination.js';

/** Read and validate the owned published evidence before preparing data for AI.
 * This does not authorize disclosure, reserve quota, dispatch, or publish.
 */
export async function prepareOwnedInvestigation(
  store: DocumentStore,
  uid: string,
  expected: unknown,
  evaluationIdValue: unknown,
  config: AiConfiguration,
  clock: () => Date = () => new Date(),
) {
  return store.transaction((tx) =>
    prepareOwnedInvestigationInTransaction(
      tx,
      uid,
      expected,
      evaluationIdValue,
      config,
      clock,
    ),
  );
}

/** Use inside the same transaction as a later bind or dispatch check. */
export async function prepareOwnedInvestigationInTransaction(
  tx: DocumentTransaction,
  uid: string,
  expected: unknown,
  evaluationIdValue: unknown,
  config: AiConfiguration,
  clock: () => Date = () => new Date(),
) {
  const fence = DispatchFence.parse(expected);
  const evaluationId = Id.parse(evaluationIdValue);
  const base = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
  const state = await requireActiveRevision(tx, uid, fence);
  if (state.stage !== 'investigating')
    throw new Error('Investigation requires the investigation stage');
  const [
    revision,
    evidence,
    rawOperation,
    rawTermination,
    binding,
    requestStage,
  ] = await tx.getMany([
    base,
    `${base}/evidence/${evaluationId}`,
    `operations/${evaluationId}`,
    `sandboxTerminations/${evaluationId}`,
    `conservationExecutions/${evaluationId}`,
    `scientificEvaluationStages/${fence.revisionId}`,
  ]);
  const operation = Operation.parse(rawOperation);
  const termination = SandboxTermination.parse(rawTermination);
  const request = ConservationJobRequest.parse(requestStage?.request);
  const result = validateConservationJobResult(evidence?.report, request);
  const requestDigest = await sha256(canonicalJson(request));
  const evidenceDigest = await sha256(canonicalJson(result));
  if (
    operation.id !== evaluationId ||
    operation.ownerUid !== uid ||
    operation.auditId !== fence.auditId ||
    operation.revisionId !== fence.revisionId ||
    operation.inputDigest !== fence.inputDigest ||
    operation.fence > fence.generation ||
    !['dispatching', 'unknown', 'succeeded'].includes(operation.outcome) ||
    termination.operationId !== evaluationId ||
    termination.ownerUid !== uid ||
    termination.auditId !== fence.auditId ||
    termination.revisionId !== fence.revisionId ||
    termination.inputDigest !== fence.inputDigest ||
    termination.requestDigest !== operation.requestDigest ||
    termination.sandboxId !== operation.providerHandle ||
    requestStage?.ownerUid !== uid ||
    requestStage.auditId !== fence.auditId ||
    requestStage.revisionId !== fence.revisionId ||
    requestStage.inputDigest !== fence.inputDigest ||
    requestStage.generation !== operation.fence ||
    requestStage.requestDigest !== requestDigest ||
    request.diagnostic.operationId !== evaluationId ||
    binding?.ownerUid !== uid ||
    binding.operationId !== evaluationId ||
    binding.status !== 'published' ||
    binding.payloadDigest !== requestDigest ||
    canonicalJson(binding.request) !== canonicalJson(request) ||
    binding.sandboxId !== termination.sandboxId ||
    evidence?.ownerUid !== uid ||
    evidence.auditId !== fence.auditId ||
    evidence.revisionId !== fence.revisionId ||
    evidence.inputDigest !== fence.inputDigest ||
    evidence.operationId !== evaluationId ||
    evidence.reportDigest !== evidenceDigest ||
    Date.parse(Timestamp.parse(evidence.expiresAt)) <=
      clock().getTime() + config.requestTimeoutMs
  )
    throw new Error('Investigation evidence provenance is unavailable');
  const prepared = await prepareInvestigationRequest(
    result,
    request,
    ResourcePolicy.parse(revision?.policy),
    config,
  );
  if (
    prepared.expected.auditId !== fence.auditId ||
    prepared.expected.revisionId !== fence.revisionId ||
    prepared.expected.inputDigest !== fence.inputDigest ||
    prepared.expected.evidenceDigest !== evidenceDigest
  )
    throw new Error('Investigation snapshot mismatch');
  return {
    ...prepared,
    evaluationId,
    evidenceExpiresAt: Timestamp.parse(evidence?.expiresAt),
  };
}
