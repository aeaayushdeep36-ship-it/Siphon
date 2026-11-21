import { z } from 'zod';
import { Count, Id, ResourcePolicy } from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import { DispatchFence, requireActiveRevision } from './audit-commands.js';
import { AdmissionRepository } from './admission.js';
import { Operation, reserveOperation } from './accounting.js';
import { FirestoreAccountingStore } from './firestore-accounting.js';
import { SandboxRequest } from './e2b-client.js';
import {
  SandboxTemplateEvidence,
  expectedCharges,
  type SandboxJobs,
} from './sandbox-jobs.js';
import { type FidelityPipeline } from './fidelity-pipeline.js';
import { canonicalJson, sha256 } from './hashing.js';

const Config = z.strictObject({
  templateEvidenceId: Id,
  lifetimeSeconds: Count.refine((n) => n > 0),
});
export class FidelityStage {
  constructor(
    private readonly store: DocumentStore,
    private readonly jobs: Pick<SandboxJobs, 'bind'>,
    private readonly pipeline: Pick<FidelityPipeline, 'run' | 'recover'>,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async run(
    uid: string,
    expected: unknown,
    signal = AbortSignal.timeout(240000),
  ) {
    const fence = DispatchFence.parse(expected),
      base = `audits/${fence.auditId}/revisions/${fence.revisionId}`,
      path = `fidelityStages/${fence.revisionId}`;
    const stage = await this.store.transaction(async (tx) => {
      const state = await requireActiveRevision(tx, uid, fence);
      const [revision, original, adapted, prior] = await tx.getMany([
        base,
        `baselineValidationStages/${fence.revisionId}_original`,
        `baselineValidationStages/${fence.revisionId}_adapted`,
        path,
      ]);
      if (state.stage !== 'adapting')
        throw new Error('Comparison requires adapter stage');
      for (const record of [original, adapted])
        if (
          !record ||
          record.ownerUid !== uid ||
          record.auditId !== fence.auditId ||
          record.revisionId !== fence.revisionId ||
          record.inputDigest !== fence.inputDigest ||
          record.generation !== fence.generation
        )
          throw new Error('Comparison validation stage changed');
      const left = {
          sourceOperationId: Id.parse(original!.sourceOperationId),
          validationOperationId: Id.parse(original!.operationId),
        },
        right = {
          sourceOperationId: Id.parse(adapted!.sourceOperationId),
          validationOperationId: Id.parse(adapted!.operationId),
        };
      const [leftReport, rightReport] = await tx.getMany([
        `${base}/numericValidations/${left.validationOperationId}`,
        `${base}/numericValidations/${right.validationOperationId}`,
      ]);
      for (const [report, source] of [
        [leftReport, left],
        [rightReport, right],
      ] as const)
        if (
          report?.ownerUid !== uid ||
          report.inputDigest !== fence.inputDigest ||
          report.sourceOperationId !== source.sourceOperationId ||
          report.operationId !== source.validationOperationId
        )
          throw new Error('Published baseline validation required');
      if (prior) {
        if (
          prior.ownerUid !== uid ||
          prior.inputDigest !== fence.inputDigest ||
          prior.generation !== fence.generation ||
          canonicalJson(prior.original) !== canonicalJson(left) ||
          canonicalJson(prior.adapted) !== canonicalJson(right)
        )
          throw new Error('Comparison stage changed');
        return {
          operationId: Id.parse(prior.operationId),
          request: SandboxRequest.parse(prior.request),
          left,
          right,
        };
      }
      const config = Config.parse(
          await tx.get('configuration/evaluation_dispatch'),
        ),
        evidence = SandboxTemplateEvidence.parse(
          await tx.get(`sandboxTemplates/${config.templateEvidenceId}`),
        ),
        policy = ResourcePolicy.parse(revision?.policy);
      if (
        evidence.role !== 'evaluation' ||
        evidence.id !== config.templateEvidenceId ||
        Date.parse(evidence.verifiedAt) > this.clock().getTime() ||
        Date.parse(evidence.expiresAt) <=
          this.clock().getTime() + config.lifetimeSeconds * 1000 ||
        config.lifetimeSeconds > policy.sandboxLifetimeSeconds
      )
        throw new Error('Verified evaluation runtime unavailable');
      const operationId = crypto.randomUUID(),
        request = SandboxRequest.parse({
          operationId,
          auditId: fence.auditId,
          revisionId: fence.revisionId,
          inputDigest: fence.inputDigest,
          role: 'evaluation',
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
      tx.set(path, {
        schemaVersion: '1.0',
        ownerUid: uid,
        ...fence,
        original: left,
        adapted: right,
        operationId,
        request,
        createdAt: this.clock(),
      });
      return { operationId, request, left, right };
    });
    const prior = await this.store.get(`operations/${stage.operationId}`);
    if (prior && Operation.parse(prior).outcome !== 'reserved') {
      const [candidate, report] = await Promise.all([
        this.store.get(`fidelityCandidates/${stage.operationId}`),
        this.store.get(`${base}/baselineComparisons/${stage.operationId}`),
      ]);
      if (!candidate && !report)
        return {
          status: 'blocked' as const,
          code: 'comparison_requires_reconciliation' as const,
          operationId: stage.operationId,
        };
      return {
        ...(await this.pipeline.recover(stage.operationId)),
        operationId: stage.operationId,
      };
    }
    const evidence = SandboxTemplateEvidence.parse(
        await this.store.get(
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
    await new AdmissionRepository(this.store, this.clock).acquire(uid, fence);
    await reserveOperation(
      new FirestoreAccountingStore(this.store),
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
    return {
      ...(await this.pipeline.run(
        uid,
        stage.left,
        stage.right,
        stage.request,
        fence,
        signal,
      )),
      operationId: stage.operationId,
    };
  }
}
