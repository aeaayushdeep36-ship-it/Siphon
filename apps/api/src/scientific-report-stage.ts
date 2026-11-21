import {
  ConservationJobRequest,
  Id,
  Timestamp,
  validateConservationJobResult,
} from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import { DispatchFence, requireActiveRevision } from './audit-commands.js';
import { Operation } from './accounting.js';
import { SandboxTermination } from './sandbox-termination.js';
import { persistProgress } from './progress.js';
import { transition } from './lifecycle.js';
import { ReportPublication } from './report-publication.js';
import { canonicalJson, sha256 } from './hashing.js';
import { readInvestigationReview } from './investigation-review.js';

/** Publish a limited structured report from a completed data-only evaluation.
 * This does not claim an AI investigation or a PDF export. */
export class ScientificReportStage {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async publish(uid: string, expected: unknown, evaluationIdValue: unknown) {
    let fence = DispatchFence.parse(expected);
    const evaluationId = Id.parse(evaluationIdValue);
    const base = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
    let reportId: string | null = null;
    for (let i = 0; i < 3; i++) {
      const step = await this.store.transaction(async (tx) => {
        const state = await requireActiveRevision(tx, uid, fence);
        if (!['evaluating', 'investigating', 'reporting'].includes(state.stage))
          throw new Error('Evidence report stage is unavailable');
        const [
          stage,
          evidence,
          rawOperation,
          rawTermination,
          binding,
          requestStage,
        ] = await tx.getMany([
          `scientificReportStages/${fence.revisionId}`,
          `${base}/evidence/${evaluationId}`,
          `operations/${evaluationId}`,
          `sandboxTerminations/${evaluationId}`,
          `conservationExecutions/${evaluationId}`,
          `scientificEvaluationStages/${fence.revisionId}`,
        ]);
        const operation = Operation.parse(rawOperation),
          termination = SandboxTermination.parse(rawTermination);
        const request = ConservationJobRequest.parse(requestStage?.request);
        const result = validateConservationJobResult(evidence?.report, request);
        const requestDigest = await sha256(canonicalJson(request)),
          resultDigest = await sha256(canonicalJson(result));
        if (
          operation.id !== evaluationId ||
          operation.ownerUid !== uid ||
          operation.auditId !== fence.auditId ||
          operation.revisionId !== fence.revisionId ||
          operation.inputDigest !== fence.inputDigest ||
          operation.fence > fence.generation ||
          operation.outcome === 'reserved' ||
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
          evidence.reportDigest !== resultDigest ||
          Date.parse(Timestamp.parse(evidence.expiresAt)) <=
            this.clock().getTime()
        )
          throw new Error('Published scientific evidence is not available');
        if (
          stage &&
          (stage.ownerUid !== uid ||
            stage.auditId !== fence.auditId ||
            stage.revisionId !== fence.revisionId ||
            stage.inputDigest !== fence.inputDigest ||
            stage.evaluationOperationId !== evaluationId ||
            stage.evidenceDigest !== resultDigest)
        )
          throw new Error('Scientific report stage changed');
        if (!stage && !['evaluating', 'investigating'].includes(state.stage))
          throw new Error('Scientific report stage claim is missing');
        const investigation = await readInvestigationReview(
          tx,
          uid,
          fence,
          this.clock,
        );
        if (investigation?.status === 'awaiting_review')
          throw new Error('Investigation text requires owner review');
        const id = stage ? Id.parse(stage.reportId) : crypto.randomUUID();
        if (state.stage === 'reporting')
          return { reportId: id, fence, done: true };
        const target =
          state.stage === 'evaluating'
            ? ('investigating' as const)
            : ('reporting' as const);
        const event = {
          kind: 'advance' as const,
          stage: target,
          reason: 'Preserve published numerical evidence in a report.',
        };
        const next = transition(state, fence, event);
        await persistProgress(
          tx,
          uid,
          fence.auditId,
          fence,
          {
            activity:
              target === 'investigating'
                ? 'investigating_findings'
                : 'rendering_report',
            experiments: { planned: 1, completed: 1 },
          },
          this.clock(),
          event,
        );
        if (!stage)
          tx.set(`scientificReportStages/${fence.revisionId}`, {
            schemaVersion: '1.0',
            ownerUid: uid,
            auditId: fence.auditId,
            revisionId: fence.revisionId,
            inputDigest: fence.inputDigest,
            evaluationOperationId: evaluationId,
            evidenceDigest: resultDigest,
            reportId: id,
            createdAt: this.clock(),
          });
        return {
          reportId: id,
          fence: { ...fence, generation: next.generation },
          done: false,
        };
      });
      reportId = step.reportId;
      fence = step.fence;
      if (step.done) break;
    }
    if (!reportId) throw new Error('Scientific report id unavailable');
    const result = await new ReportPublication(
      this.store,
      this.clock,
    ).assembleAndPublish(uid, fence, {
      reportId,
      conservationOperationIds: [evaluationId],
    });
    return {
      status: 'report_published' as const,
      reportId,
      reportDigest: result.reportDigest,
      fence,
      replayed: result.replayed,
    };
  }
}
