import { z } from 'zod';
import { Count, Id, ResourcePolicy } from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import { DispatchFence, requireActiveRevision } from './audit-commands.js';
import { Operation, reserveOperation } from './accounting.js';
import { FirestoreAccountingStore } from './firestore-accounting.js';
import { AdmissionRepository } from './admission.js';
import { SandboxRequest } from './e2b-client.js';
import {
  expectedCharges,
  SandboxTemplateEvidence,
  type SandboxJobs,
} from './sandbox-jobs.js';
import { SourceOutputPlan } from './source-output-store.js';
import { type ValidationPipeline } from './validation-pipeline.js';
import { canonicalJson, sha256 } from './hashing.js';

const Configuration = z.strictObject({
  templateEvidenceId: Id,
  lifetimeSeconds: Count.refine((n) => n > 0),
});

/** Connects a stored baseline to the existing fresh data-only validator. This
 * does not compare runs, approve an adapter or issue scientific verdicts.
 */
export class BaselineValidationStage {
  constructor(
    private readonly documents: DocumentStore,
    private readonly jobs: Pick<SandboxJobs, 'bind'>,
    private readonly pipeline: Pick<ValidationPipeline, 'run' | 'recover'>,
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
      stagePath = `baselineValidationStages/${fence.revisionId}_${kind}`;
    const stage = await this.documents.transaction(async (tx) => {
      const state = await requireActiveRevision(tx, uid, fence);
      const [revision, source, prior] = await tx.getMany([
        base,
        `baselineStages/${fence.revisionId}_${kind}`,
        stagePath,
      ]);
      if (
        state.stage !== 'adapting' ||
        source?.ownerUid !== uid ||
        source.auditId !== fence.auditId ||
        source.revisionId !== fence.revisionId ||
        source.inputDigest !== fence.inputDigest ||
        source.generation !== fence.generation ||
        source.kind !== kind
      )
        throw new Error('Baseline validation source stage is stale');
      const sourceOperationId = Id.parse(source.operationId),
        output = SourceOutputPlan.parse(
          await tx.get(`sourceOutputPlans/${sourceOperationId}`),
        );
      if (
        output.operationId !== sourceOperationId ||
        output.ownerUid !== uid ||
        output.auditId !== fence.auditId ||
        output.revisionId !== fence.revisionId ||
        output.status !== 'stored'
      )
        throw new Error('Baseline observations are not stored');
      if (prior) {
        if (
          prior.ownerUid !== uid ||
          prior.auditId !== fence.auditId ||
          prior.revisionId !== fence.revisionId ||
          prior.inputDigest !== fence.inputDigest ||
          prior.generation !== fence.generation ||
          prior.sourceOperationId !== sourceOperationId ||
          prior.outputDigest !== output.outputDigest ||
          prior.kind !== kind
        )
          throw new Error('Baseline validation stage changed');
        return {
          operationId: Id.parse(prior.operationId),
          sourceOperationId,
          request: SandboxRequest.parse(prior.request),
        };
      }
      const policy = ResourcePolicy.parse(revision?.policy),
        config = Configuration.parse(
          await tx.get('configuration/evaluation_dispatch'),
        ),
        evidence = SandboxTemplateEvidence.parse(
          await tx.get(`sandboxTemplates/${config.templateEvidenceId}`),
        );
      if (
        evidence.id !== config.templateEvidenceId ||
        evidence.role !== 'evaluation' ||
        Date.parse(evidence.verifiedAt) > this.clock().getTime() ||
        Date.parse(evidence.expiresAt) <=
          this.clock().getTime() + config.lifetimeSeconds * 1000 ||
        config.lifetimeSeconds > policy.sandboxLifetimeSeconds
      )
        throw new Error('Verified evaluation runtime is unavailable');
      const operationId = crypto.randomUUID(),
        request = SandboxRequest.parse({
          operationId,
          auditId: fence.auditId,
          revisionId: fence.revisionId,
          inputDigest: fence.inputDigest,
          role: 'evaluation',
          templateId: evidence.templateId,
          templateEvidenceId: evidence.id,
          lifetimeSeconds: config.lifetimeSeconds,
        });
      tx.set(stagePath, {
        schemaVersion: '1.0',
        ownerUid: uid,
        ...fence,
        kind,
        sourceOperationId,
        outputDigest: output.outputDigest,
        operationId,
        request,
        createdAt: this.clock(),
      });
      return { operationId, sourceOperationId, request };
    });
    const record = await this.documents.get(`operations/${stage.operationId}`);
    if (record && Operation.parse(record).outcome !== 'reserved') {
      // Recovery revalidates the durable report/candidate and termination proof.
      // It never decodes data again or creates another VM.
      const report = await this.documents.get(
          `${base}/numericValidations/${stage.operationId}`,
        ),
        candidate = await this.documents.get(
          `validationCandidates/${stage.operationId}`,
        );
      if (!report && !candidate)
        return {
          status: 'blocked' as const,
          code: 'baseline_validation_requires_reconciliation' as const,
          kind,
          operationId: stage.operationId,
        };
      const recovered = await this.pipeline.recover(stage.operationId);
      return {
        status: 'validation_published' as const,
        kind,
        operationId: stage.operationId,
        sourceOperationId: stage.sourceOperationId,
        reportDigest: recovered.reportDigest,
      };
    }
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
    const result = await this.pipeline.run(
      uid,
      stage.sourceOperationId,
      stage.request,
      fence,
      signal,
    );
    if (result.status !== 'published')
      return {
        status: 'blocked' as const,
        code: 'baseline_validation_cleanup_pending' as const,
        kind,
        operationId: stage.operationId,
      };
    return {
      status: 'validation_published' as const,
      kind,
      operationId: stage.operationId,
      sourceOperationId: stage.sourceOperationId,
      reportDigest: result.reportDigest,
    };
  }
}
