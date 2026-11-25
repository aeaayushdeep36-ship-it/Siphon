import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { FirestoreUserRateGate } from './rate-limit.js';
import { IdentityError, type Identity } from './auth.js';
import { TestDocuments } from '../test/document-store.js';
import { AuditCommands } from './audit-commands.js';
import { RevisionRepository } from './revisions.js';
import { UploadRepository } from './uploads.js';
import { UploadContentService } from './upload-content.js';
import { ArtifactDownloadService } from './artifact-download.js';
import { ProgressRepository } from './progress.js';
import { ReportRepository, ReportDownloads } from './reports.js';
import { WorkspaceRepository } from './workspace.js';
import { HistoryRepository } from './history.js';
import { RunService, ResumeService } from './runs.js';
import { RunQueue } from './run-queue.js';
import {
  ADMIN_EMAIL,
  VerificationRequestRepository,
} from './verification-requests.js';

function setup() {
  const documents = new TestDocuments();
  const verificationRequests = new VerificationRequestRepository(
    documents,
    documents,
    () => new Date('2026-11-25T00:00:00Z'),
  );
  const reports = new ReportRepository(documents);
  const identities: Record<string, Identity> = {
    admin: {
      uid: 'admin-uid',
      authTime: 1,
      email: ADMIN_EMAIL,
      emailVerified: true,
      signInProvider: 'google.com',
    },
    'admin-unverified': {
      uid: 'admin-unv',
      authTime: 1,
      email: ADMIN_EMAIL,
      emailVerified: false,
      signInProvider: 'password',
    },
    applicant: {
      uid: 'user-1',
      authTime: 1,
      email: 'researcher@example.com',
      emailVerified: false,
      signInProvider: 'password',
    },
    'applicant-verified': {
      uid: 'user-1',
      authTime: 1,
      email: 'researcher@example.com',
      emailVerified: true,
      signInProvider: 'password',
    },
    other: {
      uid: 'other-uid',
      authTime: 1,
      email: 'someone@example.com',
      emailVerified: true,
      signInProvider: 'google.com',
    },
  };
  const app = createApp({
    resumes: new ResumeService(documents, undefined, false),
    runs: new RunService(new RunQueue(documents), undefined, false),
    workspace: new WorkspaceRepository(documents),
    history: new HistoryRepository(documents, {
      history: async () => [],
    }),
    reports,
    reportDownloads: new ReportDownloads(reports, {
      get: async () => {
        throw new Error('Unexpected');
      },
    }),
    progress: new ProgressRepository(documents),
    downloads: new ArtifactDownloadService(documents, {
      get: async () => {
        throw new Error('Unexpected');
      },
    }),
    commands: new AuditCommands(documents),
    revisions: new RevisionRepository(documents),
    uploads: new UploadRepository(documents),
    uploadContent: new UploadContentService(documents, {
      putOnce: async () => ({ size: 0, sha256: 'a'.repeat(64) }),
    }),
    repository: new FirestoreAuditRepository(documents),
    userRateGate: new FirestoreUserRateGate(documents),
    verificationRequests,
    allowedOrigins: ['https://siphon.example'],
    edgeRateGate: async () => true,
    verifyIdentity: async (token) => {
      const id = identities[token];
      if (!id) throw new IdentityError('invalid_credentials');
      return id;
    },
  });
  return { app, documents };
}

describe('account verification requests and admin approval', () => {
  it('allows an applicant to submit a verification request, restricts admin routes to ADMIN_EMAIL, and activates access on approval', async () => {
    const { app } = setup();

    // 1. Applicant submits verification request before approval
    const submitRes = await app.request('/api/v1/auth/verification-request', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer applicant',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Dr. Jane Doe', phone: '+1 555 010 9999' }),
    });
    expect(submitRes.status).toBe(201);
    const submitted = await submitRes.json();
    expect(submitted.request.status).toBe('pending');
    expect(submitted.request.email).toBe('researcher@example.com');

    // 2. Unverified applicant cannot access /api/v1/audits even if they try
    const blockedUnverified = await app.request('/api/v1/audits', {
      headers: { Authorization: 'Bearer applicant' },
    });
    expect(blockedUnverified.status).toBe(403);
    expect((await blockedUnverified.json()).error.code).toBe(
      'email_verification_required',
    );

    // 3. Verified applicant without admin approval still cannot access /api/v1/audits
    const blockedNotApproved = await app.request('/api/v1/audits', {
      headers: { Authorization: 'Bearer applicant-verified' },
    });
    expect(blockedNotApproved.status).toBe(403);
    expect((await blockedNotApproved.json()).error.code).toBe(
      'invitation_required',
    );

    // 4. Non-admin users and unverified admin email are blocked from admin endpoints
    for (const token of ['other', 'applicant-verified', 'admin-unverified']) {
      const deniedList = await app.request(
        '/api/v1/admin/verification-requests',
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(deniedList.status).toBe(403);
      const deniedApprove = await app.request(
        '/api/v1/admin/verification-requests/user-1/approve',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(deniedApprove.status).toBe(403);
    }

    // 5. Sole admin (aeaayushdeep36@gmail.com) lists and approves request
    const adminList = await app.request('/api/v1/admin/verification-requests', {
      headers: { Authorization: 'Bearer admin' },
    });
    expect(adminList.status).toBe(200);
    const listBody = await adminList.json();
    expect(listBody.requests).toHaveLength(1);
    expect(listBody.requests[0].uid).toBe('user-1');

    const approveRes = await app.request(
      '/api/v1/admin/verification-requests/user-1/approve',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin' },
      },
    );
    expect(approveRes.status).toBe(200);
    const approveBody = await approveRes.json();
    expect(approveBody.request.status).toBe('approved');
    expect(approveBody.request.reviewedBy).toBe(ADMIN_EMAIL);

    // 6. Status endpoint reports approved & verified applicant can now access /api/v1/audits
    const statusRes = await app.request('/api/v1/auth/verification-status', {
      headers: { Authorization: 'Bearer applicant-verified' },
    });
    expect(statusRes.status).toBe(200);
    expect((await statusRes.json()).status).toBe('approved');

    const allowedRes = await app.request('/api/v1/audits', {
      headers: { Authorization: 'Bearer applicant-verified' },
    });
    expect(allowedRes.status).toBe(200);
  });
});
