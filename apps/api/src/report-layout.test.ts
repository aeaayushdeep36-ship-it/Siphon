import { describe, expect, it } from 'vitest';
import { buildPdfDocument } from './report-layout.js';
import { authoredReport } from '../test/report-fixture.js';
import { canonicalJson, sha256 } from './hashing.js';
import { PdfRenderDocument } from '@siphon/contracts';

describe('deterministic shared-report PDF presentation', () => {
  it('binds the complete canonical report and preserves metric precision, statuses, units, sources and scope', async () => {
    const report = authoredReport('orbital_dynamics');
    report.metrics[0]!.metric.value = 0.5000000000000001;
    report.metrics[0]!.interval = {
      lower: 0.5000000000000001,
      upper: 0.5000000000000001,
    };
    const doc = await buildPdfDocument(report);
    expect(doc.reportDigest).toBe(await sha256(canonicalJson(report)));
    expect(await buildPdfDocument(report)).toEqual(doc);
    const serialized = JSON.stringify(doc);
    for (const required of [
      report.reportId,
      report.auditId,
      report.revisionId,
      report.inputDigest,
      report.contextDigest,
      report.adapterDigest,
      report.planDigest,
      report.metrics[0]!.id,
      '0.5000000000000001 J',
      'passed within tolerance',
      'Absolute uncertainty bound: 0 J',
      'Target: 1 J',
      'Conservative interval: [0.5000000000000001, 0.5000000000000001] J',
      report.narrative.hypotheses[0]!.verification,
      report.narrative.recommendations[0]!.validation,
      report.references[0]!.url,
      report.limitations[0],
      'X: Time [s]',
      'Y: Energy drift [J]',
    ])
      expect(serialized).toContain(required);
    expect(doc.blocks.find((block) => block.kind === 'plot')).toEqual({
      kind: 'plot',
      plot: report.plots[0],
    });
  });
  it('does not promote missing support or an unavailable adapter into a pass', async () => {
    const report = authoredReport();
    report.coverage = 'limited';
    report.incompleteReasons = ['Uncertainty is unavailable.'];
    Object.assign(report.metrics[0]!, {
      uncertainty: null,
      interval: null,
      status: 'inconclusive',
      reason: 'missing_uncertainty_bound',
    });
    report.adapter.status = 'baseline_matched';
    const serialized = JSON.stringify(await buildPdfDocument(report));
    expect(serialized).toContain('inconclusive');
    expect(serialized).toContain('Absolute uncertainty bound: unavailable');
    expect(serialized).toContain('Conservative interval: unavailable');
    expect(serialized).toContain('baseline matched');
    expect(serialized).not.toContain('passed within tolerance');
  });
  it('preserves literal markup and Unicode as data for the renderer to escape', async () => {
    const report = authoredReport();
    report.summary = '<img src="file:///private/no-image.png"/> ρ Δt μ';
    expect(JSON.stringify(await buildPdfDocument(report))).toContain('ρ Δt μ');
    expect((await buildPdfDocument(report)).blocks).toContainEqual({
      kind: 'paragraph',
      text: report.summary,
      tone: 'normal',
    });
  });
  it('rejects unbound report evidence before creating any layout', async () => {
    const report = authoredReport();
    report.metrics[0]!.revisionId = crypto.randomUUID();
    await expect(buildPdfDocument(report)).rejects.toThrow();
  });
  it('does not accept template code, image fetches, extra fields, misleading sample labels or excessive layout bytes', async () => {
    const doc = await buildPdfDocument(authoredReport());
    for (const block of [
      { kind: 'image', url: 'https://example.org/x' },
      { kind: 'heading', text: 'Title', template: 'execute()' },
    ])
      expect(
        PdfRenderDocument.safeParse({ ...doc, blocks: [block] }).success,
      ).toBe(false);
    const plot = doc.blocks.find((block) => block.kind === 'plot')!;
    if (plot.kind !== 'plot') throw new Error('Missing authored plot');
    plot.plot.series[0]!.originalPointCount = 1;
    expect(PdfRenderDocument.safeParse(doc).success).toBe(false);
    const huge = {
      ...doc,
      blocks: Array.from({ length: 40 }, () => ({
        kind: 'paragraph',
        text: 'a'.repeat(16000),
        tone: 'normal',
      })),
    };
    expect(PdfRenderDocument.safeParse(huge).success).toBe(false);
  });
});
