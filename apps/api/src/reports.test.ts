import { describe, expect, it, vi } from 'vitest';
import { ReportDownloads, ReportRepository } from './reports.js';
import { TestDocuments } from '../test/document-store.js';
import { firestoreTransport } from '../test/firestore-transport.js';
import { authoredReport } from '../test/report-fixture.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { canonicalJson, sha256 } from './hashing.js';
import { AuditCommands } from './audit-commands.js';

async function fixture() {
  const docs = new TestDocuments();
  docs.documents.set('testers/alice', { active: true });
  docs.documents.set('testers/bob', { active: true });
  const { audit } = await new FirestoreAuditRepository(docs).create(
    'alice',
    {
      schemaVersion: '1.0',
      title: 'Authored report fixture',
      domain: 'heat_diffusion',
    },
    'create',
  );
  const report = authoredReport();
  report.auditId = audit.id;
  report.revisionId = audit.currentRevisionId;
  for (const metric of report.metrics) {
    metric.auditId = audit.id;
    metric.revisionId = audit.currentRevisionId;
  }
  const revisionPath = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
  Object.assign(docs.documents.get(revisionPath)!, {
    reportId: report.reportId,
    inputDigest: report.inputDigest,
  });
  const path = `${revisionPath}/reports/${report.reportId}`;
  const json = canonicalJson(report);
  const digest = await sha256(json);
  const record = {
    schemaVersion: '1.0',
    reportId: report.reportId,
    ownerUid: 'alice',
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest: report.inputDigest,
    reportDigest: digest,
    reportJson: json,
    createdAt: report.createdAt,
    expiresAt: report.expiresAt,
  };
  docs.documents.set(path, record);
  let now = new Date('2026-10-29T01:00:00.000Z');
  const clock = () => now;
  const repo = new ReportRepository(docs, clock);
  const read = (uid = 'alice') =>
    repo.get(uid, audit.id, audit.currentRevisionId);
  const artifactId = crypto.randomUUID(),
    pdfSha256 = '9'.repeat(64),
    bytes = 12;
  const exportPath = `${path}/exports/pdf`,
    artifactPath = `audits/${audit.id}/artifacts/${artifactId}`;
  const ready = () => {
    docs.documents.set(exportPath, {
      schemaVersion: '1.0',
      reportId: report.reportId,
      ownerUid: 'alice',
      auditId: audit.id,
      revisionId: audit.currentRevisionId,
      reportDigest: digest,
      status: 'ready',
      artifactId,
      pdfSha256,
      bytes,
      createdAt: report.createdAt,
      updatedAt: report.createdAt,
    });
    docs.documents.set(artifactPath, {
      artifactId,
      ownerUid: 'alice',
      auditId: audit.id,
      revisionId: audit.currentRevisionId,
      kind: 'report_pdf',
      mime: 'application/pdf',
      reportId: report.reportId,
      reportDigest: digest,
      sha256: pdfSha256,
      bytes,
      lifecycle: 'ready',
      expiresAt: report.expiresAt,
    });
  };
  const download = vi.fn(
    async () =>
      new Response('%PDF-fixture', {
        headers: {
          'Content-Length': String(bytes),
          'X-Content-SHA256': pdfSha256,
        },
      }),
  );
  const service = new ReportDownloads(repo, { get: download });
  const pdf = (signal?: AbortSignal) =>
    service.getPdf(
      'alice',
      audit.id,
      audit.currentRevisionId,
      new Request(
        'https://siphon.example/report.pdf',
        signal ? { signal } : {},
      ),
    );
  return {
    docs,
    audit,
    report,
    revisionPath,
    path,
    record,
    repo,
    clock,
    read,
    artifactId,
    artifactPath,
    exportPath,
    ready,
    download,
    pdf,
    setTime: (value: string) => {
      now = new Date(value);
    },
  };
}

