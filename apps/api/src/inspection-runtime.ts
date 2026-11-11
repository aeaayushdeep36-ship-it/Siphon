import { z } from 'zod';
import { FirebaseServiceConfiguration } from './firebase-config.js';
import { googleAccessTokenProvider } from './google-oauth.js';
import { FirestoreClient } from './firestore.js';
import { ArtifactDownloadService } from './artifact-download.js';
import { R2DownloadStore, type DownloadBucketBinding } from './r2-download.js';
import { R2UploadStore, type UploadBucketBinding } from './r2-upload.js';
import { InspectionSourceLoader } from './inspection-sources.js';
import { SandboxJobs } from './sandbox-jobs.js';
import { E2bClient, type SandboxControlPlane } from './e2b-client.js';
import { InspectionJobs } from './inspection-jobs.js';
import { InspectionPipeline } from './inspection-pipeline.js';
import { InspectionCoordinator } from './inspection-coordinator.js';
import { KvArtifacts, type KvArtifactBinding } from './kv-artifacts.js';
import { ContextCoordinator } from './context-coordinator.js';
import { InspectionStageJob } from './run-queue.js';
import {
  stateFrom,
  requireActiveRevision,
  nativeTimestamps,
} from './audit-commands.js';
import { ProgressRepository } from './progress.js';
import { AdapterCoordinator } from './adapter-coordinator.js';
import { BaselineSourceStage } from './baseline-source-stage.js';
import { SourceExecutions } from './source-executions.js';
import { SourcePipeline } from './source-pipeline.js';
import { SourceJobFailed } from './source-runner.js';
import { SourceOutputStore } from './source-output-store.js';
import { DispatchFence } from './audit-commands.js';
import { BaselineValidationStage } from './baseline-validation-stage.js';
import { ValidationPipeline } from './validation-pipeline.js';
import { ValidationExecutions } from './validation-executions.js';
import { StoredObservationLoader } from './stored-observations.js';
import { FidelityStage } from './fidelity-stage.js';
import { FidelityPipeline } from './fidelity-pipeline.js';
import { FidelityExecutions } from './fidelity-executions.js';
import { AdapterVerification } from './adapter-verification.js';
import { ScientificEligibilityStage } from './scientific-eligibility-stage.js';
import { ScientificQuestions } from './scientific-questions.js';
import { ScientificEvaluationCoordinator } from './scientific-evaluation-coordinator.js';
import { ConservationPipeline } from './conservation-pipeline.js';
import { ConservationExecutions } from './conservation-executions.js';
import { ScientificReportStage } from './scientific-report-stage.js';
import { ScientificPdfStage } from './scientific-pdf-stage.js';
import { ScientificFinishStage } from './scientific-finish-stage.js';
import { ReportPdfPublications } from './report-publication.js';
import { PdfPipeline } from './pdf-pipeline.js';
import { parseAiConfiguration, type AiEnvironment } from './ai-config.js';
import { E2bApiUrl } from './e2b-endpoint.js';

export interface InspectionWorkflowEnvironment extends AiEnvironment {
  SIPHON_INSPECTION_WORKFLOW_ENABLED: string;
  FIREBASE_PROJECT_ID: string;
  FIRESTORE_DATABASE_ID?: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
  E2B_API_KEY: string;
  E2B_API_URL?: string;
  SIPHON_ARTIFACTS?: DownloadBucketBinding & Partial<UploadBucketBinding>;
  SIPHON_PRIVATE_KV?: KvArtifactBinding;
}
const Configuration = FirebaseServiceConfiguration.safeExtend({
  SIPHON_INSPECTION_WORKFLOW_ENABLED: z.literal('true'),
  E2B_API_KEY: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[\x21-\x7e]+$/),
  E2B_API_URL: E2bApiUrl.optional(),
});

function aiIssueMessage(code: string): string {
  switch (code) {
    case 'ai_configuration_required':
    case 'ai_credentials_required':
      return 'AI review needs the configured server-side Groq settings and API key.';
    case 'ai_request_too_large':
      return 'This AI request exceeds the configured input size. No source was truncated; review the input and free-tier limits before retrying.';
    case 'ai_quota_unavailable':
      return 'The AI allowance is exhausted, cooling down, or paused for reconciliation. Retry after the allowance resets or the pause is resolved.';
    default:
      return 'The next audit stage needs service verification or reconciliation; existing evidence has been preserved.';
  }
}

