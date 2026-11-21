import { z } from 'zod';
import {
  Count,
  EvidenceReport,
  Id,
  ResourcePolicy,
  Timestamp,
} from '@siphon/contracts';
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
import { type PdfPipeline } from './pdf-pipeline.js';
import { canonicalJson, sha256 } from './hashing.js';

const Configuration = z.strictObject({
  templateEvidenceId: Id,
  lifetimeSeconds: Count.refine((value) => value > 0),
});

/** Reserve a distinct renderer for a published report. Unknown dispatch or
 * storage outcomes are reconciled rather than repeated. */
export class ScientificPdfStage {
  constructor(
    private readonly store: DocumentStore,
    private readonly jobs: Pick<SandboxJobs, 'bind'>,
    private readonly pipeline: Pick<PdfPipeline, 'run' | 'recover'>,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async run(uid: string, expected: unknown) {
    const fence = DispatchFence.parse(expected),
      base = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
    const stage = await this.store.transaction(async (tx) => {
      const state = await requireActiveRevision(tx, uid, fence);
      const [revision, prior, configValue] = await tx.getMany([
        base,
        `scientificPdfStages/${fence.revisionId}`,
        'configuration/pdf_dispatch',
      ]);
      if (state.stage !== 'reporting' || !revision)
        throw new Error('PDF requires an active report');
      const reportId = Id.parse(revision.reportId);
      const rawReport = await tx.get(`${base}/reports/${reportId}`);
      const report = EvidenceReport.parse(
        JSON.parse(z.string().parse(rawReport?.reportJson)),
      );
      const reportDigest = await sha256(canonicalJson(report)),
        now = this.clock();
      if (
        rawReport?.ownerUid !== uid ||
        rawReport.auditId !== fence.auditId ||
        rawReport.revisionId !== fence.revisionId ||
        rawReport.reportId !== reportId ||
        rawReport.inputDigest !== fence.inputDigest ||
        rawReport.reportDigest !== reportDigest ||
        rawReport.reportJson !== canonicalJson(report) ||
        report.reportId !== reportId ||
        report.auditId !== fence.auditId ||
        report.revisionId !== fence.revisionId ||
        report.inputDigest !== fence.inputDigest ||
        rawReport.expiresAt !== report.expiresAt ||
        Date.parse(report.expiresAt) <= now.getTime()
      )
        throw new Error('Published report changed');
      if (prior) {
        const request = SandboxRequest.parse(prior.request),
          operationId = Id.parse(prior.operationId);
        if (
          prior.ownerUid !== uid ||
          prior.auditId !== fence.auditId ||
          prior.revisionId !== fence.revisionId ||
          prior.inputDigest !== fence.inputDigest ||
          prior.generation !== fence.generation ||
          prior.reportId !== reportId ||
          prior.reportDigest !== reportDigest ||
          request.operationId !== operationId ||
          request.role !== 'pdf' ||
          request.auditId !== fence.auditId ||
          request.revisionId !== fence.revisionId ||
          request.inputDigest !== fence.inputDigest
        )
          throw new Error('PDF stage snapshot changed');
        return { operationId, request };
      }
      const config = Configuration.parse(configValue),
        evidence = SandboxTemplateEvidence.parse(
          await tx.get(`sandboxTemplates/${config.templateEvidenceId}`),
        );
      const policy = ResourcePolicy.parse(revision.policy);
      if (
        evidence.id !== config.templateEvidenceId ||
        evidence.role !== 'pdf' ||
        Date.parse(evidence.verifiedAt) > now.getTime() ||
        Date.parse(evidence.expiresAt) <=
          now.getTime() + config.lifetimeSeconds * 1000 ||
        config.lifetimeSeconds > policy.sandboxLifetimeSeconds ||
        Date.parse(Timestamp.parse(rawReport.expiresAt)) <=
          now.getTime() + config.lifetimeSeconds * 1000
      )
        throw new Error('Verified PDF runtime is unavailable');
      const operationId = crypto.randomUUID(),
        request = SandboxRequest.parse({
          operationId,
          auditId: fence.auditId,
          revisionId: fence.revisionId,
          inputDigest: fence.inputDigest,
          role: 'pdf',
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
      tx.set(`scientificPdfStages/${fence.revisionId}`, {
        schemaVersion: '1.0',
        ownerUid: uid,
        ...fence,
        reportId,
        reportDigest,
        operationId,
        request,
        createdAt: now,
      });
      return { operationId, request };
    });
    const old = await this.store.get(`operations/${stage.operationId}`);
    if (old && Operation.parse(old).outcome !== 'reserved') {
      const [binding, journal, termination] = await Promise.all([
        this.store.get(`pdfExecutions/${stage.operationId}`),
        this.store.get(`operations/pdf_put_${stage.operationId}`),
        this.store.get(`sandboxTerminations/${stage.operationId}`),
      ]);
      if (
        !binding ||
        !journal ||
        !termination ||
        journal.outcome !== 'succeeded'
      )
        return {
          status: 'blocked' as const,
          code: 'pdf_requires_reconciliation' as const,
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
    );
    const cost = Count.parse(
        Number(
          BigInt(evidence.microUsdPerSecondCeiling) *
            BigInt(stage.request.lifetimeSeconds),
        ),
      ),
      now = this.clock().toISOString();
    await new AdmissionRepository(this.store, this.clock).acquire(uid, fence);
    const operation = await reserveOperation(
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
    if (operation.outcome !== 'reserved')
      throw new Error('PDF reservation needs reconciliation');
    await this.jobs.bind(stage.request);
    return {
      ...(await this.pipeline.run(stage.request)),
      operationId: stage.operationId,
    };
  }
}