describe('private canonical evidence report reads', () => {
  it('reads immutable JSON with an explicit unavailable export and no renderer/provider calls', async () => {
    const f = await fixture();
    expect(await f.read()).toEqual({
      schemaVersion: '1.0',
      report: f.report,
      reportDigest: f.record.reportDigest,
      pdf: { status: 'not_ready' },
      retention: {
        checkedAt: f.clock().toISOString(),
        expiredEvidenceIds: [],
        expiredArtifactIds: [],
      },
    });
    expect(f.download).not.toHaveBeenCalled();
  });
  it('validates native timestamp metadata through the actual Firestore REST codec', async () => {
    const f = await fixture();
    f.ready();
    f.docs.documents.set(f.path, {
      ...f.record,
      createdAt: new Date(f.record.createdAt),
      expiresAt: new Date(f.record.expiresAt),
    });
    const wire = firestoreTransport(f.docs);
    expect(
      (
        await new ReportRepository(wire.client, f.clock).get(
          'alice',
          f.audit.id,
          f.audit.currentRevisionId,
        )
      ).pdf.status,
    ).toBe('available');
  });
  it.each([
    'owner',
    'invitation',
    'deletion',
    'revision_owner',
    'revision_identity',
  ])('denies %s access', async (field) => {
    const f = await fixture();
    if (field === 'invitation')
      f.docs.documents.get('testers/alice')!.active = false;
    if (field === 'deletion')
      await new AuditCommands(f.docs, f.clock).remove(
        'alice',
        f.audit.id,
        'delete',
      );
    if (field === 'revision_owner')
      f.docs.documents.get(f.revisionPath)!.ownerUid = 'bob';
    if (field === 'revision_identity')
      f.docs.documents.get(f.revisionPath)!.auditId = crypto.randomUUID();
    await expect(f.read(field === 'owner' ? 'bob' : 'alice')).rejects.toThrow();
  });
  it.each(['missing', 'expired'])(
    'returns an explicit %s report state',
    async (mode) => {
      const f = await fixture();
      if (mode === 'missing')
        delete f.docs.documents.get(f.revisionPath)!.reportId;
      if (mode === 'expired') f.setTime(f.report.expiresAt);
      await expect(f.read()).rejects.toMatchObject({
        status: 409,
        code: mode === 'missing' ? 'report_not_ready' : 'report_expired',
      });
    },
  );
  it.each([
    'json',
    'digest',
    'noncanonical',
    'record_owner',
    'record_audit',
    'record_revision',
    'record_input',
    'created',
    'future',
    'retention',
    'domain',
  ])('rejects %s report integrity changes', async (field) => {
    const f = await fixture();
    const record = f.docs.documents.get(f.path)!;
    if (field === 'json') record.reportJson = '{"private":"invalid"}';
    if (field === 'digest') record.reportDigest = '0'.repeat(64);
    if (field === 'noncanonical') {
      record.reportJson = JSON.stringify(f.report);
      record.reportDigest = await sha256(String(record.reportJson));
    }
    if (field === 'record_owner') record.ownerUid = 'bob';
    if (field === 'record_audit') record.auditId = crypto.randomUUID();
    if (field === 'record_revision') record.revisionId = crypto.randomUUID();
    if (field === 'record_input') record.inputDigest = '0'.repeat(64);
    if (field === 'created') record.createdAt = '2026-10-29T00:00:01.000Z';
    if (field === 'future') f.setTime('2026-10-28T00:00:00.000Z');
    if (field === 'domain')
      f.docs.documents.get(`audits/${f.audit.id}`)!.domain = 'orbital_dynamics';
    if (field === 'retention') {
      f.report.expiresAt = '2027-01-01T00:00:00.000Z';
      record.expiresAt = f.report.expiresAt;
      record.reportJson = canonicalJson(f.report);
      record.reportDigest = await sha256(String(record.reportJson));
    }
    await expect(f.read()).rejects.toThrow();
  });
  it('allows a historical report after a successor becomes current, while retaining exact old input identity', async () => {
    const f = await fixture();
    f.docs.documents.get(`audits/${f.audit.id}`)!.currentRevisionId =
      crypto.randomUUID();
    expect((await f.read()).report.revisionId).toBe(f.audit.currentRevisionId);
  });
  it('marks later evidence and raw-artifact expiry without rewriting the original report or verdicts', async () => {
    const f = await fixture();
    const expiry = '2026-10-29T00:30:00.000Z';
    f.report.evidenceCatalog[0]!.expiresAt = expiry;
    const artifactId = crypto.randomUUID();
    f.report.artifacts.push({
      artifactId,
      displayName: 'Authored raw observation',
      kind: 'observation',
      sha256: '0'.repeat(64),
      bytes: 8,
      expiresAt: expiry,
      availabilityAtCreation: 'available',
    });
    const record = f.docs.documents.get(f.path)!;
    record.reportJson = canonicalJson(f.report);
    record.reportDigest = await sha256(String(record.reportJson));
    const result = await f.read();
    expect(result.report.coverage).toBe('full');
    expect(result.report.metrics[0]!.status).toBe('passed_within_tolerance');
    expect(result.retention).toEqual({
      checkedAt: f.clock().toISOString(),
      expiredEvidenceIds: [f.report.evidenceCatalog[0]!.id],
      expiredArtifactIds: [artifactId],
    });
  });
  it.each([
    'pending',
    'failed',
    'expired',
    'missing_artifact',
    'wrong_report',
    'wrong_hash',
    'wrong_owner',
    'wrong_kind',
    'wrong_mime',
    'wrong_size',
    'wrong_expiry',
    'corrupt_export',
  ])('preserves structured results with %s PDF', async (mode) => {
    const f = await fixture();
    f.ready();
    const exported = f.docs.documents.get(f.exportPath)!,
      artifact = f.docs.documents.get(f.artifactPath)!;
    if (mode === 'pending' || mode === 'failed')
      Object.assign(exported, {
        status: mode,
        artifactId: null,
        pdfSha256: null,
        bytes: null,
      });
    if (mode === 'expired') artifact.expiresAt = f.clock().toISOString();
    if (mode === 'missing_artifact') f.docs.documents.delete(f.artifactPath);
    if (mode === 'wrong_report') exported.reportDigest = '0'.repeat(64);
    if (mode === 'wrong_hash') artifact.sha256 = '0'.repeat(64);
    if (mode === 'wrong_owner') artifact.ownerUid = 'bob';
    if (mode === 'wrong_kind') artifact.kind = 'source';
    if (mode === 'wrong_mime') artifact.mime = 'text/html';
    if (mode === 'wrong_size') artifact.bytes = 13;
    if (mode === 'wrong_expiry')
      artifact.expiresAt = '2027-01-01T00:00:00.000Z';
    if (mode === 'corrupt_export') exported.bytes = 'private marker';
    const result = await f.read();
    expect(result.report).toEqual(f.report);
    expect(result.pdf.status).toBe(
      mode === 'pending'
        ? 'not_ready'
        : ['failed', 'expired'].includes(mode)
          ? mode
          : 'unavailable',
    );
    await expect(f.pdf()).rejects.toMatchObject({ status: 409 });
    expect(f.download).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private marker');
  });
});