/** Configuration does not provision templates/credits or grant execution. All
 * real repository/provider gates remain mandatory. Offline ports are explicit
 * test injection, never a production endpoint, credential or storage fallback.
 */
export function createInspectionServices(
  environment: InspectionWorkflowEnvironment,
  transport: typeof fetch = fetch,
  provider?: SandboxControlPlane,
  clock: () => Date = () => new Date(),
) {
  const config = Configuration.parse(environment);
  if (
    typeof environment.SIPHON_ARTIFACTS?.get !== 'function' &&
    typeof environment.SIPHON_PRIVATE_KV?.get !== 'function'
  )
    throw new Error('Private inspection storage binding is unavailable');
  const token = googleAccessTokenProvider(
    {
      projectId: config.FIREBASE_PROJECT_ID,
      clientEmail: config.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      privateKey: config.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    },
    transport,
    () => clock().getTime(),
  );
  const store = new FirestoreClient(
    config.FIREBASE_PROJECT_ID,
    token,
    transport,
    config.FIRESTORE_DATABASE_ID,
  );
  const jobs = new SandboxJobs(store, clock, true);
  const client = new E2bClient(
    config.E2B_API_KEY,
    jobs,
    provider,
    config.E2B_API_URL,
  );
  const downloads = new ArtifactDownloadService(
    store,
    environment.SIPHON_PRIVATE_KV
      ? new KvArtifacts(environment.SIPHON_PRIVATE_KV, store, clock)
      : new R2DownloadStore(environment.SIPHON_ARTIFACTS!),
    clock,
  );
  const pipeline = new InspectionPipeline(
    new InspectionSourceLoader(store, downloads),
    client,
    new InspectionJobs(store, clock),
  );
  const coordinator = new InspectionCoordinator(store, jobs, pipeline, clock);
  // Configuration is parsed without exposing secrets. Missing/invalid AI
  // settings block only AI stages, never select a legacy provider implicitly.
  const ai = (() => {
    try {
      return parseAiConfiguration(environment);
    } catch {
      return null;
    }
  })();
  const context = new ContextCoordinator(
    store,
    downloads,
    ai?.apiKey ?? '',
    transport,
    clock,
    undefined,
    ai ?? undefined,
  );
  const continueContext = async (jobId: string) => {
    const job = InspectionStageJob.parse(await store.get(`stageJobs/${jobId}`));
    if (job.status !== 'inspection_complete')
      throw new Error('Context requires completed inspection');
    const record = await store.get(
      `audits/${job.auditId}/revisions/${job.revisionId}`,
    );
    if (!record) throw new Error('Audit revision unavailable');
    const state = stateFrom(record),
      fence = {
        auditId: job.auditId,
        revisionId: job.revisionId,
        inputDigest: job.inputDigest,
        generation: state.generation,
      };
    if (state.stage === 'adapting')
      return { status: 'adapter_pending' as const, fence };
    const ids = await store.transaction(async (tx) => {
      await requireActiveRevision(tx, job.ownerUid, fence);
      const path = `contextStages/${jobId}`,
        existing = await tx.get(path);
      if (existing) {
        if (
          existing.ownerUid !== job.ownerUid ||
          existing.auditId !== job.auditId ||
          existing.revisionId !== job.revisionId ||
          existing.inputDigest !== job.inputDigest
        )
          throw new Error('Context stage snapshot mismatch');
        return z
          .object({
            countId: z.string().uuid(),
            operationId: z.string().uuid(),
            tokenEvidenceId: z.string().uuid(),
          })
          .parse(existing);
      }
      const pointers = {
        countId: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        tokenEvidenceId: crypto.randomUUID(),
      };
      tx.set(path, {
        schemaVersion: '1.0',
        ownerUid: job.ownerUid,
        ...fence,
        ...pointers,
        createdAt: clock(),
      });
      return pointers;
    });
    await new ProgressRepository(store, clock).publish(
      job.ownerUid,
      fence.auditId,
      fence,
      { activity: 'reading_context', experiments: null },
    );
    const result = ai
      ? await context.run(job.ownerUid, fence, ids)
      : {
          status: 'blocked' as const,
          fence,
          code: 'ai_configuration_required',
          required: ['Groq backend settings and API key'],
        };
    if (result.status === 'blocked')
      await store.transaction(async (tx) => {
        await requireActiveRevision(tx, job.ownerUid, fence);
        const path = `audits/${job.auditId}/revisions/${job.revisionId}`,
          revision = await tx.get(path);
        tx.set(
          path,
          nativeTimestamps({
            ...revision,
            updatedAt: clock(),
            operationalIssues: [
              {
                code: result.code,
                message: aiIssueMessage(result.code),
              },
            ],
          }),
        );
      });
    return result;
  };
  const stageIssue = async (
    uid: string,
    expected: unknown,
    code: string,
    message: string,
  ) => {
    const fence = DispatchFence.parse(expected);
    await store.transaction(async (tx) => {
      await requireActiveRevision(tx, uid, fence);
      const path = `audits/${fence.auditId}/revisions/${fence.revisionId}`,
        revision = await tx.get(path);
      tx.set(
        path,
        nativeTimestamps({
          ...revision,
          operationalIssues: [{ code, message }],
          updatedAt: clock(),
        }),
      );
    });
  };
  const continueAdapter = async (uid: string, fence: unknown) => {
    const result = !ai
      ? {
          status: 'blocked' as const,
          fence: DispatchFence.parse(fence),
          code: 'ai_configuration_required',
        }
      : await new AdapterCoordinator(
          store,
          downloads,
          ai.apiKey,
          transport,
          clock,
          ai,
        ).run(uid, fence);
    if (result.status === 'blocked')
      await stageIssue(
        uid,
        result.fence,
        result.code,
        aiIssueMessage(result.code),
      );
    return result;
  };
  const adapterForJob = async (jobId: string, fence: unknown) => {
    const job = InspectionStageJob.parse(await store.get(`stageJobs/${jobId}`));
    const expected = DispatchFence.parse(fence);
    if (
      job.auditId !== expected.auditId ||
      job.revisionId !== expected.revisionId ||
      job.inputDigest !== expected.inputDigest ||
      job.status !== 'inspection_complete'
    )
      throw new Error('Adapter job snapshot changed');
    return continueAdapter(job.ownerUid, fence);
  };
  const baselineForJob = async (
    jobId: string,
    expected: unknown,
    kind: 'original' | 'adapted',
  ) => {
    const job = InspectionStageJob.parse(await store.get(`stageJobs/${jobId}`)),
      fence = DispatchFence.parse(expected);
    if (
      job.auditId !== fence.auditId ||
      job.revisionId !== fence.revisionId ||
      job.inputDigest !== fence.inputDigest ||
      job.status !== 'inspection_complete'
    )
      throw new Error('Baseline job snapshot changed');
    try {
      if (!environment.SIPHON_PRIVATE_KV)
        throw new Error('Private writable artifact binding unavailable');
      await new ProgressRepository(store, clock).publish(
        job.ownerUid,
        fence.auditId,
        fence,
        { activity: 'verifying_adapter', experiments: null },
      );
      const result = await new BaselineSourceStage(
        store,
        downloads,
        jobs,
        new SourcePipeline(new SourceExecutions(store, clock), client),
        new SourceOutputStore(
          store,
          new KvArtifacts(environment.SIPHON_PRIVATE_KV, store, clock),
          clock,
        ),
        clock,
      ).run(job.ownerUid, fence, kind);
      if (result.status === 'source_stored')
        await stageIssue(
          job.ownerUid,
          fence,
          'baseline_validation_pending',
          'Baseline observations have been stored. Independent numeric validation and adapter comparison are still pending. Scientific checks have not started.',
        );
      else if (
        result.status === 'needs_input' &&
        result.reasons.some(
          (reason) => reason.code === 'numeric_input_validator_required',
        )
      )
        await stageIssue(
          job.ownerUid,
          fence,
          'numeric_input_validator_required',
          'CSV and NPY inputs are waiting for the isolated validation runtime to be updated. Your uploaded files are preserved.',
        );
      else
        await stageIssue(
          job.ownerUid,
          fence,
          result.status === 'blocked'
            ? result.code
            : 'baseline_input_review_required',
          'Baseline execution needs input review or cleanup reconciliation. No adapter fidelity result has been issued.',
        );
      return result;
    } catch (error) {
      await stageIssue(
        job.ownerUid,
        fence,
        error instanceof SourceJobFailed
          ? 'source_job_failed'
          : 'baseline_stage_unavailable',
        error instanceof SourceJobFailed
          ? 'The isolated simulation did not complete. Review the script and supported input formats; runtime configuration or cleanup may also need attention. No observations from this attempt were published.'
          : 'Baseline execution is waiting for verified runtime configuration or reconciliation. Existing evidence has been preserved.',
      );
      return {
        status: 'blocked' as const,
        code:
          error instanceof SourceJobFailed
            ? ('source_job_failed' as const)
            : ('baseline_stage_unavailable' as const),
        kind,
      };
    }
  };
  const validateBaselineForJob = async (
    jobId: string,
    expected: unknown,
    kind: 'original' | 'adapted',
  ) => {
    const job = InspectionStageJob.parse(await store.get(`stageJobs/${jobId}`)),
      fence = DispatchFence.parse(expected);
    if (
      job.auditId !== fence.auditId ||
      job.revisionId !== fence.revisionId ||
      job.inputDigest !== fence.inputDigest ||
      job.status !== 'inspection_complete'
    )
      throw new Error('Baseline validation job changed');
    try {
      const result = await new BaselineValidationStage(
        store,
        jobs,
        new ValidationPipeline(
          new StoredObservationLoader(store, downloads),
          new ValidationExecutions(store, clock),
          client,
        ),
        clock,
      ).run(job.ownerUid, fence, kind);
      await stageIssue(
        job.ownerUid,
        fence,
        result.status === 'validation_published'
          ? 'baseline_comparison_pending'
          : result.code,
        result.status === 'validation_published'
          ? 'Baseline numeric validation has been published. Cross-run comparison and adapter fidelity review are still pending. Scientific checks have not started.'
          : 'Baseline numeric validation needs cleanup or execution reconciliation. Existing source observations have been preserved.',
      );
      return result;
    } catch {
      await stageIssue(
        job.ownerUid,
        fence,
        'baseline_validation_unavailable',
        'Numeric validation is waiting for verified evaluator configuration or reconciliation. Source observations remain private and unvalidated.',
      );
      return {
        status: 'blocked' as const,
        code: 'baseline_validation_unavailable' as const,
        kind,
      };
    }
  };
  const compareBaselinesForJob = async (jobId: string, expected: unknown) => {
    const job = InspectionStageJob.parse(await store.get(`stageJobs/${jobId}`)),
      fence = DispatchFence.parse(expected);
    if (
      job.auditId !== fence.auditId ||
      job.revisionId !== fence.revisionId ||
      job.inputDigest !== fence.inputDigest ||
      job.status !== 'inspection_complete'
    )
      throw new Error('Comparison job changed');
    try {
      const result = await new FidelityStage(
        store,
        jobs,
        new FidelityPipeline(
          new StoredObservationLoader(store, downloads),
          new FidelityExecutions(store, clock),
          client,
        ),
        clock,
      ).run(job.ownerUid, fence);
      if (result.status === 'published') {
        const review = await store.get(
          `audits/${fence.auditId}/revisions/${fence.revisionId}/adapterReviews/current`,
        );
        if (review) {
          const verified = await new AdapterVerification(store, clock).publish(
            job.ownerUid,
            fence,
            result.operationId,
          );
          await new ScientificQuestions(store, clock).prepare(
            job.ownerUid,
            fence,
          );
          const eligibility = await new ScientificEligibilityStage(
            store,
            clock,
          ).assess(job.ownerUid, fence);
          await stageIssue(
            job.ownerUid,
            fence,
            'scientific_plan_pending',
            'Adapter extraction matches the reference under your declarations. Scientific eligibility was assessed; unresolved requirements and execution planning remain.',
          );
          return {
            ...result,
            adapterVerification: verified.status,
            eligibilityDigest: eligibility.assessmentDigest,
          };
        }
      }
      await stageIssue(
        job.ownerUid,
        fence,
        result.status === 'published'
          ? 'adapter_fidelity_review_pending'
          : 'comparison_reconciliation_required',
        result.status === 'published'
          ? 'Baseline comparison has been saved. The runs used different extraction profiles; a match does not prove that the selected variables are scientifically correct. Adapter fidelity review and scientific checks are still pending.'
          : 'Baseline comparison needs cleanup or execution reconciliation.',
      );
      return result;
    } catch {
      await stageIssue(
        job.ownerUid,
        fence,
        'comparison_unavailable',
        'Baseline comparison requires service verification or reconciliation. Existing evidence has been preserved.',
      );
      return {
        status: 'blocked' as const,
        code: 'comparison_unavailable' as const,
      };
    }
  };
  const scientificJob = async (jobId: string, expected: unknown) => {
    const job = InspectionStageJob.parse(await store.get(`stageJobs/${jobId}`));
    const fence = DispatchFence.parse(expected);
    if (
      job.auditId !== fence.auditId ||
      job.revisionId !== fence.revisionId ||
      job.inputDigest !== fence.inputDigest ||
      job.status !== 'inspection_complete'
    )
      throw new Error('Scientific workflow job changed');
    return { job, fence };
  };
  const scientificEvaluateForJob = async (jobId: string, expected: unknown) => {
    const { job, fence } = await scientificJob(jobId, expected);
    const revision = await store.get(
      `audits/${fence.auditId}/revisions/${fence.revisionId}`,
    );
    if (
      revision?.stage === 'investigating' ||
      revision?.stage === 'reporting'
    ) {
      const stage = await store.get(
        `scientificBudgetStages/${fence.revisionId}`,
      );
      return {
        status: 'published' as const,
        fence,
        operationId: z.string().uuid().parse(stage?.operationId),
      };
    }
    const pipeline = new ConservationPipeline(
      new StoredObservationLoader(store, downloads),
      new ConservationExecutions(store, clock),
      client,
    );
    const result = await new ScientificEvaluationCoordinator(
      store,
      pipeline,
      clock,
    ).run(job.ownerUid, fence);
    return result;
  };
  const scientificReportForJob = async (
    jobId: string,
    expected: unknown,
    operationId: unknown,
  ) => {
    const { job, fence } = await scientificJob(jobId, expected);
    return new ScientificReportStage(store, clock).publish(
      job.ownerUid,
      fence,
      operationId,
    );
  };
  const scientificPdfForJob = async (jobId: string, expected: unknown) => {
    const { job, fence } = await scientificJob(jobId, expected);
    try {
      if (
        !environment.SIPHON_PRIVATE_KV &&
        typeof environment.SIPHON_ARTIFACTS?.put !== 'function'
      )
        throw new Error('Private PDF storage is unavailable');
      const objects = environment.SIPHON_PRIVATE_KV
        ? new KvArtifacts(environment.SIPHON_PRIVATE_KV, store, clock)
        : new R2UploadStore(
            environment.SIPHON_ARTIFACTS as UploadBucketBinding,
          );
      const pdf = await new ScientificPdfStage(
        store,
        jobs,
        new PdfPipeline(
          new ReportPdfPublications(store, objects, clock),
          client,
        ),
        clock,
      ).run(job.ownerUid, fence);
      if (pdf.status !== 'published')
        await stageIssue(
          job.ownerUid,
          fence,
          'pdf_reconciliation_required',
          'The structured report is available. PDF rendering needs cleanup or reconciliation.',
        );
      return { ...pdf, fence };
    } catch {
      await stageIssue(
        job.ownerUid,
        fence,
        'pdf_unavailable',
        'The structured report is available. PDF rendering needs service configuration or reconciliation.',
      );
      return { status: 'unavailable' as const, fence };
    }
  };
  const scientificFinishForJob = async (
    jobId: string,
    expected: unknown,
    operationId: unknown,
  ) => {
    const { job, fence } = await scientificJob(jobId, expected);
    try {
      return await new ScientificFinishStage(store, clock).finish(
        job.ownerUid,
        fence,
        operationId,
      );
    } catch {
      await stageIssue(
        job.ownerUid,
        fence,
        'completion_reconciliation_required',
        'The report and PDF are available. Completion is waiting for execution cleanup or reconciliation.',
      );
      return { status: 'completion_pending' as const, fence };
    }
  };
  return {
    coordinator,
    continueContext,
    adapterForJob,
    baselineForJob,
    validateBaselineForJob,
    compareBaselinesForJob,
    scientificEvaluateForJob,
    scientificReportForJob,
    scientificPdfForJob,
    scientificFinishForJob,
  };
}

export function createInspectionRuntime(
  environment: InspectionWorkflowEnvironment,
  transport: typeof fetch = fetch,
  provider?: SandboxControlPlane,
  clock: () => Date = () => new Date(),
) {
  return createInspectionServices(environment, transport, provider, clock)
    .coordinator;
}
