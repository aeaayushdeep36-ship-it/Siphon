import { z } from 'zod';
import {
  Count,
  Digest,
  EvidenceReport,
  EvidenceReportResponse,
  Id,
  Timestamp,
} from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import { authorize } from './audit-commands.js';
import { type ArtifactDownloadService } from './artifact-download.js';
import { canonicalJson, sha256 } from './hashing.js';
import { ApiError } from './errors.js';
import { RETENTION } from './retention.js';

const PublishedReport = z.strictObject({
  schemaVersion: z.literal('1.0'),
  reportId: Id,
  ownerUid: z.string().min(1).max(128),
  auditId: Id,
  revisionId: Id,
  inputDigest: Digest,
  reportDigest: Digest,
  reportJson: z.string().max(256 * 1024),
  createdAt: Timestamp,
  expiresAt: Timestamp,
});
const ExportRecord = z
  .strictObject({
    schemaVersion: z.literal('1.0'),
    reportId: Id,
    ownerUid: z.string().min(1).max(128),
    auditId: Id,
    revisionId: Id,
    reportDigest: Digest,
    status: z.enum(['pending', 'ready', 'failed']),
    artifactId: Id.nullable(),
    pdfSha256: Digest.nullable(),
    bytes: Count.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .refine((record) =>
    record.status === 'ready'
      ? record.artifactId !== null &&
        record.pdfSha256 !== null &&
        record.bytes !== null &&
        record.bytes > 0
      : record.artifactId === null &&
        record.pdfSha256 === null &&
        record.bytes === null,
  );

type PdfState =
  | { status: 'not_ready' | 'failed' | 'unavailable' | 'expired' }
  | {
      status: 'available';
      artifactId: string;
      sha256: string;
      bytes: number;
      expiresAt: string;
    };

/** Owner-facing reads only. This class cannot publish unverified evidence or
 * mint an export. Trusted assembly and rendering must create immutable records.
 */
export class ReportRepository {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async get(uid: string, auditId: string, revisionId: string) {
    Id.parse(auditId);
    Id.parse(revisionId);
    return this.store.transaction(async (tx) => {
      const audit = await authorize(tx, uid, auditId, false);
      const revision = await tx.get(
        `audits/${auditId}/revisions/${revisionId}`,
      );
      if (
        !revision ||
        revision.ownerUid !== uid ||
        revision.auditId !== auditId ||
        revision.revisionId !== revisionId
      )
        throw new ApiError(404, 'not_found', 'Report was not found.');
      if (revision.reportId === undefined || revision.reportId === null)
        throw new ApiError(
          409,
          'report_not_ready',
          'The evidence report is not ready.',
        );
      const reportId = Id.parse(revision.reportId);
      const path = `audits/${auditId}/revisions/${revisionId}/reports/${reportId}`;
      const [saved, rawExport] = await tx.getMany([
        path,
        `${path}/exports/pdf`,
      ]);
      const record = PublishedReport.parse(saved);
      const report = EvidenceReport.parse(JSON.parse(record.reportJson));
      const now = this.clock().getTime();
      if (
        record.ownerUid !== uid ||
        record.auditId !== auditId ||
        record.revisionId !== revisionId ||
        record.reportId !== reportId ||
        report.reportId !== reportId ||
        report.auditId !== auditId ||
        report.revisionId !== revisionId ||
        record.inputDigest !== revision.inputDigest ||
        report.inputDigest !== record.inputDigest ||
        report.domain !== audit.domain ||
        new Date(record.createdAt).toISOString() !==
          new Date(report.createdAt).toISOString() ||
        new Date(record.expiresAt).toISOString() !==
          new Date(report.expiresAt).toISOString() ||
        record.reportJson !== canonicalJson(report) ||
        record.reportDigest !== (await sha256(record.reportJson)) ||
        Date.parse(record.createdAt) > now ||
        Date.parse(record.expiresAt) >
          Date.parse(record.createdAt) + RETENTION.reportDays * 86400_000
      )
        throw new Error('Saved report integrity failure');
      if (Date.parse(record.expiresAt) <= now)
        throw new ApiError(
          409,
          'report_expired',
          'The evidence report has expired.',
        );

      let pdf: PdfState = { status: 'not_ready' };
      if (rawExport) {
        const parsed = ExportRecord.safeParse(rawExport);
        if (!parsed.success) pdf = { status: 'unavailable' };
        else {
          const exported = parsed.data;
          if (
            exported.reportId !== reportId ||
            exported.ownerUid !== uid ||
            exported.auditId !== auditId ||
            exported.revisionId !== revisionId ||
            exported.reportDigest !== record.reportDigest ||
            Date.parse(exported.createdAt) < Date.parse(record.createdAt) ||
            Date.parse(exported.updatedAt) < Date.parse(exported.createdAt) ||
            Date.parse(exported.updatedAt) > now
          )
            pdf = { status: 'unavailable' };
          else if (exported.status === 'failed') pdf = { status: 'failed' };
          else if (exported.status === 'ready') {
            const artifact = await tx.get(
              `audits/${auditId}/artifacts/${exported.artifactId}`,
            );
            if (
              !artifact ||
              artifact.ownerUid !== uid ||
              artifact.auditId !== auditId ||
              artifact.revisionId !== revisionId ||
              artifact.artifactId !== exported.artifactId ||
              artifact.kind !== 'report_pdf' ||
              artifact.mime !== 'application/pdf' ||
              artifact.reportId !== reportId ||
              artifact.reportDigest !== record.reportDigest ||
              artifact.sha256 !== exported.pdfSha256 ||
              artifact.bytes !== exported.bytes ||
              artifact.lifecycle !== 'ready' ||
              !Timestamp.safeParse(artifact.expiresAt).success
            )
              pdf = { status: 'unavailable' };
            else if (Date.parse(String(artifact.expiresAt)) <= now)
              pdf = { status: 'expired' };
            else if (
              Date.parse(String(artifact.expiresAt)) >
              Date.parse(record.expiresAt)
            )
              pdf = { status: 'unavailable' };
            else
              pdf = {
                status: 'available',
                artifactId: exported.artifactId!,
                sha256: exported.pdfSha256!,
                bytes: exported.bytes!,
                expiresAt: String(artifact.expiresAt),
              };
          }
        }
      }
      return EvidenceReportResponse.parse({
        schemaVersion: '1.0',
        report,
        reportDigest: record.reportDigest,
        pdf,
        retention: {
          checkedAt: new Date(now).toISOString(),
          expiredEvidenceIds: report.evidenceCatalog
            .filter(
              (item) =>
                item.expiresAt !== null && Date.parse(item.expiresAt) <= now,
            )
            .map((item) => item.id),
          expiredArtifactIds: report.artifacts
            .filter((item) => Date.parse(item.expiresAt) <= now)
            .map((item) => item.artifactId),
        },
      });
    });
  }
}

/** Reuses accounted private R2 streaming; a report read never launches rendering. */
export class ReportDownloads {
  constructor(
    private readonly reports: Pick<ReportRepository, 'get'>,
    private readonly downloads: Pick<ArtifactDownloadService, 'get'>,
  ) {}

  async getPdf(
    uid: string,
    auditId: string,
    revisionId: string,
    request: Request,
  ) {
    const initial = await this.reports.get(uid, auditId, revisionId);
    if (initial.pdf.status !== 'available')
      throw new ApiError(
        409,
        `report_pdf_${initial.pdf.status}`,
        'The PDF export is not available.',
      );
    const response = await this.downloads.get(
      uid,
      auditId,
      initial.pdf.artifactId,
      request,
    );
    try {
      const current = await this.reports.get(uid, auditId, revisionId);
      if (
        current.reportDigest !== initial.reportDigest ||
        current.report.reportId !== initial.report.reportId ||
        current.pdf.status !== 'available' ||
        current.pdf.artifactId !== initial.pdf.artifactId ||
        current.pdf.sha256 !== initial.pdf.sha256 ||
        current.pdf.bytes !== initial.pdf.bytes ||
        response.status !== 200 ||
        response.headers.get('X-Content-SHA256') !== initial.pdf.sha256 ||
        response.headers.get('Content-Length') !== String(initial.pdf.bytes)
      )
        throw new ApiError(
          409,
          'report_pdf_changed',
          'The PDF export is no longer available.',
        );
      request.signal.throwIfAborted();
      const headers = new Headers(response.headers);
      headers.set('Content-Type', 'application/pdf');
      headers.set(
        'Content-Disposition',
        `attachment; filename="siphon-${initial.report.reportId}.pdf"`,
      );
      headers.set('Cache-Control', 'private, no-store');
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Content-Security-Policy', "sandbox; default-src 'none'");
      return new Response(response.body, { headers });
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
  }
}
