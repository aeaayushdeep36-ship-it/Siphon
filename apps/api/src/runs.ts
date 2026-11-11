import { type RunQueue } from './run-queue.js';
import { ApiError } from './errors.js';
import { AuditPlan, StartAudit, ResumedAuditReceipt } from '@siphon/contracts';
import { HeatParameterValues } from './scientific-parameters.js';
import { type DocumentStore } from './firestore.js';
import { requireActiveRevision, receiptKey } from './audit-commands.js';
import { canonicalJson, sha256 } from './hashing.js';
import { InspectionStageJob } from './run-queue.js';

export interface InspectionWorkflowBinding {
  create(options: {
    id: string;
    params: {
      schemaVersion: '1.0';
      jobId: string;
      resumeContext?: true;
      resumeScientific?: true;
      fence?: {
        auditId: string;
        revisionId: string;
        inputDigest: string;
        generation: number;
      };
    };
  }): Promise<unknown>;
  get(id: string): Promise<{ status(): Promise<unknown> }>;
}

async function dispatchWorkflow(
  binding: InspectionWorkflowBinding,
  options: Parameters<InspectionWorkflowBinding['create']>[0],
  unknownMessage: string,
) {
  try {
    await binding.create(options);
    return;
  } catch {
    // The create response may be lost after the instance is created.
  }
  let observed: unknown;
  try {
    observed = await (await binding.get(options.id)).status();
  } catch {
    throw new ApiError(503, 'workflow_dispatch_unknown', unknownMessage, true);
  }
  const status =
    observed && typeof observed === 'object' && 'status' in observed
      ? observed.status
      : undefined;
  if (status === 'errored' || status === 'terminated')
    throw new ApiError(
      409,
      'workflow_stopped',
      'The previous workflow stopped. Review the audit status, then retry the continuation if appropriate.',
    );
  if (
    ![
      'queued',
      'running',
      'paused',
      'waiting',
      'waitingForPause',
      'rollingBack',
      'complete',
    ].includes(typeof status === 'string' ? status : '')
  )
    throw new ApiError(503, 'workflow_dispatch_unknown', unknownMessage, true);
}

/** Explicit continuation after setup blockers; never repeats source inspection. */
export class ResumeService {
  constructor(
    private readonly documents: DocumentStore,
    private readonly binding: InspectionWorkflowBinding | undefined,
    private readonly enabled: boolean,
  ) {}
  async resumeScientific(
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
      `POST /audits/${auditId}/revisions/${revisionId}/scientific-run`,
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
    await this.documents.transaction(async (tx) => {
      const state = await requireActiveRevision(tx, uid, fence);
      const base = `audits/${auditId}/revisions/${revisionId}`;
      const [rawJob, rawPlan, parameters] = await tx.getMany([
        `stageJobs/${jobId}`,
        `${base}/plans/current`,
        `${base}/scientificParameters/current`,
      ]);
      const job = InspectionStageJob.parse(rawJob),
        plan = AuditPlan.parse(rawPlan?.plan);
      if (
        ![
          'adapting',
          'planning',
          'executing',
          'evaluating',
          'investigating',
          'reporting',
        ].includes(state.stage) ||
        job.status !== 'inspection_complete' ||
        job.ownerUid !== uid ||
        job.auditId !== auditId ||
        job.revisionId !== revisionId ||
        job.inputDigest !== fence.inputDigest ||
        rawPlan?.ownerUid !== uid ||
        rawPlan.auditId !== auditId ||
        rawPlan.revisionId !== revisionId ||
        rawPlan.inputDigest !== fence.inputDigest ||
        rawPlan.planDigest !== (await sha256(canonicalJson(plan))) ||
        plan.inputDigest !== fence.inputDigest
      )
        throw new ApiError(
          409,
          'scientific_run_not_ready',
          'A current scientific plan is required.',
        );
      if (plan.domain === 'heat_diffusion') {
        const parsed = HeatParameterValues.safeParse(parameters?.parameters);
        if (
          !parsed.success ||
          parameters?.ownerUid !== uid ||
          parameters.planDigest !== rawPlan.planDigest ||
          parameters.parametersDigest !==
            (await sha256(canonicalJson(parsed.data)))
        )
          throw new ApiError(
            409,
            'heat_parameters_required',
            'Enter density and specific heat capacity before running.',
          );
      }
    });
    const id = `scientific-${await sha256(canonicalJson({ requestId, fence }))}`;
    await dispatchWorkflow(
      this.binding,
      {
        id,
        params: { schemaVersion: '1.0', jobId, resumeScientific: true, fence },
      },
      'Continuation outcome is unknown; retry with the same Idempotency-Key.',
    );
    return ResumedAuditReceipt.parse({
      schemaVersion: '1.0',
      jobId,
      auditId,
      revisionId,
      status: 'accepted',
    });
  }
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
    await dispatchWorkflow(
      this.binding,
      {
        id,
        params: { schemaVersion: '1.0', jobId, resumeContext: true },
      },
      'Continuation outcome is unknown; retry with the same Idempotency-Key.',
    );
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
    await dispatchWorkflow(
      this.binding,
      {
        id,
        params: { schemaVersion: '1.0', jobId: result.receipt.jobId },
      },
      'The audit is queued; retry with the same Idempotency-Key to confirm its workflow.',
    );
    return result;
  }
}
