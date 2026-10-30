import {
  InspectionJobRequest,
  ResourcePolicy,
  UploadManifest,
  Id,
  Timestamp,
  validateInspectionJobResult,
} from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import { Operation } from './accounting.js';
import { requireActiveRevision } from './audit-commands.js';
import { canonicalJson, sha256 } from './hashing.js';
import { SandboxRequest } from './e2b-client.js';
import { type InspectionExecutionGate } from './inspection-runner.js';
import { evaluateInspectionGate } from './inspection-gate.js';

/** Single-use claim for a fresh inspection-role job; never a public client endpoint. */
export class InspectionJobs implements InspectionExecutionGate {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async publish(
    requestValue: unknown,
    resultValue: unknown,
  ): Promise<{ resultDigest: string; replayed: boolean }> {
    const request = InspectionJobRequest.parse(requestValue);
    const result = validateInspectionJobResult(resultValue, request);
    const payloadDigest = await sha256(JSON.stringify(request));
    const resultDigest = await sha256(canonicalJson(result));
    return this.store.transaction(async (tx) => {
      const operation = Operation.parse(
        await tx.get(`operations/${request.operationId}`),
      );
      const path = `audits/${operation.auditId}/revisions/${operation.revisionId}`;
      const [claim, revision, prior] = await tx.getMany([
        `inspectionExecutions/${operation.id}`,
        path,
        `${path}/inspection/current`,
        `testers/${operation.ownerUid}`,
        `audits/${operation.auditId}`,
      ]);
      const state = await requireActiveRevision(tx, operation.ownerUid, {
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        generation: operation.fence,
        inputDigest: operation.inputDigest,
      });
      if (
        !claim ||
        claim.payloadDigest !== payloadDigest ||
        claim.operationId !== operation.id ||
        claim.generation !== operation.fence ||
        claim.ownerUid !== operation.ownerUid ||
        claim.auditId !== operation.auditId ||
        claim.revisionId !== operation.revisionId ||
        claim.inputDigest !== operation.inputDigest ||
        request.inputDigest !== operation.inputDigest ||
        claim.sandboxId !== operation.providerHandle ||
        state.stage !== 'inspecting' ||
        !['claimed', 'published'].includes(String(claim.status))
      )
        throw new Error('Inspection publication claim mismatch');
      if (prior) {
        if (
          prior.operationId !== operation.id ||
          prior.resultDigest !== resultDigest
        )
          throw new Error('Inspection evidence is immutable');
        return { resultDigest, replayed: true };
      }
      if (claim.status !== 'claimed')
        throw new Error('Published inspection record is missing');
      const policy = ResourcePolicy.parse(revision?.policy);
      const manifest = UploadManifest.parse(revision?.sourceManifest);
      const gate = evaluateInspectionGate(
        manifest,
        result.sources.map((source) => ({
          artifactId: source.artifactId,
          result: source.inspection,
        })),
        policy,
      );
      const now = this.clock();
      // Per-source documents avoid a large aggregated AST record in Firestore.
      for (const source of result.sources)
        tx.set(`${path}/inspectionSources/${source.artifactId}`, {
          schemaVersion: '1.0',
          ownerUid: operation.ownerUid,
          operationId: operation.id,
          inputDigest: operation.inputDigest,
          artifactId: source.artifactId,
          inspection: source.inspection,
          createdAt: now,
          updatedAt: now,
        });
      tx.set(`${path}/inspection/current`, {
        schemaVersion: '1.0',
        ownerUid: operation.ownerUid,
        operationId: operation.id,
        inputDigest: operation.inputDigest,
        resultDigest,
        sourceArtifactIds: result.sources.map((source) => source.artifactId),
        gate,
        createdAt: now,
        updatedAt: now,
      });
      tx.set(`inspectionExecutions/${operation.id}`, {
        ...claim,
        status: 'published',
        resultDigest,
        createdAt: new Date(Timestamp.parse(claim.createdAt)),
        updatedAt: now,
      });
      return { resultDigest, replayed: false };
    });
  }
  async claim(
    value: unknown,
    payloadDigest: string,
    sandboxId: string,
  ): Promise<void> {
    const request = InspectionJobRequest.parse(value);
    if (payloadDigest !== (await sha256(JSON.stringify(request))))
      throw new Error('Inspection payload digest mismatch');
    await this.store.transaction(async (tx) => {
      const operation = Operation.parse(
        await tx.get(`operations/${request.operationId}`),
      );
      const [job, handle, prior, termination, revision] = await tx.getMany([
        `sandboxJobs/${operation.id}`,
        `sandboxHandles/${sandboxId}`,
        `inspectionExecutions/${operation.id}`,
        `sandboxTerminations/${operation.id}`,
        `audits/${operation.auditId}/revisions/${operation.revisionId}`,
        `testers/${operation.ownerUid}`,
        `audits/${operation.auditId}`,
      ]);
      const state = await requireActiveRevision(tx, operation.ownerUid, {
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        generation: operation.fence,
        inputDigest: operation.inputDigest,
      });
      const sandboxRequest = SandboxRequest.parse(job?.request);
      const policy = ResourcePolicy.parse(revision?.policy);
      const manifest = UploadManifest.parse(revision?.sourceManifest).filter(
        (file) => file.path.endsWith('.py'),
      );
      if (
        operation.outcome !== 'dispatching' ||
        operation.providerHandle !== sandboxId ||
        sandboxRequest.role !== 'inspection' ||
        sandboxRequest.operationId !== operation.id ||
        sandboxRequest.inputDigest !== request.inputDigest ||
        request.inputDigest !== state.inputDigest ||
        sandboxRequest.auditId !== operation.auditId ||
        sandboxRequest.revisionId !== operation.revisionId ||
        job?.ownerUid !== operation.ownerUid ||
        job.requestDigest !== operation.requestDigest ||
        (await sha256(canonicalJson(sandboxRequest))) !==
          operation.requestDigest ||
        handle?.operationId !== operation.id ||
        handle.ownerUid !== operation.ownerUid ||
        handle.auditId !== operation.auditId ||
        handle.revisionId !== operation.revisionId ||
        prior ||
        termination ||
        state.stage !== 'inspecting' ||
        request.maximumSourceBytes > policy.sourceBytes ||
        manifest.length !== request.sources.length ||
        manifest.some(
          (file) =>
            !request.sources.some(
              (source) =>
                source.artifactId === file.artifactId &&
                source.sourceDigest === file.sha256 &&
                atob(source.sourceBase64).length === file.bytes,
            ),
        )
      )
        throw new Error(
          'Inspection execution is not authorized for this source snapshot',
        );
      const artifacts = await tx.getMany(
        manifest.map(
          (file) => `audits/${operation.auditId}/artifacts/${file.artifactId}`,
        ),
      );
      for (const [index, file] of manifest.entries()) {
        const artifact = artifacts[index];
        if (
          !artifact ||
          artifact.ownerUid !== operation.ownerUid ||
          artifact.auditId !== operation.auditId ||
          artifact.artifactId !== file.artifactId ||
          artifact.lifecycle !== 'ready' ||
          artifact.kind !== 'upload' ||
          artifact.sha256 !== file.sha256 ||
          artifact.bytes !== file.bytes ||
          Date.parse(Timestamp.parse(artifact.expiresAt)) <=
            this.clock().getTime()
        )
          throw new Error(
            'Inspection source artifact is not ready or has expired',
          );
      }
      tx.set(`inspectionExecutions/${operation.id}`, {
        schemaVersion: '1.0',
        operationId: operation.id,
        ownerUid: operation.ownerUid,
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        inputDigest: operation.inputDigest,
        generation: operation.fence,
        sandboxId,
        payloadDigest,
        status: 'claimed',
        createdAt: this.clock(),
        updatedAt: this.clock(),
      });
    });
  }
  async authorizeResult(operationId: string): Promise<void> {
    Id.parse(operationId);
    await this.store.transaction(async (tx) => {
      const [operationValue, claim] = await tx.getMany([
        `operations/${operationId}`,
        `inspectionExecutions/${operationId}`,
      ]);
      const operation = Operation.parse(operationValue);
      await requireActiveRevision(tx, operation.ownerUid, {
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        generation: operation.fence,
        inputDigest: operation.inputDigest,
      });
      if (
        !claim ||
        claim.operationId !== operationId ||
        claim.generation !== operation.fence ||
        claim.inputDigest !== operation.inputDigest ||
        claim.sandboxId !== operation.providerHandle ||
        claim.ownerUid !== operation.ownerUid ||
        claim.auditId !== operation.auditId ||
        claim.revisionId !== operation.revisionId
      )
        throw new Error('Inspection result claim mismatch');
    });
  }
}
