import { EvidenceReport, PdfRenderDocument } from '@siphon/contracts';
import { canonicalJson, sha256 } from './hashing.js';

/** Deterministic presentation only. Both screen and PDF originate in the same
 * immutable report. No source loading, AI, rounding, citation lookup or I/O.
 */
export async function buildPdfDocument(
  value: unknown,
): Promise<PdfRenderDocument> {
  const report = EvidenceReport.parse(value);
  const reportDigest = await sha256(canonicalJson(report));
  const blocks: PdfRenderDocument['blocks'] = [];
  const heading = (text: string) => {
    blocks.push({ kind: 'heading', text });
  };
  const paragraph = (
    text: string,
    tone: 'normal' | 'muted' | 'warning' = 'normal',
  ) => {
    blocks.push({ kind: 'paragraph', text, tone });
  };
  const ids = (values: readonly string[]) =>
    values.length ? values.join(', ') : 'None';
  const state = (value: string) => value.replaceAll('_', ' ');
  paragraph(`Canonical report SHA-256: ${reportDigest}`, 'muted');
  paragraph(
    `Report ${report.reportId} | Version ${report.reportVersion}\nAudit ${report.auditId}\nRevision ${report.revisionId}\nCreated ${report.createdAt}\nReport retention ends ${report.expiresAt}`,
    'muted',
  );
  paragraph(
    `Coverage at report creation: ${state(report.coverage)}. This describes the audited scope, not a certificate of simulation correctness. Evidence may expire before the report; review the retention dates below.`,
    report.coverage === 'limited' ? 'warning' : 'normal',
  );
  heading('Scope and summary');
  paragraph(report.scope);
  paragraph(report.summary);
  if (report.incompleteReasons.length) {
    heading('Incomplete work');
    for (const reason of report.incompleteReasons) paragraph(reason, 'warning');
  }
  heading('Assumptions');
  if (!report.assumptions.length)
    paragraph(
      'No assumptions were recorded. This is not evidence that the model has no assumptions.',
      'muted',
    );
  for (const item of report.assumptions)
    paragraph(
      `${item.statement}\nBasis: ${state(item.basis)}\nAssumption ${item.id}\nEvidence: ${ids(item.evidenceIds)}`,
    );
  heading('Unanswered questions');
  if (!report.unansweredQuestions.length)
    paragraph('No unanswered questions were recorded.', 'muted');
  for (const question of report.unansweredQuestions) {
    paragraph(
      `${question.prompt}\nReason: ${question.reason}\nOptions: ${question.options.map((option) => `${option.label}${option.unknown ? ' (unknown)' : ''}`).join('; ')}\nCustom text is allowed.\nRequired facts: ${ids(question.requiredFacts)}\nAffected checks: ${ids(question.affectedChecks)}\nQuestion ${question.id} (${question.key})`,
      'warning',
    );
  }
  heading('Readiness');
  paragraph(
    `${report.readiness.status === null ? 'Not assessed' : state(report.readiness.status)}\n${report.readiness.explanation}\nEvidence: ${ids(report.readiness.evidenceIds)}`,
  );
  heading('Adapter verification');
  paragraph(
    `${state(report.adapter.status)}\n${report.adapter.explanation}\nCompared elements: ${report.adapter.comparedElements ?? 'Not recorded'}\nEvidence: ${ids(report.adapter.evidenceIds)}`,
  );
  heading('Selected and excluded checks');
  if (!report.checks.length)
    paragraph(
      'No check plan is available. No check result is implied.',
      'warning',
    );
  for (const check of report.checks) {
    paragraph(
      `${check.checkId} ${check.checkVersion}: ${state(check.selection)}\nReasons: ${check.reasons.join('; ')}\nProcedure: ${check.procedure}\nRequired observations: ${ids(check.requiredObservations)}\nAccuracy policy: ${check.accuracyPolicy}\nMethod references: ${ids(check.referenceIds)}\nExperiments: ${ids(check.experimentIds)}\nMetric evidence: ${ids(check.metricEvidenceIds)}`,
    );
  }
  heading('Experiments and controls');
  if (!report.experiments.length)
    paragraph('No experiments are recorded.', 'muted');
  for (const experiment of report.experiments) {
    paragraph(
      `${experiment.description}: ${state(experiment.status)}\nExperiment ${experiment.id}\nSource operation: ${experiment.sourceOperationId ?? 'Not recorded'}\nResult digest: ${experiment.resultDigest ?? 'Not recorded'}\nControls: ${experiment.controls.map((control) => `${control.name} = ${JSON.stringify(control.value)}${control.unit ? ` ${control.unit}` : ''}`).join('; ') || 'None recorded'}`,
    );
  }
  heading('Numerical evidence');
  if (!report.metrics.length)
    paragraph(
      'No released numerical verdict is available. Missing evidence is not a pass.',
      'warning',
    );
  for (const evidence of report.metrics) {
    paragraph(
      `${evidence.checkId}: ${state(evidence.status)}\n${evidence.metric.name} = ${evidence.metric.value.toString()} ${evidence.metric.unit}\nNormalization: ${evidence.metric.normalization}\nReason: ${state(evidence.reason)}\nEvidence ${evidence.id}\nExperiments: ${ids(evidence.experimentIds)}`,
    );
    for (const [label, support] of [
      ['Target', evidence.target],
      ['Absolute uncertainty bound', evidence.uncertainty],
    ] as const)
      paragraph(
        support
          ? `${label}: ${support.value.toString()} ${support.unit}\nJustification: ${support.justification}\nSupporting evidence: ${ids(support.evidenceIds)}`
          : `${label}: unavailable`,
        support ? 'normal' : 'warning',
      );
    paragraph(
      evidence.interval
        ? `Conservative interval: [${evidence.interval.lower.toString()}, ${evidence.interval.upper.toString()}] ${evidence.metric.unit}`
        : 'Conservative interval: unavailable',
      evidence.interval ? 'normal' : 'warning',
    );
    for (const limitation of evidence.limitations)
      paragraph(`Limitation: ${limitation}`, 'muted');
  }
  heading('Plots');
  if (!report.plots.length) paragraph('No plots are available.', 'muted');
  for (const plot of report.plots) {
    paragraph(
      `${plot.title}\n${plot.description}\nX: ${plot.xLabel} [${plot.xUnit}]\nY: ${plot.yLabel} [${plot.yUnit}]\nPlot ${plot.id}\nEvidence: ${ids(plot.evidenceIds)}`,
    );
    blocks.push({ kind: 'plot', plot });
    for (const [index, series] of plot.series.entries())
      paragraph(
        `S${index + 1} - ${series.label}: ${series.points.length} displayed / ${series.originalPointCount} original points; experiment ${series.experimentId}. ${series.points.length < series.originalPointCount ? 'Display data are downsampled; they are not the numerical calculation.' : 'No display downsampling is recorded.'}`,
        'muted',
      );
  }
  heading('Evidence-based observations');
  if (!report.narrative.facts.length)
    paragraph('No investigation observations are available.', 'muted');
  for (const item of report.narrative.facts)
    paragraph(`${item.text}\nEvidence: ${ids(item.evidenceIds)}`);
  heading('Possible causes - hypotheses');
  if (!report.narrative.hypotheses.length)
    paragraph('No cause has been proposed.', 'muted');
  for (const item of report.narrative.hypotheses)
    paragraph(
      `${item.text}\nHow to investigate: ${item.verification}\nEvidence: ${ids(item.evidenceIds)}`,
    );
  heading('Recommendations');
  if (!report.narrative.recommendations.length)
    paragraph('No recommendations are available.', 'muted');
  for (const item of report.narrative.recommendations)
    paragraph(
      `${item.text}\nHow to validate: ${item.validation}\nEvidence: ${ids(item.evidenceIds)}`,
    );
  heading('Evidence provenance');
  for (const item of report.evidenceCatalog)
    paragraph(
      `${item.id} (${state(item.kind)})\n${item.description}\nDigest: ${item.digest}\nEvidence retention: ${item.expiresAt ?? 'No expiry recorded'}`,
      'muted',
    );
  heading('Method and software references');
  if (!report.references.length)
    paragraph('No references are recorded.', 'muted');
  for (const item of report.references)
    paragraph(
      `${item.id}: ${item.title}\n${item.url}\nAccessed ${item.accessedAt}`,
    );
  heading('Artifacts and availability');
  if (!report.artifacts.length)
    paragraph(
      'No raw artifacts are listed. Reproduction may be limited.',
      'muted',
    );
  for (const item of report.artifacts)
    paragraph(
      `${item.displayName} (${state(item.kind)})\nArtifact ${item.artifactId}\nSHA-256: ${item.sha256}\nBytes: ${item.bytes}\nAvailability at report creation: ${state(item.availabilityAtCreation)}\nRaw artifact retention ends ${item.expiresAt}`,
      item.availabilityAtCreation === 'available' ? 'normal' : 'warning',
    );
  heading('Versions and reproduction');
  paragraph(
    `Input digest: ${report.inputDigest}\nContext digest: ${report.contextDigest ?? 'Unavailable'}\nAdapter digest: ${report.adapterDigest ?? 'Unavailable'}\nPlan digest: ${report.planDigest ?? 'Unavailable'}`,
    'muted',
  );
  for (const item of report.software)
    paragraph(
      `${item.name} ${item.version}\nDigest: ${item.digest ?? 'Not recorded'}`,
    );
  for (const instruction of report.reproduction.instructions)
    paragraph(instruction);
  paragraph(
    `Reproduction artifacts: ${ids(report.reproduction.artifactIds)}`,
    'muted',
  );
  for (const limitation of report.reproduction.limitations)
    paragraph(`Reproduction limitation: ${limitation}`, 'warning');
  heading('Limitations');
  for (const limitation of report.limitations) paragraph(limitation, 'warning');
  return PdfRenderDocument.parse({
    schemaVersion: '1.0',
    reportId: report.reportId,
    auditId: report.auditId,
    revisionId: report.revisionId,
    reportDigest,
    title: report.title,
    domain: report.domain,
    createdAt: report.createdAt,
    coverage: report.coverage,
    blocks,
  });
}
