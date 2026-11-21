import { z } from 'zod';
import {
  AdapterProposal,
  Count,
  Id,
  ResourcePolicy,
  SourceJobRequest,
  Timestamp,
  UploadManifest,
} from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import {
  DispatchFence,
  nativeTimestamps,
  requireActiveRevision,
} from './audit-commands.js';
import { type ArtifactDownloadService } from './artifact-download.js';
import { AdmissionRepository } from './admission.js';
import {
  Operation,
  releaseUndispatched,
  reserveOperation,
} from './accounting.js';
import { FirestoreAccountingStore } from './firestore-accounting.js';
import { SandboxRequest } from './e2b-client.js';
import {
  expectedCharges,
  SandboxTemplateEvidence,
  type SandboxJobs,
} from './sandbox-jobs.js';
import { type SourcePipeline } from './source-pipeline.js';
import {
  SourceOutputPlan,
  type SourceOutputStore,
} from './source-output-store.js';
import { SourceReadiness } from './source-readiness.js';
import { canonicalJson, sha256 } from './hashing.js';

const Configuration = z.strictObject({
  templateEvidenceId: Id,
  lifetimeSeconds: Count.refine((n) => n > 0),
  maximumOutputBytes: Count.refine((n) => n > 0),
  maximumElements: Count.refine((n) => n > 0),
});
const ReadinessReasons = z
  .array(
    z.strictObject({
      artifactId: Id,
      code: z.string().min(1).max(100),
      line: z.number().int().positive().nullable(),
    }),
  )
  .min(1)
  .max(2000);

/** Executes one immutable baseline observation in a fresh untrusted VM. Two
 * successful source runs alone do not establish fidelity or physical validity.
 * Only metadata is checkpointed; raw source/output stays in private storage.
 */
