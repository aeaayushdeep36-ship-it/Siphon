import { Hono } from 'hono';
import {
  CreateAudit,
  CreateRevision,
  Id,
  ReserveUpload,
  SubmitAnswers,
  StartAudit,
} from '@siphon/contracts';
import { type UploadRepository } from './uploads.js';
import { parseRequestJson } from './request-json.js';
import { type UploadContentService } from './upload-content.js';
import { type RevisionRepository } from './revisions.js';
import { type Identity, IdentityError } from './auth.js';
import { type AuditRepository } from './audit-repository.js';
import { ApiError } from './errors.js';
import { FirestoreFailure } from './firestore.js';
import { readJsonBounded } from './http.js';
import { type UserRateGate } from './rate-limit.js';
import { type AuditCommands } from './audit-commands.js';
import { type ArtifactDownloadService } from './artifact-download.js';
import { type ProgressRepository } from './progress.js';
import { type ReportRepository, type ReportDownloads } from './reports.js';
import {
  SubmitAdapterReview,
  ContinueAdapterReview,
  SubmitScientificAnswer,
  type WorkspaceRepository,
} from './workspace.js';
import { type HistoryRepository } from './history.js';
import { type RunService, type ResumeService } from './runs.js';
import { SubmitHeatParameters } from './scientific-parameters.js';

export interface ApiDependencies {
  runs: Pick<RunService, 'start'>;
  resumes: Pick<ResumeService, 'resume'> &
    Partial<Pick<ResumeService, 'resumeScientific'>>;
  workspace: Pick<WorkspaceRepository, 'get'> &
    Partial<
      Pick<
        WorkspaceRepository,
        | 'submitAdapterReview'
        | 'submitScientificAnswer'
        | 'continueAdapterReview'
        | 'prepareScientificPlan'
        | 'submitHeatParameters'
      >
    >;
  history: Pick<HistoryRepository, 'list'>;
  reports: Pick<ReportRepository, 'get'>;
  reportDownloads: Pick<ReportDownloads, 'getPdf'>;
  progress: Pick<ProgressRepository, 'get'>;
  verifyIdentity(token: string): Promise<Identity>;
  repository: AuditRepository;
  commands: Pick<AuditCommands, 'cancel' | 'remove'>;
  revisions: Pick<
    RevisionRepository,
    'create' | 'getQuestions' | 'submitAnswers'
  >;
  uploads: Pick<UploadRepository, 'reserve'>;
  uploadContent: Pick<UploadContentService, 'put'>;
  downloads: Pick<ArtifactDownloadService, 'get'>;
  userRateGate: UserRateGate;
  // Hosting must supply an edge gate before token verification/Firestore work.
  edgeRateGate(request: Request): Promise<boolean>;
  allowedOrigins: readonly string[];
}

/** Error text can contain caller data; map only exact internal invariants to
 * fixed labels suitable for server-side correlation. */
function internalFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return 'non_error_throw';
  switch (error.message) {
    case 'History document identity mismatch':
      return 'history_document_identity';
    case 'History owner/scope mismatch':
      return 'history_owner_scope';
    case 'Invalid history request':
      return 'history_request_invalid';
    case 'Invalid history scope':
      return 'history_scope_invalid';
    default:
      return 'unclassified';
  }
}

