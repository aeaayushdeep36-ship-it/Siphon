import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { FirestoreUserRateGate } from './rate-limit.js';
import { IdentityError } from './auth.js';
import { TestDocuments } from '../test/document-store.js';
import { AuditCommands } from './audit-commands.js';
import { RevisionRepository } from './revisions.js';
import { UploadRepository } from './uploads.js';
import { UploadContentService } from './upload-content.js';
import { ArtifactDownloadService } from './artifact-download.js';
import { ProgressRepository } from './progress.js';
import { ReportRepository, ReportDownloads } from './reports.js';
import { authoredReport } from '../test/report-fixture.js';
import { canonicalJson, sha256 } from './hashing.js';
import { WorkspaceRepository } from './workspace.js';
import { HistoryRepository } from './history.js';
import { RunService, ResumeService } from './runs.js';
import { RunQueue } from './run-queue.js';
import { FirestoreFailure } from './firestore.js';

const requestBody = {
  schemaVersion: '1.0',
  title: 'Orbit investigation',
  domain: 'orbital_dynamics',
};
function setup() {
  const documents = new TestDocuments();
  documents.documents.set('testers/alice', { active: true });
  documents.documents.set('testers/bob', { active: true });
  const repository = new FirestoreAuditRepository(documents);
  const rateGate = new FirestoreUserRateGate(documents);
  let edgeAllowed = true;
  const reports = new ReportRepository(
    documents,
    () => new Date('2026-10-29T01:00:00.000Z'),
  );
  const app = createApp({
    resumes: new ResumeService(documents, undefined, false),
    runs: new RunService(new RunQueue(documents), undefined, false),
    workspace: new WorkspaceRepository(documents),
    history: new HistoryRepository(documents, {
      history: async () => {
        throw new Error('Unexpected history test call');
      },
    }),
    reports,
    reportDownloads: new ReportDownloads(reports, {
      get: async () => {
        throw new Error('Unexpected authored PDF request');
      },
    }),
    progress: new ProgressRepository(documents),
    downloads: new ArtifactDownloadService(documents, {
      get: async () => ({
        size: 5,
        sha256: 'a'.repeat(64),
        body: new Response('hello').body!,
      }),
    }),
    commands: new AuditCommands(documents),
    revisions: new RevisionRepository(documents),
    uploads: new UploadRepository(documents),
    uploadContent: new UploadContentService(documents, {
      putOnce: async (_key, bytes, sha256) => ({ size: bytes.length, sha256 }),
    }),
    repository,
    userRateGate: rateGate,
    allowedOrigins: ['https://siphon.example'],
    edgeRateGate: async () => edgeAllowed,
    verifyIdentity: async (token) => {
      if (!['alice', 'bob', 'uninvited'].includes(token))
        throw new IdentityError('invalid_credentials');
      return { uid: token, authTime: 1 };
    },
  });
  const create = (
    key = 'request-key',
    body: unknown = requestBody,
    user = 'alice',
  ) =>
    app.request('/api/v1/audits', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${user}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    });
  return {
    app,
    documents,
    repository,
    create,
    blockEdge: () => {
      edgeAllowed = false;
    },
  };
}

