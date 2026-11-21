import {
  Count,
  Digest,
  EvidenceReport,
  Id,
  Timestamp,
} from '@siphon/contracts';
import { z } from 'zod';
import { type DocumentStore, type DocumentTransaction } from './firestore.js';
import {
  authorize,
  DispatchFence,
  requireActiveRevision,
  stateFrom,
} from './audit-commands.js';
import { Operation } from './accounting.js';
import { SandboxTermination } from './sandbox-termination.js';
import { persistProgress } from './progress.js';
import { canonicalJson, sha256 } from './hashing.js';
import { AdmissionRepository } from './admission.js';

const FinishReceipt = DispatchFence.extend({
  schemaVersion: z.literal('1.0'),
  ownerUid: z.string().min(1).max(128),
  operationId: Id,
  reportId: Id,
  reportDigest: Digest,
  pdfSha256: Digest,
  status: z.literal('partial'),
  finishedAt: Timestamp,
});

/** Reported-sample conservation is limited coverage of the required scientific
 * methods. Owner-reviewed advisory text cannot promote that coverage. */
export class ScientificFinishStage {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** A committed finish may outlive its Workflow checkpoint. Reauthorize the
   * owner and exact terminal successor before returning the durable receipt;
   * replay never releases capacity or republishes progress. */
  private async replay(
    tx: DocumentTransaction,
    uid: string,
    fence: z.infer<typeof DispatchFence>,
    operationId: string,
  ) {
    const raw = await tx.get(`scientificFinishStages/${fence.revisionId}`);
    if (!raw) return null;
    const receipt = FinishReceipt.parse(raw);
    const audit = await authorize(tx, uid, fence.auditId, false);
    const revision = await tx.get(
      `audits/${fence.auditId}/revisions/${fence.revisionId}`,
    );
    if (!revision) throw new Error('Finished revision is unavailable');
    const state = stateFrom(revision);
    if (
      receipt.ownerUid !== uid ||
      receipt.auditId !== fence.auditId ||
      receipt.revisionId !== fence.revisionId ||
      receipt.inputDigest !== fence.inputDigest ||
      receipt.generation !== fence.generation ||
      receipt.operationId !== operationId ||
      audit.currentRevisionId !== fence.revisionId ||
      revision.ownerUid !== uid ||
      revision.reportId !== receipt.reportId ||
      revision.slotLeaseId != null ||
      revision.activeOperationId != null ||
      state.auditId !== fence.auditId ||
      state.revisionId !== fence.revisionId ||
      state.inputDigest !== fence.inputDigest ||
      state.generation !== fence.generation + 1 ||
      state.stage !== 'finished' ||
      state.status !== receipt.status ||
      state.cancellationRequestedAt !== null
    )
      throw new Error('Scientific finish receipt changed');
    return {
      schemaVersion: '1.0' as const,
      status: receipt.status,
      reportId: receipt.reportId,
    };
  }