export function createApp(deps: ApiDependencies) {
  const app = new Hono<{
    Variables: { requestId: string; identity: Identity };
  }>();
  app.use('*', async (c, next) => {
    c.set('requestId', crypto.randomUUID());
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Request-Id', c.get('requestId'));
    if (!(await deps.edgeRateGate(c.req.raw)))
      throw new ApiError(429, 'rate_limited', 'Request limit reached.', true);
    const origin = c.req.header('Origin');
    if (origin) {
      if (!deps.allowedOrigins.includes(origin))
        throw new ApiError(403, 'origin_denied', 'Origin is not allowed.');
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
      c.header(
        'Access-Control-Expose-Headers',
        'X-Request-Id, X-Content-SHA256, Content-Disposition',
      );
    }
    if (c.req.method === 'OPTIONS') {
      c.header(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, DELETE, OPTIONS',
      );
      c.header(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, Idempotency-Key, X-Content-SHA256',
      );
      return c.body(null, 204);
    }
    await next();
  });
  app.use('/api/v1/*', async (c, next) => {
    const authorization = c.req.header('Authorization');
    const match = /^Bearer ([^\s]+)$/.exec(authorization ?? '');
    if (!match?.[1])
      throw new ApiError(401, 'invalid_credentials', 'Sign in to continue.');
    let phase = 'identity_verification';
    try {
      const identity = await deps.verifyIdentity(match[1]);
      c.set('identity', identity);
      phase = 'user_rate_gate';
      await deps.userRateGate.consume(
        identity.uid,
        !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method),
      );
      phase = 'invitation_check';
      if (!(await deps.repository.isInvited(identity.uid)))
        throw new ApiError(
          403,
          'invitation_required',
          'An active invitation is required.',
        );
    } catch (error) {
      if (
        !(error instanceof ApiError) &&
        !(error instanceof IdentityError) &&
        !(error instanceof FirestoreFailure)
      )
        console.error('siphon_auth_phase_error', {
          requestId: c.get('requestId'),
          phase,
          errorType:
            error instanceof Error ? error.constructor.name : typeof error,
        });
      throw error;
    }
    await next();
  });
  app.post('/api/v1/audits', async (c) => {
    const key = c.req.header('Idempotency-Key');
    if (!key || !/^[\x21-\x7e]{1,128}$/.test(key))
      throw new ApiError(
        422,
        'invalid_idempotency_key',
        'Provide a valid Idempotency-Key.',
      );
    if (
      c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
    )
      throw new ApiError(
        422,
        'invalid_content_type',
        'Expected application/json.',
      );
    let input: unknown;
    try {
      input = await readJsonBounded(new Response(c.req.raw.body), 16 * 1024);
    } catch (error) {
      if (error instanceof Error && error.message === 'Body exceeds limit')
        throw new ApiError(
          413,
          'body_too_large',
          'Request body exceeds the limit.',
        );
      throw new ApiError(422, 'invalid_json', 'Provide a valid JSON request.');
    }
    const parsed = CreateAudit.safeParse(input);
    if (!parsed.success)
      throw new ApiError(
        422,
        'invalid_input',
        'Request does not match the supported contract.',
      );
    const result = await deps.repository.create(
      c.get('identity').uid,
      parsed.data,
      key,
    );
    return c.json(
      { schemaVersion: '1.0', audit: result.audit },
      result.replayed ? 200 : 201,
    );
  });
  app.post('/api/v1/audits/:auditId/revisions/:revisionId/run', async (c) => {
    const auditId = Id.safeParse(c.req.param('auditId')),
      revisionId = Id.safeParse(c.req.param('revisionId'));
    if (!auditId.success || !revisionId.success)
      throw new ApiError(404, 'not_found', 'Revision was not found.');
    const key = c.req.header('Idempotency-Key');
    if (!key)
      throw new ApiError(
        422,
        'invalid_idempotency_key',
        'Provide a valid Idempotency-Key.',
      );
    const value = await parseRequestJson(c.req.raw, StartAudit);
    const result = await deps.runs.start(
      c.get('identity').uid,
      auditId.data,
      revisionId.data,
      value,
      key,
    );
    return c.json(result.receipt, 202);
  });
  app.get('/api/v1/audits', async (c) =>
    c.json(
      await deps.history.list(
        c.get('identity').uid,
        null,
        c.req.query('limit'),
        c.req.query('cursor'),
      ),
    ),
  );
  app.post(
    '/api/v1/audits/:auditId/revisions/:revisionId/scientific-run',
    async (c) => {
      const auditId = Id.parse(c.req.param('auditId')),
        revisionId = Id.parse(c.req.param('revisionId'));
      const key = c.req.header('Idempotency-Key');
      if (!key)
        throw new ApiError(
          422,
          'invalid_idempotency_key',
          'Provide a valid Idempotency-Key.',
        );
      if (!deps.resumes.resumeScientific)
        throw new ApiError(
          503,
          'audit_execution_unavailable',
          'Audit execution is not configured yet.',
        );
      return c.json(
        await deps.resumes.resumeScientific(
          c.get('identity').uid,
          auditId,
          revisionId,
          await parseRequestJson(c.req.raw, StartAudit),
          key,
        ),
        202,
      );
    },
  );
  app.post(
    '/api/v1/audits/:auditId/revisions/:revisionId/resume',
    async (c) => {
      const auditId = Id.safeParse(c.req.param('auditId')),
        revisionId = Id.safeParse(c.req.param('revisionId'));
      if (!auditId.success || !revisionId.success)
        throw new ApiError(404, 'not_found', 'Revision was not found.');
      const key = c.req.header('Idempotency-Key');
      if (!key)
        throw new ApiError(
          422,
          'invalid_idempotency_key',
          'Provide a valid Idempotency-Key.',
        );
      return c.json(
        await deps.resumes.resume(
          c.get('identity').uid,
          auditId.data,
          revisionId.data,
          await parseRequestJson(c.req.raw, StartAudit),
          key,
        ),
        202,
      );
    },
  );
  app.get('/api/v1/audits/:auditId/revisions', async (c) => {
    const auditId = Id.safeParse(c.req.param('auditId'));
    if (!auditId.success)
      throw new ApiError(404, 'not_found', 'Audit was not found.');
    return c.json(
      await deps.history.list(
        c.get('identity').uid,
        auditId.data,
        c.req.query('limit'),
        c.req.query('cursor'),
      ),
    );
  });
  app.get(
    '/api/v1/audits/:auditId/revisions/:revisionId/workspace',
    async (c) => {
      const auditId = Id.safeParse(c.req.param('auditId')),
        revisionId = Id.safeParse(c.req.param('revisionId'));
      if (!auditId.success || !revisionId.success)
        throw new ApiError(404, 'not_found', 'Revision was not found.');
      return c.json(
        await deps.workspace.get(
          c.get('identity').uid,
          auditId.data,
          revisionId.data,
        ),
      );
    },
  );
  app.get('/api/v1/audits/:auditId', async (c) => {
    const id = Id.safeParse(c.req.param('auditId'));
    if (!id.success)
      throw new ApiError(404, 'not_found', 'Audit was not found.');
    return c.json({
      schemaVersion: '1.0',
      audit: await deps.repository.getOwned(c.get('identity').uid, id.data),
    });
  });
  app.get('/api/v1/audits/:auditId/revisions/:revisionId/report', async (c) => {
    const auditId = Id.safeParse(c.req.param('auditId'));
    const revisionId = Id.safeParse(c.req.param('revisionId'));
    if (!auditId.success || !revisionId.success)
      throw new ApiError(404, 'not_found', 'Report was not found.');
    return c.json(
      await deps.reports.get(
        c.get('identity').uid,
        auditId.data,
        revisionId.data,
      ),
    );
  });
  app.get(
    '/api/v1/audits/:auditId/revisions/:revisionId/report.pdf',
    async (c) => {
      const auditId = Id.safeParse(c.req.param('auditId'));
      const revisionId = Id.safeParse(c.req.param('revisionId'));
      if (!auditId.success || !revisionId.success)
        throw new ApiError(404, 'not_found', 'Report was not found.');
      return deps.reportDownloads.getPdf(
        c.get('identity').uid,
        auditId.data,
        revisionId.data,
        c.req.raw,
      );
    },
  );
  app.get(
    '/api/v1/audits/:auditId/revisions/:revisionId/progress',
    async (c) => {
      const auditId = Id.safeParse(c.req.param('auditId'));
      const revisionId = Id.safeParse(c.req.param('revisionId'));
      if (!auditId.success || !revisionId.success)
        throw new ApiError(404, 'not_found', 'Revision was not found.');
      return c.json(
        await deps.progress.get(
          c.get('identity').uid,
          auditId.data,
          revisionId.data,
        ),
      );
    },
  );
  app.post(
    '/api/v1/audits/:auditId/revisions/:revisionId/cancel',
    async (c) => {
      const auditId = Id.safeParse(c.req.param('auditId'));
      const revisionId = Id.safeParse(c.req.param('revisionId'));
      if (!auditId.success || !revisionId.success)
        throw new ApiError(404, 'not_found', 'Revision was not found.');
      const key = c.req.header('Idempotency-Key');
      if (!key)
        throw new ApiError(
          422,
          'invalid_idempotency_key',
          'Provide a valid Idempotency-Key.',
        );
      const result = await deps.commands.cancel(
        c.get('identity').uid,
        auditId.data,
        revisionId.data,
        key,
      );
      return c.json(result, result.cleanup === 'confirmed' ? 200 : 202);
    },
  );
  app.delete('/api/v1/audits/:auditId', async (c) => {
    const auditId = Id.safeParse(c.req.param('auditId'));
    if (!auditId.success)
      throw new ApiError(404, 'not_found', 'Audit was not found.');
    const key = c.req.header('Idempotency-Key');
    if (!key)
      throw new ApiError(
        422,
        'invalid_idempotency_key',
        'Provide a valid Idempotency-Key.',
      );
    const result = await deps.commands.remove(
      c.get('identity').uid,
      auditId.data,
      key,
    );
    return c.json(result, result.cleanup === 'confirmed' ? 200 : 202);
  });
  app.post('/api/v1/audits/:auditId/revisions', async (c) => {
    const auditId = Id.safeParse(c.req.param('auditId'));
    if (!auditId.success)
      throw new ApiError(404, 'not_found', 'Audit was not found.');
    const key = c.req.header('Idempotency-Key');
    if (!key)
      throw new ApiError(
        422,
        'invalid_idempotency_key',
        'Provide a valid Idempotency-Key.',
      );
    if (
      c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
    )
      throw new ApiError(
        422,
        'invalid_content_type',
        'Expected application/json.',
      );
    let input: unknown;
    try {
      input = await readJsonBounded(new Response(c.req.raw.body), 16 * 1024);
    } catch (error) {
      if (error instanceof Error && error.message === 'Body exceeds limit')
        throw new ApiError(
          413,
          'body_too_large',
          'Request body exceeds the limit.',
        );
      throw new ApiError(422, 'invalid_json', 'Provide a valid JSON request.');
    }
    const parsed = CreateRevision.safeParse(input);
    if (!parsed.success)
      throw new ApiError(
        422,
        'invalid_input',
        'Request does not match the supported contract.',
      );
    const result = await deps.revisions.create(
      c.get('identity').uid,
      auditId.data,
      parsed.data,
      key,
    );
    return c.json(result.receipt, result.replayed ? 200 : 201);
  });
  app.post(
    '/api/v1/audits/:auditId/revisions/:revisionId/artifacts',
    async (c) => {
      const auditId = Id.safeParse(c.req.param('auditId'));
      const revisionId = Id.safeParse(c.req.param('revisionId'));
      if (!auditId.success || !revisionId.success)
        throw new ApiError(404, 'not_found', 'Revision was not found.');
      const key = c.req.header('Idempotency-Key');
      if (!key)
        throw new ApiError(
          422,
          'invalid_idempotency_key',
          'Provide a valid Idempotency-Key.',
        );
      const input = await parseRequestJson(c.req.raw, ReserveUpload);
      const result = await deps.uploads.reserve(
        c.get('identity').uid,
        auditId.data,
        revisionId.data,
        input,
        key,
      );
      return c.json(result.reservation, result.replayed ? 200 : 201);
    },
  );
  app.put(
    '/api/v1/audits/:auditId/revisions/:revisionId/artifacts/:artifactId/content',
    async (c) => {
      const ids = [
        c.req.param('auditId'),
        c.req.param('revisionId'),
        c.req.param('artifactId'),
      ].map((id) => Id.safeParse(id));
      if (ids.some((id) => !id.success))
        throw new ApiError(404, 'not_found', 'Upload was not found.');
      return c.json(
        await deps.uploadContent.put(
          c.get('identity').uid,
          c.req.param('auditId'),
          c.req.param('revisionId'),
          c.req.param('artifactId'),
          c.req.raw,
        ),
      );
    },
  );
  app.get('/api/v1/audits/:auditId/artifacts/:artifactId', async (c) => {
    const auditId = Id.safeParse(c.req.param('auditId'));
    const artifactId = Id.safeParse(c.req.param('artifactId'));
    if (!auditId.success || !artifactId.success)
      throw new ApiError(404, 'not_found', 'Artifact was not found.');
    return deps.downloads.get(
      c.get('identity').uid,
      auditId.data,
      artifactId.data,
      c.req.raw,
    );
  });
  app.get(
    '/api/v1/audits/:auditId/revisions/:revisionId/questions',
    async (c) => {
      const auditId = Id.safeParse(c.req.param('auditId'));
      const revisionId = Id.safeParse(c.req.param('revisionId'));
      if (!auditId.success || !revisionId.success)
        throw new ApiError(404, 'not_found', 'Questions were not found.');
      return c.json(
        await deps.revisions.getQuestions(
          c.get('identity').uid,
          auditId.data,
          revisionId.data,
        ),
      );
    },
  );
  app.post(
    '/api/v1/audits/:auditId/revisions/:revisionId/adapter-review',
    async (c) => {
      const auditId = Id.parse(c.req.param('auditId')),
        revisionId = Id.parse(c.req.param('revisionId'));
      if (!deps.workspace.submitAdapterReview)
        throw new ApiError(
          503,
          'service_unavailable',
          'Adapter review is unavailable.',
        );
      const input = await parseRequestJson(c.req.raw, SubmitAdapterReview);
      const result = await deps.workspace.submitAdapterReview(
        c.get('identity').uid,
        auditId,
        revisionId,
        input,
      );
      return c.json(result, result.replayed ? 200 : 201);
    },
  );
  app.post(
    '/api/v1/audits/:auditId/revisions/:revisionId/adapter-review/continue',
    async (c) => {
      const auditId = Id.parse(c.req.param('auditId')),
        revisionId = Id.parse(c.req.param('revisionId'));
      if (!deps.workspace.continueAdapterReview)
        throw new ApiError(
          503,
          'service_unavailable',
          'Adapter continuation is unavailable.',
        );
      const input = await parseRequestJson(c.req.raw, ContinueAdapterReview);
      return c.json(
        await deps.workspace.continueAdapterReview(
          c.get('identity').uid,
          auditId,
          revisionId,
          input,
        ),
      );
    },
  );
  app.post(
    '/api/v1/audits/:auditId/revisions/:revisionId/scientific-plan',
    async (c) => {
      const auditId = Id.parse(c.req.param('auditId')),
        revisionId = Id.parse(c.req.param('revisionId'));
      if (!deps.workspace.prepareScientificPlan)
        throw new ApiError(
          503,
          'service_unavailable',
          'Scientific planning is unavailable.',
        );
      const input = await parseRequestJson(c.req.raw, ContinueAdapterReview);
      const result = await deps.workspace.prepareScientificPlan(
        c.get('identity').uid,
        auditId,
        revisionId,
        input,
      );
      return c.json(result, result.replayed ? 200 : 201);
    },
  );
  app.post(
    '/api/v1/audits/:auditId/revisions/:revisionId/heat-parameters',
    async (c) => {
      const auditId = Id.parse(c.req.param('auditId')),
        revisionId = Id.parse(c.req.param('revisionId'));
      if (!deps.workspace.submitHeatParameters)
        throw new ApiError(
          503,
          'service_unavailable',
          'Heat parameters are unavailable.',
        );
      const input = await parseRequestJson(c.req.raw, SubmitHeatParameters);
      const result = await deps.workspace.submitHeatParameters(
        c.get('identity').uid,
        auditId,
        revisionId,
        input,
      );
      return c.json(result, result.replayed ? 200 : 201);
    },
  );
  app.post(
    '/api/v1/audits/:auditId/revisions/:revisionId/scientific-answer',
    async (c) => {
      const auditId = Id.safeParse(c.req.param('auditId')),
        revisionId = Id.safeParse(c.req.param('revisionId'));
      if (!auditId.success || !revisionId.success)
        throw new ApiError(404, 'not_found', 'Revision was not found.');
      if (!deps.workspace.submitScientificAnswer)
        throw new ApiError(
          503,
          'service_unavailable',
          'Scientific questions are unavailable.',
        );
      const input = await parseRequestJson(c.req.raw, SubmitScientificAnswer);
      const result = await deps.workspace.submitScientificAnswer(
        c.get('identity').uid,
        auditId.data,
        revisionId.data,
        input,
      );
      return c.json(
        { schemaVersion: '1.0', ...result },
        result.replayed ? 200 : 201,
      );
    },
  );
  app.post(
    '/api/v1/audits/:auditId/revisions/:revisionId/answers',
    async (c) => {
      const auditId = Id.safeParse(c.req.param('auditId'));
      const revisionId = Id.safeParse(c.req.param('revisionId'));
      if (!auditId.success || !revisionId.success)
        throw new ApiError(404, 'not_found', 'Revision was not found.');
      const key = c.req.header('Idempotency-Key');
      if (!key)
        throw new ApiError(
          422,
          'invalid_idempotency_key',
          'Provide a valid Idempotency-Key.',
        );
      const input = await parseRequestJson(c.req.raw, SubmitAnswers);
      const result = await deps.revisions.submitAnswers(
        c.get('identity').uid,
        auditId.data,
        revisionId.data,
        input,
        key,
      );
      return c.json(result.receipt, result.replayed ? 200 : 201);
    },
  );
  app.notFound(() => {
    throw new ApiError(404, 'not_found', 'Resource was not found.');
  });
  app.onError((error, c) => {
    if (
      !(error instanceof ApiError) &&
      !(error instanceof IdentityError) &&
      !(error instanceof FirestoreFailure)
    ) {
      // Correlate unexpected server failures without logging request bodies,
      // provider responses, credentials, error messages, or stack contents.
      console.error('siphon_api_unhandled_error', {
        requestId: c.get('requestId'),
        failureCode: internalFailureCode(error),
        errorType:
          error instanceof Error ? error.constructor.name : typeof error,
      });
    }
    const normalized =
      error instanceof ApiError
        ? error
        : error instanceof IdentityError
          ? new ApiError(
              error.code === 'invalid_credentials' ? 401 : 503,
              error.code,
              error.code === 'invalid_credentials'
                ? 'Sign in to continue.'
                : 'Identity verification is unavailable.',
              error.code === 'identity_unavailable',
            )
          : error instanceof FirestoreFailure
            ? new ApiError(
                503,
                error.ambiguousCommit
                  ? 'commit_unknown'
                  : 'storage_unavailable',
                error.ambiguousCommit
                  ? 'The operation outcome is not yet known. Retry only with the same Idempotency-Key.'
                  : 'Storage is temporarily unavailable.',
                !error.ambiguousCommit,
              )
            : new ApiError(
                503,
                'service_unavailable',
                'The service could not complete this request.',
                true,
              );
    return c.json(
      {
        error: {
          code: normalized.code,
          message: normalized.message,
          requestId: c.get('requestId'),
          retryable: normalized.retryable,
        },
      },
      normalized.status,
    );
  });
  return app;
}
