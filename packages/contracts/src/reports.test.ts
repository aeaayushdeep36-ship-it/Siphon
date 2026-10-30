import { describe, expect, it } from 'vitest';
import { EvidenceReport } from './reports.js';
import { authoredReport } from '../../../apps/api/test/report-fixture.js';

describe('shared scientific evidence report', () => {
  it.each(['heat_diffusion', 'orbital_dynamics'] as const)(
    'accepts a scoped %s document without claiming a global correctness score',
    (domain) => {
      const report = authoredReport(domain);
      expect(EvidenceReport.parse(report)).toEqual(report);
      expect('score' in report).toBe(false);
    },
  );
  it('accepts a genuinely limited report with no invented evidence or adapter results', () => {
    const report = authoredReport();
    Object.assign(report, {
      coverage: 'limited',
      incompleteReasons: ['No executable checks were available.'],
      contextDigest: null,
      adapterDigest: null,
      planDigest: null,
      checks: [],
      experiments: [],
      metrics: [],
      plots: [],
      evidenceCatalog: [],
      references: [],
      narrative: { facts: [], hypotheses: [], recommendations: [] },
      readiness: {
        status: null,
        explanation: 'Not assessed.',
        evidenceIds: [],
      },
      adapter: {
        status: 'not_attempted',
        explanation: 'Not attempted.',
        evidenceIds: [],
        comparedElements: null,
      },
    });
    expect(EvidenceReport.parse(report).coverage).toBe('limited');
  });
  it.each([
    'audit',
    'revision',
    'input',
    'context',
    'adapter',
    'plan',
    'domain',
    'check_version',
  ])('rejects changed %s binding', (field) => {
    const report = authoredReport();
    if (field === 'audit') report.metrics[0]!.auditId = crypto.randomUUID();
    if (field === 'revision')
      report.metrics[0]!.revisionId = crypto.randomUUID();
    if (field === 'input') report.metrics[0]!.inputDigest = '0'.repeat(64);
    if (field === 'context') report.metrics[0]!.contextDigest = '0'.repeat(64);
    if (field === 'adapter') report.metrics[0]!.adapterDigest = '0'.repeat(64);
    if (field === 'plan') report.metrics[0]!.planDigest = '0'.repeat(64);
    if (field === 'domain') report.domain = 'orbital_dynamics';
    if (field === 'check_version') report.checks[0]!.checkVersion = '0.2.0';
    expect(EvidenceReport.safeParse(report).success).toBe(false);
  });
  it.each(['check', 'experiment', 'metric', 'catalog', 'plot', 'software'])(
    'rejects duplicate %s identities',
    (field) => {
      const report = authoredReport();
      if (field === 'check') report.checks.push(report.checks[0]!);
      if (field === 'experiment')
        report.experiments.push(report.experiments[0]!);
      if (field === 'metric') report.metrics.push(report.metrics[0]!);
      if (field === 'catalog')
        report.evidenceCatalog.push(report.evidenceCatalog[0]!);
      if (field === 'plot') report.plots.push(report.plots[0]!);
      if (field === 'software') report.software.push(report.software[0]!);
      expect(EvidenceReport.safeParse(report).success).toBe(false);
    },
  );
  it.each([
    'fact',
    'hypothesis',
    'recommendation',
    'support',
    'method',
    'plot',
    'experiment',
    'metric',
  ])('rejects dangling %s provenance', (field) => {
    const report = authoredReport();
    const missing = crypto.randomUUID();
    if (field === 'fact') report.narrative.facts[0]!.evidenceIds = [missing];
    if (field === 'hypothesis')
      report.narrative.hypotheses[0]!.evidenceIds = [missing];
    if (field === 'recommendation')
      report.narrative.recommendations[0]!.evidenceIds = [missing];
    if (field === 'support') report.metrics[0]!.target!.evidenceIds = [missing];
    if (field === 'method') report.checks[0]!.referenceIds = ['missing'];
    if (field === 'plot') report.plots[0]!.series[0]!.experimentId = missing;
    if (field === 'experiment') report.checks[0]!.experimentIds = [missing];
    if (field === 'metric') report.checks[0]!.metricEvidenceIds = [missing];
    expect(EvidenceReport.safeParse(report).success).toBe(false);
  });
  it.each([
    'unselected',
    'failed_experiment',
    'missing_operation',
    'missing_digest',
    'no_plan',
    'wrong_verdict',
    'false_downsampling',
  ])('rejects misleading %s evidence', (field) => {
    const report = authoredReport();
    if (field === 'unselected') report.checks[0]!.selection = 'excluded';
    if (field === 'failed_experiment') report.experiments[0]!.status = 'failed';
    if (field === 'missing_operation')
      report.experiments[0]!.sourceOperationId = null;
    if (field === 'missing_digest') report.experiments[0]!.resultDigest = null;
    if (field === 'no_plan') report.planDigest = null;
    if (field === 'wrong_verdict') report.metrics[0]!.status = 'flagged';
    if (field === 'false_downsampling')
      report.plots[0]!.series[0]!.originalPointCount = 1;
    expect(EvidenceReport.safeParse(report).success).toBe(false);
  });
  it.each([
    'missing_reason',
    'unresolved_check',
    'unknown_readiness',
    'unverified_adapter',
    'expired_evidence',
    'expired_report',
  ])('rejects inconsistent completeness %s', (field) => {
    const report = authoredReport();
    if (field === 'missing_reason') report.coverage = 'limited';
    if (field === 'unresolved_check')
      report.checks.push({
        ...report.checks[0]!,
        checkId: 'H_BALANCE',
        selection: 'unresolved',
        experimentIds: [],
        metricEvidenceIds: [],
      });
    if (field === 'unknown_readiness') report.readiness.status = null;
    if (field === 'unverified_adapter')
      report.adapter.status = 'baseline_matched';
    if (field === 'expired_evidence')
      report.evidenceCatalog[0]!.expiresAt = report.createdAt;
    if (field === 'expired_report') report.expiresAt = report.createdAt;
    expect(EvidenceReport.safeParse(report).success).toBe(false);
  });
  it('bounds text, invalid unicode, plot data and total encoded payload without restricting scientific number scale', () => {
    for (const marker of ['\u0000', '\ud800']) {
      const report = authoredReport();
      report.summary = marker;
      expect(EvidenceReport.safeParse(report).success).toBe(false);
    }
    const report = authoredReport();
    report.summary =
      'Temperature ρ, Δt and orbital μ are plain text; <img src="file:///private"> is not markup.';
    expect(EvidenceReport.safeParse(report).success).toBe(true);
    report.plots = Array.from({ length: 8 }, () => ({
      ...report.plots[0]!,
      id: crypto.randomUUID(),
      series: Array.from({ length: 4 }, (_, i) => ({
        ...report.plots[0]!.series[0]!,
        label: `Series ${i}`,
        originalPointCount: 2000,
        points: Array.from({ length: 2000 }, (_, x) => ({ x, y: x })),
      })),
    }));
    expect(EvidenceReport.safeParse(report).success).toBe(false);
  });
});
