import { createApp } from './app.js';
import { WorkerConfiguration } from './worker-config.js';
import { FirestoreClient } from './firestore.js';
import { googleAccessTokenProvider } from './google-oauth.js';
import { firebaseCertificateResolver, verifyFirebaseIdentity } from './auth.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { AuditCommands } from './audit-commands.js';
import { RevisionRepository } from './revisions.js';
import { UploadRepository } from './uploads.js';
import { UploadContentService } from './upload-content.js';
import { ArtifactDownloadService } from './artifact-download.js';
import { ProgressRepository } from './progress.js';
import { FirestoreUserRateGate } from './rate-limit.js';
import { R2UploadStore, type UploadBucketBinding } from './r2-upload.js';
import { R2DownloadStore, type DownloadBucketBinding } from './r2-download.js';
import { sha256 } from './hashing.js';
import { ReportRepository, ReportDownloads } from './reports.js';
import { WorkspaceRepository } from './workspace.js';
import { HistoryRepository } from './history.js';
import { KvArtifacts, type KvArtifactBinding } from './kv-artifacts.js';
import { RunQueue } from './run-queue.js';
import {
  RunService,
  ResumeService,
  type InspectionWorkflowBinding,
} from './runs.js';
import { ContextAnswerResolver } from './context-answers.js';
import { StartAudit } from '@siphon/contracts';
import { RedisRateFilter } from './redis-rate-filter.js';

export interface WorkerEnvironment {
  SIPHON_API_ENABLED: string;
  FIREBASE_PROJECT_ID: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
  SIPHON_ALLOWED_ORIGINS: string;
  SIPHON_ARTIFACTS?: UploadBucketBinding & DownloadBucketBinding;
  SIPHON_PRIVATE_KV?: KvArtifactBinding;
  SIPHON_INSPECTION_WORKFLOW_ENABLED?: string;
  SIPHON_REDIS_RATE_FILTER_ENABLED?: string;
  SIPHON_REDIS_REST_URL?: string;
  SIPHON_REDIS_REST_TOKEN?: string;
  SIPHON_INSPECTION?: InspectionWorkflowBinding;
  SIPHON_EDGE_LIMITER: {
    limit(input: { key: string }): Promise<{ success: boolean }>;
  };
}

/** No permissive local fallback. Credential/binding errors expose no values. */
export function createWorkerRuntime(
  environment: WorkerEnvironment,
  transport: typeof fetch = fetch,
) {
  const config = WorkerConfiguration.parse(environment);
  if (
    (!(
      environment.SIPHON_PRIVATE_KV &&
      typeof environment.SIPHON_PRIVATE_KV.put === 'function' &&
      typeof environment.SIPHON_PRIVATE_KV.get === 'function'
    ) &&
      !(
        environment.SIPHON_ARTIFACTS &&
        typeof environment.SIPHON_ARTIFACTS.put === 'function' &&
        typeof environment.SIPHON_ARTIFACTS.get === 'function'
      )) ||
    typeof environment.SIPHON_EDGE_LIMITER?.limit !== 'function'
  )
    throw new Error('Required Worker bindings are unavailable');
  const token = googleAccessTokenProvider(
    {
      projectId: config.FIREBASE_PROJECT_ID,
      clientEmail: config.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      privateKey: config.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    },
    transport,
  );
  const store = new FirestoreClient(
    config.FIREBASE_PROJECT_ID,
    token,
    transport,
  );
  const certificates = firebaseCertificateResolver(transport);
  const objects = environment.SIPHON_PRIVATE_KV
    ? new KvArtifacts(environment.SIPHON_PRIVATE_KV, store)
    : null;
  const downloads = new ArtifactDownloadService(
    store,
    objects ?? new R2DownloadStore(environment.SIPHON_ARTIFACTS!),
  );
  const reports = new ReportRepository(store);
  return createApp({
    resumes: new ResumeService(
      store,
      environment.SIPHON_INSPECTION,
      environment.SIPHON_INSPECTION_WORKFLOW_ENABLED === 'true',
    ),
    runs: new RunService(
      new RunQueue(store),
      environment.SIPHON_INSPECTION,
      environment.SIPHON_INSPECTION_WORKFLOW_ENABLED === 'true',
      async (uid, auditId, revisionId, value) => {
        const input = StartAudit.parse(value),
          revision = await store.get(
            `audits/${auditId}/revisions/${revisionId}`,
          );
        if (
          revision?.ownerUid === uid &&
          revision.status === 'idle' &&
          revision.answeredQuestionSetDigest !== undefined
        )
          await new ContextAnswerResolver(store).resolve(uid, {
            auditId,
            revisionId,
            generation: input.expectedGeneration,
            inputDigest: input.expectedInputDigest,
          });
      },
    ),
    workspace: new WorkspaceRepository(store),
    history: new HistoryRepository(store, store),
    reports,
    reportDownloads: new ReportDownloads(reports, downloads),
    verifyIdentity: (value) =>
      verifyFirebaseIdentity(value, config.FIREBASE_PROJECT_ID, certificates),
    repository: new FirestoreAuditRepository(store),
    commands: new AuditCommands(store),
    revisions: new RevisionRepository(store),
    uploads: new UploadRepository(store),
    uploadContent: new UploadContentService(
      store,
      objects ?? new R2UploadStore(environment.SIPHON_ARTIFACTS!),
    ),
    downloads,
    progress: new ProgressRepository(store),
    userRateGate:
      environment.SIPHON_REDIS_RATE_FILTER_ENABLED === 'true'
        ? new RedisRateFilter(
            environment.SIPHON_REDIS_REST_URL ?? '',
            environment.SIPHON_REDIS_REST_TOKEN ?? '',
            new FirestoreUserRateGate(store),
            transport,
          )
        : new FirestoreUserRateGate(store),
    allowedOrigins: config.SIPHON_ALLOWED_ORIGINS,
    edgeRateGate: async (request) => {
      // Cloudflare supplies this header at ingress. Missing ingress identity
      // shares one bucket rather than accepting a spoofable forwarded header.
      const ip = request.headers.get('CF-Connecting-IP');
      const key =
        ip && ip.length <= 64 && /^[0-9a-fA-F:.]+$/.test(ip)
          ? await sha256(ip)
          : 'unknown-ingress';
      return (
        (
          await environment.SIPHON_EDGE_LIMITER.limit({
            key: `siphon-edge-v1:${key}`,
          })
        ).success === true
      );
    },
  });
}

function unavailable() {
  const requestId = crypto.randomUUID();
  return Response.json(
    {
      error: {
        code: 'service_unavailable',
        message: 'The service is not configured for requests.',
        requestId,
        retryable: true,
      },
    },
    {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Request-Id': requestId,
      },
    },
  );
}

// Reuse only the services/certificate/OAuth caches for the exact binding object;
// invitations, ownership and budgets are rechecked by their repositories.
const runtimes = new WeakMap<
  WorkerEnvironment,
  ReturnType<typeof createWorkerRuntime>
>();
export default {
  async fetch(
    request: Request,
    environment: WorkerEnvironment,
  ): Promise<Response> {
    if (environment.SIPHON_API_ENABLED !== 'true') return unavailable();
    try {
      let runtime = runtimes.get(environment);
      if (!runtime) {
        runtime = createWorkerRuntime(environment);
        runtimes.set(environment, runtime);
      }
      return await runtime.fetch(request);
    } catch {
      return unavailable();
    }
  },
};