describe('private audit HTTP integration (local ports)', () => {
  it('routes planning only through authenticated validated requests', async () => {
    const f = setup();
    const auditId = crypto.randomUUID(),
      revisionId = crypto.randomUUID();
    const spy = vi
      .spyOn(WorkspaceRepository.prototype, 'prepareScientificPlan')
      .mockResolvedValue({
        schemaVersion: '1.0',
        planDigest: 'a'.repeat(64),
        replayed: false,
      });
    try {
      const path = `/api/v1/audits/${auditId}/revisions/${revisionId}/scientific-plan`;
      const body = {
        schemaVersion: '1.0',
        expectedGeneration: 1,
        expectedInputDigest: 'b'.repeat(64),
      };
      const unauthenticated = await f.app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(unauthenticated.status).toBe(401);
      expect(spy).not.toHaveBeenCalled();
      const response = await f.app.request(path, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer alice',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(201);
      expect(spy).toHaveBeenCalledWith('alice', auditId, revisionId, body);
      const invalid = await f.app.request(path, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer alice',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...body, unexpected: true }),
      });
      expect(invalid.status).toBe(422);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
  it('serves the exact owner report and explicit PDF-not-ready state through authenticated rate-limited routes', async () => {
    const f = setup();
    const { audit } = await f.repository.create(
      'alice',
      { ...requestBody, schemaVersion: '1.0', domain: 'heat_diffusion' },
      'report',
    );
    const report = authoredReport();
    report.auditId = audit.id;
    report.revisionId = audit.currentRevisionId;
    for (const metric of report.metrics) {
      metric.auditId = report.auditId;
      metric.revisionId = report.revisionId;
    }
    const revisionPath = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
    Object.assign(f.documents.documents.get(revisionPath)!, {
      inputDigest: report.inputDigest,
      reportId: report.reportId,
    });
    const reportJson = canonicalJson(report),
      reportDigest = await sha256(reportJson);
    f.documents.documents.set(`${revisionPath}/reports/${report.reportId}`, {
      schemaVersion: '1.0',
      reportId: report.reportId,
      ownerUid: 'alice',
      auditId: audit.id,
      revisionId: audit.currentRevisionId,
      inputDigest: report.inputDigest,
      reportDigest,
      reportJson,
      createdAt: report.createdAt,
      expiresAt: report.expiresAt,
    });
    const route = `/api/v1/audits/${audit.id}/revisions/${audit.currentRevisionId}/report`;
    const result = await f.app.request(route, {
      headers: {
        Authorization: 'Bearer alice',
        Origin: 'https://siphon.example',
      },
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      schemaVersion: '1.0',
      report,
      reportDigest,
      pdf: { status: 'not_ready' },
      retention: {
        checkedAt: '2026-10-29T01:00:00.000Z',
        expiredEvidenceIds: [],
        expiredArtifactIds: [],
      },
    });
    expect(result.headers.get('Cache-Control')).toContain('no-store');
    expect(result.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://siphon.example',
    );
    const pdf = await f.app.request(`${route}.pdf`, {
      headers: { Authorization: 'Bearer alice' },
    });
    expect(pdf.status).toBe(409);
    expect(await pdf.json()).toMatchObject({
      error: { code: 'report_pdf_not_ready' },
    });
    expect((await f.app.request(route)).status).toBe(401);
    const denied = await f.app.request(route, {
      headers: { Authorization: 'Bearer bob' },
    });
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain(report.title);
  });
  it('serves authenticated progress without caching or exposing another owner', async () => {
    const { app, repository } = setup();
    const { audit } = await repository.create(
      'alice',
      {
        schemaVersion: '1.0',
        title: 'Progress',
        domain: 'heat_diffusion',
      },
      'progress',
    );
    const route = `/api/v1/audits/${audit.id}/revisions/${audit.currentRevisionId}/progress`;
    const response = await app.request(route, {
      headers: { Authorization: 'Bearer alice' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      stage: 'draft',
      status: 'idle',
      progress: null,
    });
    expect((await app.request(route)).status).toBe(401);
    expect(
      (await app.request(route, { headers: { Authorization: 'Bearer bob' } }))
        .status,
    ).toBe(404);
  });
  it('reads versioned questions and submits an answer through the private HTTP routes', async () => {
    const { app, documents, repository } = setup();
    const { audit } = await repository.create(
      'alice',
      {
        schemaVersion: '1.0',
        title: 'Clarification',
        domain: 'heat_diffusion',
      },
      'question-audit',
    );
    const path = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
    const revision = documents.documents.get(path)!;
    revision.stage = 'clarifying';
    revision.status = 'waiting_for_input';
    const questionId = crypto.randomUUID();
    documents.documents.set(`${path}/questions/current`, {
      questionSet: {
        schemaVersion: '1.0',
        auditId: audit.id,
        revisionId: audit.currentRevisionId,
        inputDigest: revision.inputDigest,
        questions: [
          {
            schemaVersion: '1.0',
            id: questionId,
            key: 'units',
            prompt: 'Which units?',
            reason: 'Needed for interpretation.',
            options: [
              { id: 'si', label: 'SI', unknown: false },
              { id: 'unknown', label: 'Unknown', unknown: true },
            ],
            customTextAllowed: true,
            requiredFacts: ['units'],
            affectedChecks: ['H_ENERGY'],
          },
        ],
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const route = `/api/v1/audits/${audit.id}/revisions/${audit.currentRevisionId}`;
    const questions = await app.request(`${route}/questions`, {
      headers: { Authorization: 'Bearer alice' },
    });
    expect(questions.status).toBe(200);
    const result = (await questions.json()) as { questionSetDigest: string };
    const answered = await app.request(`${route}/answers`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer alice',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'http-answer',
      },
      body: JSON.stringify({
        schemaVersion: '1.0',
        expectedGeneration: revision.generation,
        expectedInputDigest: revision.inputDigest,
        questionSetDigest: result.questionSetDigest,
        answers: [
          {
            schemaVersion: '1.0',
            questionId,
            selectedOptionId: 'unknown',
            customText: '',
          },
        ],
      }),
    });
    expect(answered.status).toBe(201);
    expect(await answered.json()).toMatchObject({
      parentRevisionId: audit.currentRevisionId,
      stage: 'draft',
      status: 'idle',
    });
  });
  it('serves artifacts only to their owner with attachment headers', async () => {
    const { app, documents, repository } = setup();
    const { audit } = await repository.create(
      'alice',
      { schemaVersion: '1.0', title: 'Download', domain: 'heat_diffusion' },
      'download-audit',
    );
    const artifactId = crypto.randomUUID();
    documents.documents.set(`audits/${audit.id}/artifacts/${artifactId}`, {
      ownerUid: 'alice',
      revisionId: audit.currentRevisionId,
      lifecycle: 'ready',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      bytes: 5,
      sha256: 'a'.repeat(64),
      objectKey: `audits/alice/${audit.id}/artifacts/${artifactId}/content`,
    });
    documents.documents.set('configuration/r2_class_b_period', {
      counterKey: 'download_period',
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 60_000).toISOString(),
    });
    documents.documents.set('budgets/download_period', {
      schemaVersion: '1.0',
      limit: 2,
      spent: 0,
      reserved: 0,
      halted: false,
    });
    const url = `/api/v1/audits/${audit.id}/artifacts/${artifactId}`;
    expect(
      (await app.request(url, { headers: { Authorization: 'Bearer bob' } }))
        .status,
    ).toBe(404);
    const response = await app.request(url, {
      headers: { Authorization: 'Bearer alice' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toContain(
      'attachment;',
    );
    expect(await response.text()).toBe('hello');
  });
  it('reserves uploads without reporting the file ready', async () => {
    const { app, create, documents } = setup();
    documents.documents.set('budgets/r2_storage_bytes', {
      schemaVersion: '1.0',
      limit: 10000,
      reserved: 0,
      spent: 0,
      halted: false,
    });
    const body = (await (await create()).json()) as {
      audit: { id: string; currentRevisionId: string };
    };
    const parent = documents.documents.get(
      `audits/${body.audit.id}/revisions/${body.audit.currentRevisionId}`,
    )!;
    const response = await app.request(
      `/api/v1/audits/${body.audit.id}/revisions/${body.audit.currentRevisionId}/artifacts`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer alice',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'upload',
        },
        body: JSON.stringify({
          schemaVersion: '1.0',
          path: 'heat.py',
          bytes: 100,
          sha256: 'a'.repeat(64),
          expectedGeneration: 0,
          expectedInputDigest: parent.inputDigest,
        }),
      },
    );
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result).toMatchObject({ lifecycle: 'reserved', path: 'heat.py' });
    expect(result).not.toHaveProperty('objectKey');
  });
  it('creates draft successors through the authenticated versioned HTTP contract', async () => {
    const { app, create, documents } = setup();
    const body = (await (await create()).json()) as {
      audit: { id: string; currentRevisionId: string };
    };
    const parent = documents.documents.get(
      `audits/${body.audit.id}/revisions/${body.audit.currentRevisionId}`,
    )!;
    const request = {
      method: 'POST',
      headers: {
        Authorization: 'Bearer alice',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'revision',
      },
      body: JSON.stringify({
        schemaVersion: '1.0',
        parentRevisionId: body.audit.currentRevisionId,
        expectedGeneration: parent.generation,
        expectedInputDigest: parent.inputDigest,
        reuseArtifactIds: [],
      }),
    };
    const path = `/api/v1/audits/${body.audit.id}/revisions`;
    const response = await app.request(path, request);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      stage: 'draft',
      status: 'idle',
      parentRevisionId: body.audit.currentRevisionId,
    });
    expect((await app.request(path, request)).status).toBe(200);
  });
  it('exposes cancellation as pending and deletion as immediate access revocation', async () => {
    const { app, create } = setup();
    const body = (await (await create()).json()) as {
      audit: { id: string; currentRevisionId: string };
    };
    const auditPath = `/api/v1/audits/${body.audit.id}`;
    const cancel = await app.request(
      `${auditPath}/revisions/${body.audit.currentRevisionId}/cancel`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer alice', 'Idempotency-Key': 'cancel' },
      },
    );
    expect(cancel.status).toBe(202);
    expect(await cancel.json()).toMatchObject({ cleanup: 'pending' });
    const deleted = await app.request(auditPath, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer alice', 'Idempotency-Key': 'delete' },
    });
    expect(deleted.status).toBe(202);
    expect(
      (
        await app.request(auditPath, {
          headers: { Authorization: 'Bearer alice' },
        })
      ).status,
    ).toBe(404);
  });
  it('creates a persisted draft and replays identical concurrent submissions once', async () => {
    const { create, documents } = setup();
    const responses = await Promise.all([create(), create()]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 201,
    ]);
    const first = await responses[0]!.json();
    const second = await responses[1]!.json();
    expect(first).toEqual(second);
    expect(
      [...documents.documents.keys()].filter((path) =>
        /^audits\/[^/]+$/.test(path),
      ),
    ).toHaveLength(1);
    expect(
      [...documents.documents.keys()].filter((path) =>
        path.includes('/revisions/'),
      ),
    ).toHaveLength(1);
  });
  it('rejects idempotency payload conflicts and prevents submitted ownership injection', async () => {
    const { create } = setup();
    expect((await create()).status).toBe(201);
    expect(
      (await create('request-key', { ...requestBody, title: 'Changed' }))
        .status,
    ).toBe(409);
    expect(
      (await create('other-key', { ...requestBody, ownerUid: 'bob' })).status,
    ).toBe(422);
  });
  it('allows the owner and hides the audit from other users and after deletion', async () => {
    const { app, create, documents } = setup();
    const body = (await (await create()).json()) as { audit: { id: string } };
    const path = `/api/v1/audits/${body.audit.id}`;
    const owner = await app.request(path, {
      headers: { Authorization: 'Bearer alice' },
    });
    expect(owner.status).toBe(200);
    expect(owner.headers.get('Cache-Control')).toBe('no-store');
    expect(
      (await app.request(path, { headers: { Authorization: 'Bearer bob' } }))
        .status,
    ).toBe(404);
    documents.documents.get(`audits/${body.audit.id}`)!.deletionRequestedAt =
      new Date().toISOString();
    expect(
      (await app.request(path, { headers: { Authorization: 'Bearer alice' } }))
        .status,
    ).toBe(404);
    expect((await create()).status).toBe(404);
  });
  it('fails closed on missing credentials, inactive invitations and disallowed origins', async () => {
    const { app, create, documents } = setup();
    expect((await app.request('/api/v1/audits')).status).toBe(401);
    expect((await create('key', requestBody, 'uninvited')).status).toBe(403);
    documents.documents.set('testers/alice', { active: false });
    expect((await create()).status).toBe(403);
    const origin = await app.request('/api/v1/audits', {
      method: 'OPTIONS',
      headers: { Origin: 'https://attacker.example' },
    });
    expect(origin.status).toBe(403);
    expect(origin.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
  it('does not touch authentication/storage when the edge gate rejects traffic', async () => {
    const { app, blockEdge, documents } = setup();
    blockEdge();
    const response = await app.request('/api/v1/audits', {
      headers: { Authorization: 'Bearer alice' },
    });
    expect(response.status).toBe(429);
    expect(
      [...documents.documents.keys()].some((key) =>
        key.startsWith('rateWindows/'),
      ),
    ).toBe(false);
  });
  it('enforces body bounds and returns safe structured errors', async () => {
    const { create } = setup();
    const response = await create('key', {
      ...requestBody,
      title: 'x'.repeat(17000),
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as {
      error: { code: string; requestId: string };
    };
    expect(body.error.code).toBe('body_too_large');
    expect(body.error.requestId).toBe(response.headers.get('X-Request-Id'));
  });
});

describe('distributed rolling rate accounting', () => {
  it('routes explicit AI disclosure decisions with the revision fence and idempotency key', async () => {
    const f = setup();
    const created = (await (await f.create()).json()) as {
      audit: { id: string; currentRevisionId: string };
    };
    const body = {
      schemaVersion: '1.0',
      expectedGeneration: 0,
      expectedInputDigest: 'a'.repeat(64),
      disclosureDigest: 'b'.repeat(64),
      decision: 'accept',
    };
    const submit = vi
      .spyOn(WorkspaceRepository.prototype, 'submitAiDisclosure')
      .mockResolvedValue({
        schemaVersion: '1.0',
        auditId: created.audit.id,
        revisionId: created.audit.currentRevisionId,
        disclosureDigest: body.disclosureDigest,
        decision: 'accept',
        replayed: false,
      });
    try {
      const path = `/api/v1/audits/${created.audit.id}/revisions/${created.audit.currentRevisionId}/ai-disclosure`;
      const response = await f.app.request(path, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer alice',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'disclosure-once',
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(201);
      expect(submit).toHaveBeenCalledWith(
        'alice',
        created.audit.id,
        created.audit.currentRevisionId,
        body,
        'disclosure-once',
      );
      const invalid = await f.app.request(path, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer alice',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'disclosure-invalid',
        },
        body: JSON.stringify({ ...body, decision: 'always' }),
      });
      expect(invalid.status).toBe(422);
      expect(submit).toHaveBeenCalledOnce();
    } finally {
      submit.mockRestore();
    }
  });

  it('routes authenticated advisory review with its original idempotency key', async () => {
    const f = setup();
    const created = (await (await f.create()).json()) as {
      audit: { id: string; currentRevisionId: string };
    };
    const body = {
      schemaVersion: '1.0',
      expectedGeneration: 2,
      expectedInputDigest: 'a'.repeat(64),
      draftDigest: 'b'.repeat(64),
      decision: 'omit',
    };
    const submit = vi
      .spyOn(WorkspaceRepository.prototype, 'submitInvestigationReview')
      .mockResolvedValue({
        schemaVersion: '1.0',
        operationId: crypto.randomUUID(),
        draftDigest: body.draftDigest,
        status: 'omitted',
        replayed: false,
      });
    try {
      const path = `/api/v1/audits/${created.audit.id}/revisions/${created.audit.currentRevisionId}/investigation-review`;
      const response = await f.app.request(path, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer alice',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'review-once',
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(201);
      expect(submit).toHaveBeenCalledWith(
        'alice',
        created.audit.id,
        created.audit.currentRevisionId,
        body,
        'review-once',
      );
      const invalid = await f.app.request(path, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer alice',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...body, decision: 'replace_verdict' }),
      });
      expect(invalid.status).toBe(422);
      expect(submit).toHaveBeenCalledOnce();
    } finally {
      submit.mockRestore();
    }
  });
  it('enforces mutation cap atomically across separate gate instances', async () => {
    const documents = new TestDocuments();
    const first = new FirestoreUserRateGate(documents);
    const second = new FirestoreUserRateGate(documents);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 ? first : second).consume('alice', true),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(10);
    await expect(first.consume('bob', true)).resolves.toBeUndefined();
    await expect(first.consume('alice', false)).resolves.toBeUndefined();
  });
  it('expires requests at the rolling boundary, without a fixed-minute burst gap', async () => {
    const documents = new TestDocuments();
    let now = 59000;
    const gate = new FirestoreUserRateGate(documents, undefined, () => now);
    for (let i = 0; i < 60; i++) await gate.consume('alice', false);
    now = 60000;
    await expect(gate.consume('alice', false)).rejects.toThrow('limit');
    now = 119000;
    await expect(gate.consume('alice', false)).resolves.toBeUndefined();
  });
});

describe('sanitized Firestore request diagnostics', () => {
  it('logs classified storage failures with a route template, not owner identifiers', async () => {
    const f = setup();
    const auditId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const workspace = vi
      .spyOn(WorkspaceRepository.prototype, 'get')
      .mockRejectedValue(
        new FirestoreFailure(503, false, 'http', 'other', 'UNAVAILABLE'),
      );
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await f.app.request(
        `/api/v1/audits/${auditId}/revisions/${revisionId}/workspace`,
        { headers: { Authorization: 'Bearer alice' } },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: 'storage_unavailable' },
      });
      expect(logger).toHaveBeenCalledWith('siphon_firestore_failure', {
        requestId: expect.any(String),
        method: 'GET',
        route: '/api/v1/audits/:auditId/revisions/:revisionId/workspace',
        firestoreStatus: 503,
        source: 'http',
        reason: 'other',
        apiStatus: 'UNAVAILABLE',
        ambiguousCommit: false,
      });
      expect(JSON.stringify(logger.mock.calls)).not.toContain(auditId);
      expect(JSON.stringify(logger.mock.calls)).not.toContain(revisionId);
      expect(JSON.stringify(logger.mock.calls)).not.toContain('alice');
    } finally {
      logger.mockRestore();
      workspace.mockRestore();
    }
  });
});