export class BaselineSourceStage {
  constructor(
    private readonly documents: DocumentStore,
    private readonly downloads: Pick<ArtifactDownloadService, 'readBatch'>,
    private readonly jobs: Pick<SandboxJobs, 'bind'>,
    private readonly pipeline: Pick<SourcePipeline, 'run'>,
    private readonly outputs: Pick<SourceOutputStore, 'persist'>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async run(
    uid: string,
    expected: unknown,
    kind: 'original' | 'adapted',
    signal = AbortSignal.timeout(240000),
  ) {
    const fence = DispatchFence.parse(expected),
      base = `audits/${fence.auditId}/revisions/${fence.revisionId}`,
      stagePath = `baselineStages/${fence.revisionId}_${kind}`;
    const stage = await this.documents.transaction(async (tx) => {
      const state = await requireActiveRevision(tx, uid, fence);
      const [revision, savedAdapter, existing] = await tx.getMany([
        base,
        `${base}/adapterProposals/current`,
        stagePath,
      ]);
      const adapter = AdapterProposal.parse(savedAdapter?.proposal),
        adapterDigest = await sha256(canonicalJson(adapter)),
        manifest = UploadManifest.parse(revision?.sourceManifest),
        policy = ResourcePolicy.parse(revision?.policy);
      if (
        state.stage !== 'adapting' ||
        savedAdapter?.ownerUid !== uid ||
        savedAdapter.inputDigest !== fence.inputDigest ||
        savedAdapter.status !== 'proposed' ||
        savedAdapter.adapterDigest !== adapterDigest ||
        adapter.auditId !== fence.auditId ||
        adapter.revisionId !== fence.revisionId ||
        adapter.inputDigest !== fence.inputDigest ||
        Date.parse(Timestamp.parse(savedAdapter.expiresAt)) <=
          this.clock().getTime()
      )
        throw new Error(
          'Baseline source requires the current immutable proposal',
        );
      const numericInputs = manifest.filter(
        (file) => file.path.endsWith('.csv') || file.path.endsWith('.npy'),
      );
      if (numericInputs.length) {
        const selected = existing
          ? SandboxRequest.safeParse(existing.request)
          : Configuration.safeParse(
              await tx.get('configuration/source_dispatch'),
            );
        const evidenceId = selected.success
          ? selected.data.templateEvidenceId
          : null;
        const evidence = evidenceId
          ? SandboxTemplateEvidence.safeParse(
              await tx.get(`sandboxTemplates/${evidenceId}`),
            )
          : null;
        if (
          !evidence?.success ||
          evidence.data.id !== evidenceId ||
          evidence.data.role !== 'source' ||
          !evidence.data.templateBuildId ||
          !evidence.data.templateTag ||
          evidence.data.numericInputValidation !== 'headerless-csv-npy-v1'
        )
          return {
            numericReasons: numericInputs.map((file) => ({
              artifactId: file.artifactId,
              code: 'numeric_input_validator_required',
              line: null,
            })),
          };
      }
      if (existing) {
        if (
          existing.ownerUid !== uid ||
          existing.auditId !== fence.auditId ||
          existing.revisionId !== fence.revisionId ||
          existing.inputDigest !== fence.inputDigest ||
          existing.generation !== fence.generation ||
          existing.adapterDigest !== adapterDigest ||
          existing.kind !== kind
        )
          throw new Error('Baseline source stage changed');
        return {
          operationId: Id.parse(existing.operationId),
          adapter,
          adapterDigest,
          manifest,
          policy,
          request: SandboxRequest.parse(existing.request),
          maximumOutputBytes: Count.parse(existing.maximumOutputBytes),
          maximumElements: Count.parse(existing.maximumElements),
          rejection: existing.rejection
            ? ReadinessReasons.parse(existing.rejection)
            : null,
        };
      }
      const config = Configuration.parse(
          await tx.get('configuration/source_dispatch'),
        ),
        evidence = SandboxTemplateEvidence.parse(
          await tx.get(`sandboxTemplates/${config.templateEvidenceId}`),
        );
      if (
        evidence.id !== config.templateEvidenceId ||
        evidence.role !== 'source' ||
        Date.parse(evidence.verifiedAt) > this.clock().getTime() ||
        Date.parse(evidence.expiresAt) <=
          this.clock().getTime() + config.lifetimeSeconds * 1000 ||
        config.lifetimeSeconds > policy.sandboxLifetimeSeconds ||
        config.maximumOutputBytes + 32768 > policy.outputBytes
      )
        throw new Error('Verified source runtime configuration is unavailable');
      const operationId = crypto.randomUUID(),
        request = SandboxRequest.parse({
          operationId,
          auditId: fence.auditId,
          revisionId: fence.revisionId,
          inputDigest: fence.inputDigest,
          role: 'source',
          templateId: evidence.templateId,
          ...(evidence.templateBuildId
            ? { templateBuildId: evidence.templateBuildId }
            : {}),
          ...(evidence.templateTag
            ? { templateTag: evidence.templateTag }
            : {}),
          templateEvidenceId: evidence.id,
          lifetimeSeconds: config.lifetimeSeconds,
        });
      tx.set(stagePath, {
        schemaVersion: '1.0',
        ownerUid: uid,
        ...fence,
        kind,
        adapterDigest,
        operationId,
        request,
        maximumOutputBytes: config.maximumOutputBytes,
        maximumElements: config.maximumElements,
        rejection: null,
        createdAt: this.clock(),
      });
      return {
        operationId,
        adapter,
        adapterDigest,
        manifest,
        policy,
        request,
        maximumOutputBytes: config.maximumOutputBytes,
        maximumElements: config.maximumElements,
      };
    });
    if ('numericReasons' in stage)
      return {
        status: 'needs_input' as const,
        kind,
        operationId: null,
        reasons: stage.numericReasons,
      };
    const priorOutput = await this.documents.get(
      `sourceOutputPlans/${stage.operationId}`,
    );
    if (priorOutput) {
      const output = SourceOutputPlan.parse(priorOutput);
      if (
        output.operationId !== stage.operationId ||
        output.ownerUid !== uid ||
        output.auditId !== fence.auditId ||
        output.revisionId !== fence.revisionId ||
        output.status !== 'stored'
      )
        throw new Error('Baseline output requires reconciliation');
      return {
        status: 'source_stored' as const,
        kind,
        operationId: stage.operationId,
        outputDigest: output.outputDigest,
      };
    }
    const priorOperation = await this.documents.get(
      `operations/${stage.operationId}`,
    );
    if (stage.rejection && priorOperation) {
      const operation = Operation.parse(priorOperation);
      if (
        operation.outcome === 'reserved' ||
        (operation.outcome === 'failed' &&
          operation.providerHandle === null &&
          operation.usage !== null &&
          operation.charges.every(
            (charge) => operation.usage?.[charge.counterKey] === 0,
          ))
      ) {
        await releaseUndispatched(
          new FirestoreAccountingStore(this.documents),
          stage.operationId,
          fence.generation,
          this.clock().toISOString(),
        );
        return {
          status: 'needs_input' as const,
          kind,
          operationId: stage.operationId,
          reasons: stage.rejection,
        };
      }
    }
    if (
      priorOperation &&
      Operation.parse(priorOperation).outcome !== 'reserved'
    )
      return {
        status: 'blocked' as const,
        code: 'baseline_execution_requires_reconciliation' as const,
        kind,
        operationId: stage.operationId,
      };
    const bytes = await this.downloads.readBatch(
      uid,
      fence,
      stage.manifest.map((file) => file.artifactId),
      stage.policy.uploadBytes,
      signal,
    );
    const request = SourceJobRequest.parse({
      schemaVersion: '1.0',
      operationId: stage.operationId,
      inputDigest: fence.inputDigest,
      adapterDigest: stage.adapterDigest,
      entryArtifactId: stage.adapter.sourceArtifactId,
      mappings: stage.adapter.mappings,
      maximumOutputBytes: stage.maximumOutputBytes,
      maximumElements: stage.maximumElements,
      files: stage.manifest.map((file) => {
        const source = bytes.find(
          (item) => item.artifactId === file.artifactId,
        );
        if (
          !source ||
          source.sha256 !== file.sha256 ||
          source.bytes.length !== file.bytes
        )
          throw new Error('Baseline download differs from manifest');
        let binary = '';
        for (const byte of source.bytes) binary += String.fromCharCode(byte);
        return { ...file, dataBase64: btoa(binary) };
      }),
    });
    const evidence = SandboxTemplateEvidence.parse(
        await this.documents.get(
          `sandboxTemplates/${stage.request.templateEvidenceId}`,
        ),
      ),
      cost = Count.parse(
        Number(
          BigInt(evidence.microUsdPerSecondCeiling) *
            BigInt(stage.request.lifetimeSeconds),
        ),
      ),
      now = this.clock().toISOString();
    await new AdmissionRepository(this.documents, this.clock).acquire(
      uid,
      fence,
    );
    await reserveOperation(
      new FirestoreAccountingStore(this.documents),
      Operation.parse({
        schemaVersion: '1.0',
        id: stage.operationId,
        ownerUid: uid,
        auditId: fence.auditId,
        revisionId: fence.revisionId,
        inputDigest: fence.inputDigest,
        fence: fence.generation,
        requestDigest: await sha256(canonicalJson(stage.request)),
        outcome: 'reserved',
        usage: null,
        providerHandle: null,
        charges: expectedCharges(stage.request, cost),
        createdAt: now,
        updatedAt: now,
      }),
    );
    await this.jobs.bind(stage.request);
    const readiness = await new SourceReadiness(
      this.documents,
      this.clock,
    ).approve(uid, fence, request, kind);
    if (readiness.status !== 'ready') {
      const reasons = ReadinessReasons.parse(readiness.reasons);
      await this.documents.transaction(async (tx) => {
        await requireActiveRevision(tx, uid, fence);
        const current = await tx.get(stagePath);
        if (
          current?.operationId !== stage.operationId ||
          current.ownerUid !== uid
        )
          throw new Error('Baseline stage changed before input review');
        if (
          current.rejection &&
          canonicalJson(ReadinessReasons.parse(current.rejection)) !==
            canonicalJson(reasons)
        )
          throw new Error('Baseline input review changed');
        tx.set(stagePath, {
          ...current,
          rejection: reasons,
          updatedAt: this.clock(),
        });
      });
      await releaseUndispatched(
        new FirestoreAccountingStore(this.documents),
        stage.operationId,
        fence.generation,
        this.clock().toISOString(),
      );
      return {
        status: 'needs_input' as const,
        kind,
        operationId: stage.operationId,
        reasons: readiness.reasons,
      };
    }
    const result = await this.pipeline.run(
      stage.request,
      request,
      readiness.approvalId,
      signal,
    );
    if (result.cleanup !== 'confirmed')
      return {
        status: 'blocked' as const,
        code: 'baseline_cleanup_pending' as const,
        kind,
        operationId: stage.operationId,
      };
    await this.outputs.persist(
      request,
      result.manifest,
      result.payloads,
      signal,
    );
    const output = SourceOutputPlan.parse(
      await this.documents.get(`sourceOutputPlans/${stage.operationId}`),
    );
    if (
      output.operationId !== stage.operationId ||
      output.ownerUid !== uid ||
      output.auditId !== fence.auditId ||
      output.revisionId !== fence.revisionId ||
      output.status !== 'stored'
    )
      throw new Error('Baseline output publication was not confirmed');
    await this.documents.transaction(async (tx) => {
      await requireActiveRevision(tx, uid, fence);
      const current = await tx.get(stagePath);
      if (current?.operationId !== stage.operationId)
        throw new Error('Baseline stage changed before publication');
      tx.set(
        stagePath,
        nativeTimestamps({
          ...current,
          status: 'source_stored',
          outputDigest: output.outputDigest,
          updatedAt: this.clock(),
        }),
      );
    });
    return {
      status: 'source_stored' as const,
      kind,
      operationId: stage.operationId,
      outputDigest: output.outputDigest,
    };
  }
}