describe('report-bound private PDF downloads', () => {
  it('serves a matching export as a private PDF attachment with a generated safe name', async () => {
    const f = await fixture();
    f.ready();
    const response = await f.pdf();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('%PDF-fixture');
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('Content-Disposition')).toBe(
      `attachment; filename="siphon-${f.report.reportId}.pdf"`,
    );
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Content-Security-Policy')).toContain(
      'sandbox',
    );
    expect(f.download).toHaveBeenCalledTimes(1);
    expect(f.download).toHaveBeenCalledWith(
      'alice',
      f.audit.id,
      f.artifactId,
      expect.any(Request),
    );
  });
  it.each([
    'revoke',
    'delete',
    'expire',
    'change_export',
    'bad_hash_header',
    'bad_size_header',
    'abort',
  ])(
    'cancels the stream on %s before handing bytes to the user',
    async (mode) => {
      const f = await fixture();
      f.ready();
      const cancel = vi.fn();
      const controller = new AbortController();
      f.download.mockImplementationOnce(async () => {
        if (mode === 'revoke')
          f.docs.documents.get('testers/alice')!.active = false;
        if (mode === 'delete')
          await new AuditCommands(f.docs, f.clock).remove(
            'alice',
            f.audit.id,
            'delete',
          );
        if (mode === 'expire') f.setTime(f.report.expiresAt);
        if (mode === 'change_export')
          f.docs.documents.get(f.exportPath)!.reportDigest = '0'.repeat(64);
        if (mode === 'abort') controller.abort();
        return new Response(new ReadableStream({ cancel }), {
          headers: {
            'Content-Length': mode === 'bad_size_header' ? '13' : '12',
            'X-Content-SHA256':
              mode === 'bad_hash_header' ? '0'.repeat(64) : '9'.repeat(64),
          },
        });
      });
      await expect(f.pdf(controller.signal)).rejects.toThrow();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(f.download).toHaveBeenCalledTimes(1);
    },
  );
});
