import { type RunQueue } from './run-queue.js';
import { ApiError } from './errors.js';
import { StartAudit, ResumedAuditReceipt } from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import { requireActiveRevision, receiptKey } from './audit-commands.js';
import { canonicalJson, sha256 } from './hashing.js';
import { InspectionStageJob } from './run-queue.js';

export interface InspectionWorkflowBinding {
  create(options: {
    id: string;
    params: { schemaVersion: '1.0'; jobId: string; resumeContext?: true };
  }): Promise<unknown>;
  get(id: string): Promise<{ status(): Promise<unknown> }>;
}

/** Explicit continuation after setup blockers; never repeats source inspection. */
export class ResumeService {
  constructor(
    private readonly documents: DocumentStore,
    private readonly binding: InspectionWorkflowBinding | undefined,
    private readonly enabled: boolean,
  ) {}
  async resume(
    uid: string,
    auditId: string,
    revisionId: string,
    value: unknown,
    key: string,
  ) {
    if (!this.enabled || !this.binding)
      throw new ApiError(
        503,
        'audit_execution_unavailable',
        'Audit execution is not configured yet.',
      );
    const input = StartAudit.parse(value),
      fence = {
        auditId,
        revisionId,
        generation: input.expectedGeneration,
        inputDigest: input.expectedInputDigest,
      };
    const requestId = await receiptKey(
      uid,
      `POST /audits/${auditId}/revisions/${revisionId}/resume`,
      key,
    );
    const jobId = await sha256(
      canonicalJson({
        uid,
        auditId,
        revisionId,
        inputDigest: fence.inputDigest,
        stage: 'inspection',
      }),
    );
    const receipt = await this.documents.transaction(async (tx) => {
      const state = await requireActiveRevision(tx, uid, fence);
      const [raw, inspection] = await tx.getMany([
        `stageJobs/${jobId}`,
        `audits/${auditId}/revisions/${revisionId}/inspection/current`,
      ]);
      const job = InspectionStageJob.parse(raw);
      if (
        !['inspecting', 'clarifying', 'adapting'].includes(state.stage) ||
        job.status !== 'inspection_complete' ||
        job.ownerUid !== uid ||
        job.auditId !== auditId ||
        job.revisionId !== revisionId ||
        job.inputDigest !== fence.inputDigest ||
        inspection?.ownerUid !== uid ||
        inspection.inputDigest !== fence.inputDigest ||
        inspection.operationId !== job.operationId ||
        inspection.resultDigest !== job.resultDigest
      )
        throw new ApiError(
          409,
          'resume_not_ready',
          'This revision does not have a completed inspection to resume.',
        );
      return ResumedAuditReceipt.parse({
        schemaVersion: '1.0',
        jobId,
        auditId,
        revisionId,
        status: 'accepted',
      });
    });
    const id = `context-${requestId}`;
    try {
      await this.binding.create({
        id,
        params: { schemaVersion: '1.0', jobId, resumeContext: true },
      });
    } catch {
      try {
        await (await this.binding.get(id)).status();
      } catch {
        throw new ApiError(
          503,
          'workflow_dispatch_unknown',
          'Continuation outcome is unknown; retry with the same Idempotency-Key.',
          true,
        );
      }
    }
    return receipt;
  }
}
/** Idempotent durable trigger. No sandbox/model execution occurs in HTTP. */
export class RunService {
  constructor(
    private readonly queue: Pick<RunQueue, 'enqueue'>,
    private readonly binding: InspectionWorkflowBinding | undefined,
    private readonly enabled: boolean,
    private readonly prepareAnswers?: (
      uid: string,
      auditId: string,
      revisionId: string,
      value: unknown,
    ) => Promise<void>,
  ) {}
  async start(
    uid: string,
    auditId: string,
    revisionId: string,
    value: unknown,
    key: string,
  ) {
    if (!this.enabled || !this.binding)
      throw new ApiError(
        503,
        'audit_execution_unavailable',
        'Audit execution is not configured yet.',
      );
    await this.prepareAnswers?.(uid, auditId, revisionId, value);
    const result = await this.queue.enqueue(
      uid,
      auditId,
      revisionId,
      value,
      key,
    );
    const id = `inspection-${result.receipt.jobId}`;
    try {
      await this.binding.create({
        id,
        params: { schemaVersion: '1.0', jobId: result.receipt.jobId },
      });
    } catch {
      try {
        await (await this.binding.get(id)).status();
      } catch {
        throw new ApiError(
          503,
          'workflow_dispatch_unknown',
          'The audit is queued; retry with the same Idempotency-Key to confirm its workflow.',
          true,
        );
      }
    }
    return result;
  }
}
