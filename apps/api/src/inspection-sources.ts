import {
  InspectionJobRequest,
  ResourcePolicy,
  UploadManifest,
  preflightUploads,
  Id,
} from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import { requireActiveRevision, DispatchFence } from './audit-commands.js';
import { Operation } from './accounting.js';
import { type ArtifactDownloadService } from './artifact-download.js';
import { verifyUploadBytes } from './upload-bytes.js';

/** Private source loader. All reads use the accounted private artifact service. */
export class InspectionSourceLoader {
  constructor(
    private readonly store: DocumentStore,
    private readonly downloads: Pick<ArtifactDownloadService, 'readBatch'>,
  ) {}

  async load(
    uid: string,
    operationId: string,
    expected: unknown,
    signal?: AbortSignal,
  ) {
    Id.parse(operationId);
    const fence = DispatchFence.parse(expected);
    const deadline = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
      : AbortSignal.timeout(60000);
    deadline.throwIfAborted();
    const { manifest, policy } = await this.store.transaction(async (tx) => {
      await tx.getMany([
        `testers/${uid}`,
        `audits/${fence.auditId}`,
        `audits/${fence.auditId}/revisions/${fence.revisionId}`,
        `operations/${operationId}`,
      ]);
      const state = await requireActiveRevision(tx, uid, fence);
      const operation = Operation.parse(
        await tx.get(`operations/${operationId}`),
      );
      const record = await tx.get(
        `audits/${fence.auditId}/revisions/${fence.revisionId}`,
      );
      const policy = ResourcePolicy.parse(record?.policy);
      const manifest = UploadManifest.parse(record?.sourceManifest);
      if (
        operation.id !== operationId ||
        operation.ownerUid !== uid ||
        operation.auditId !== fence.auditId ||
        operation.revisionId !== fence.revisionId ||
        operation.inputDigest !== fence.inputDigest ||
        operation.fence !== fence.generation ||
        !['reserved', 'dispatching'].includes(operation.outcome) ||
        state.stage !== 'inspecting' ||
        preflightUploads(manifest, policy).status !== 'ready'
      )
        throw new Error('Inspection source snapshot is not authorized');
      return {
        manifest: manifest.filter((file) => file.path.endsWith('.py')),
        policy,
      };
    });
    const files = await this.downloads.readBatch(
      uid,
      fence,
      manifest.map((file) => file.artifactId),
      policy.sourceBytes,
      deadline,
    );
    const retrieved = new Map(files.map((file) => [file.artifactId, file]));
    if (
      retrieved.size !== manifest.length ||
      files.length !== manifest.length ||
      files.some(
        (file) =>
          !manifest.some((entry) => entry.artifactId === file.artifactId),
      )
    )
      throw new Error('Inspection batch source identities changed');
    const sources = [];
    for (const file of manifest) {
      deadline.throwIfAborted();
      const loaded = retrieved.get(file.artifactId)!;
      if (loaded.sha256 !== file.sha256)
        throw new Error('Inspection source digest changed');
      const verified = await verifyUploadBytes(
        new Response(loaded.bytes).body,
        file.bytes,
        file.sha256,
        policy.sourceBytes,
        deadline,
      );
      let binary = '';
      for (const byte of verified.bytes) binary += String.fromCharCode(byte);
      sources.push({
        artifactId: file.artifactId,
        sourceDigest: verified.sha256,
        sourceBase64: btoa(binary),
      });
    }
    // Recheck after remote reads. Cancellation cannot promote the loaded bytes into execution.
    await this.store.transaction((tx) => requireActiveRevision(tx, uid, fence));
    deadline.throwIfAborted();
    return InspectionJobRequest.parse({
      schemaVersion: '1.0',
      operationId,
      inputDigest: fence.inputDigest,
      maximumSourceBytes: policy.sourceBytes,
      sources,
    });
  }
}