  async finish(uid: string, expected: unknown, pdfOperationIdValue: unknown) {
    const fence = DispatchFence.parse(expected),
      operationId = Id.parse(pdfOperationIdValue);
    const base = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
    // A terminal revision cannot use the normal active-revision release path.
    // Release capacity first only when the durable admission ledger confirms
    // that every tracked provider operation has ended. A crash is replayable.
    const preparation = await this.store.transaction(async (tx) => {
      const replay = await this.replay(tx, uid, fence, operationId);
      if (replay) return { replay, leaseId: null };
      const state = await requireActiveRevision(tx, uid, fence);
      if (state.stage !== 'reporting')
        throw new Error('Report finalization requires reporting stage');
      const revision = await tx.get(base);
      return {
        replay: null,
        leaseId:
          revision?.slotLeaseId == null ? null : Id.parse(revision.slotLeaseId),
      };
    });
    if (preparation.replay) return preparation.replay;
    const leaseId = preparation.leaseId;
    if (leaseId)
      await new AdmissionRepository(this.store, this.clock).releaseReconciled(
        uid,
        fence,
        leaseId,
      );
    return this.store.transaction(async (tx) => {
      const replay = await this.replay(tx, uid, fence, operationId);
      if (replay) return replay;
      const state = await requireActiveRevision(tx, uid, fence);
      if (state.stage !== 'reporting')
        throw new Error('Report finalization requires reporting stage');
      const revision = await tx.get(base),
        reportId = Id.parse(revision?.reportId);
      const [rawReport, exported, binding, rawOperation, rawTermination] =
        await tx.getMany([
          `${base}/reports/${reportId}`,
          `${base}/reports/${reportId}/exports/pdf`,
          `pdfExecutions/${operationId}`,
          `operations/${operationId}`,
          `sandboxTerminations/${operationId}`,
        ]);
      const operation = Operation.parse(rawOperation),
        termination = SandboxTermination.parse(rawTermination);
      const report = EvidenceReport.parse(
        JSON.parse(String(rawReport?.reportJson)),
      );
      const digest = await sha256(canonicalJson(report));
      const artifactId = Id.parse(exported?.artifactId);
      const pdfDigest = Digest.parse(exported?.pdfSha256);
      const pdfBytes = Count.parse(exported?.bytes);
      const artifact = await tx.get(
        `audits/${fence.auditId}/artifacts/${artifactId}`,
      );
      if (
        revision?.slotLeaseId != null ||
        revision?.activeOperationId != null ||
        rawReport?.ownerUid !== uid ||
        rawReport.auditId !== fence.auditId ||
        rawReport.revisionId !== fence.revisionId ||
        rawReport.inputDigest !== fence.inputDigest ||
        rawReport.reportId !== reportId ||
        rawReport.reportDigest !== digest ||
        rawReport.reportJson !== canonicalJson(report) ||
        report.reportId !== reportId ||
        report.auditId !== fence.auditId ||
        report.revisionId !== fence.revisionId ||
        report.inputDigest !== fence.inputDigest ||
        Date.parse(report.expiresAt) <= this.clock().getTime() ||
        exported?.ownerUid !== uid ||
        exported.auditId !== fence.auditId ||
        exported.revisionId !== fence.revisionId ||
        exported.reportId !== reportId ||
        exported.reportDigest !== digest ||
        exported.status !== 'ready' ||
        binding?.ownerUid !== uid ||
        binding.operationId !== operationId ||
        binding.reportId !== reportId ||
        binding.reportDigest !== digest ||
        binding.artifactId !== artifactId ||
        binding.status !== 'published' ||
        operation.id !== operationId ||
        operation.ownerUid !== uid ||
        operation.auditId !== fence.auditId ||
        operation.revisionId !== fence.revisionId ||
        operation.inputDigest !== fence.inputDigest ||
        operation.fence !== fence.generation ||
        operation.outcome === 'reserved' ||
        termination.operationId !== operationId ||
        termination.ownerUid !== uid ||
        termination.auditId !== fence.auditId ||
        termination.revisionId !== fence.revisionId ||
        termination.inputDigest !== fence.inputDigest ||
        termination.requestDigest !== operation.requestDigest ||
        termination.sandboxId !== operation.providerHandle ||
        binding.sandboxId !== termination.sandboxId ||
        artifact?.ownerUid !== uid ||
        artifact.auditId !== fence.auditId ||
        artifact.revisionId !== fence.revisionId ||
        artifact.artifactId !== artifactId ||
        artifact.reportId !== reportId ||
        artifact.reportDigest !== digest ||
        artifact.operationId !== operationId ||
        artifact.lifecycle !== 'ready' ||
        artifact.kind !== 'report_pdf' ||
        artifact.mime !== 'application/pdf' ||
        pdfBytes === 0 ||
        artifact.sha256 !== pdfDigest ||
        artifact.bytes !== pdfBytes ||
        Date.parse(Timestamp.parse(artifact.expiresAt)) >
          Date.parse(report.expiresAt) ||
        Date.parse(Timestamp.parse(artifact.expiresAt)) <=
          this.clock().getTime()
      )
        throw new Error('Published report or PDF proof changed');
      const event = {
        kind: 'finish' as const,
        status: 'partial' as const,
        hasEvidence: true,
        narrativeComplete: report.evidenceCatalog.some(
          (item) => item.kind === 'investigation',
        ),
        pdfComplete: true,
      };
      await persistProgress(
        tx,
        uid,
        fence.auditId,
        fence,
        { activity: 'finished', experiments: { planned: 1, completed: 1 } },
        this.clock(),
        event,
      );
      tx.set(`scientificFinishStages/${fence.revisionId}`, {
        ...FinishReceipt.parse({
          schemaVersion: '1.0',
          ownerUid: uid,
          ...fence,
          operationId,
          reportId,
          reportDigest: digest,
          pdfSha256: pdfDigest,
          status: 'partial',
          finishedAt: this.clock().toISOString(),
        }),
        finishedAt: this.clock(),
      });
      return {
        schemaVersion: '1.0' as const,
        status: 'partial' as const,
        reportId,
      };
    });
  }
}
