import { z } from 'zod';
import { Digest, Domain, Id, SchemaVersion, Timestamp } from './common.js';
import { ReportPlot, reportText } from './reports.js';

const plain = reportText;

/** Private presentation protocol derived from a validated EvidenceReport by
 * reviewed code. No style code, templates, paths, markup, images or URLs to fetch.
 * The renderer validates layout only; it never issues scientific verdicts.
 */
export const PdfRenderDocument = z
  .strictObject({
    schemaVersion: SchemaVersion,
    reportId: Id,
    auditId: Id,
    revisionId: Id,
    reportDigest: Digest,
    title: plain(200),
    domain: Domain,
    createdAt: Timestamp,
    coverage: z.enum(['full', 'limited']),
    blocks: z
      .array(
        z.discriminatedUnion('kind', [
          z.strictObject({ kind: z.literal('heading'), text: plain(300) }),
          z.strictObject({
            kind: z.literal('paragraph'),
            text: plain(16000),
            tone: z.enum(['normal', 'muted', 'warning']),
          }),
          z.strictObject({ kind: z.literal('plot'), plot: ReportPlot }),
        ]),
      )
      .min(1)
      .max(1500),
  })
  .superRefine((value, ctx) => {
    let count = 0;
    for (const block of value.blocks)
      if (block.kind === 'plot') {
        for (const series of block.plot.series) {
          count += series.points.length;
          if (series.points.length > series.originalPointCount)
            ctx.addIssue({
              code: 'custom',
              message: 'Invalid plot sampling label',
            });
        }
      }
    if (
      count > 16000 ||
      new TextEncoder().encode(JSON.stringify(value)).length > 512 * 1024
    )
      ctx.addIssue({
        code: 'custom',
        message: 'PDF presentation budget exceeded',
      });
  });
export type PdfRenderDocument = z.infer<typeof PdfRenderDocument>;
