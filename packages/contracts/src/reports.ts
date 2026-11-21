import { z } from 'zod';
import {
  CheckId,
  Count,
  Digest,
  Domain,
  Finite,
  Id,
  ReadinessStatus,
  SchemaVersion,
  Timestamp,
} from './common.js';
import { MetricEvidence } from './evidence.js';
import { Question } from './questions.js';

/** Plain display text, never HTML, executable code, a path or a template. */
const text = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine(
      (value) => {
        for (const character of value) {
          const code = character.codePointAt(0) ?? 0;
          if (
            (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
            (code >= 0x7f && code <= 0x9f) ||
            (code >= 0xd800 && code <= 0xdfff)
          )
            return false;
        }
        return true;
      },
      {
        message:
          'Report text contains unsupported control or surrogate characters',
      },
    );
export const reportText = text;
const references = z.array(Id).min(1).max(20);
const Version = z.string().min(1).max(100);

export const ReportCheck = z.strictObject({
  checkId: CheckId,
  checkVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  selection: z.enum(['selected', 'excluded', 'unresolved']),
  reasons: z.array(text(1000)).min(1).max(20),
  procedure: text(2000),
  requiredObservations: z.array(text(100)).max(20),
  accuracyPolicy: text(2000),
  referenceIds: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(10),
  experimentIds: z.array(Id).max(8),
  metricEvidenceIds: z.array(Id).max(20),
});

export const ReportExperiment = z.strictObject({
  id: Id,
  description: text(1000),
  status: z.enum(['completed', 'failed', 'not_run', 'cancelled']),
  controls: z
    .array(
      z.strictObject({
        name: text(100),
        value: z.union([Finite, text(500), z.boolean(), z.null()]),
        unit: text(80).nullable(),
      }),
    )
    .max(20),
  sourceOperationId: Id.nullable(),
  resultDigest: Digest.nullable(),
});

export const ReportPlot = z.strictObject({
  id: Id,
  title: text(300),
  kind: z.enum(['line', 'scatter']),
  xLabel: text(100),
  xUnit: text(80),
  yLabel: text(100),
  yUnit: text(80),
  evidenceIds: references,
  description: text(1000),
  series: z
    .array(
      z.strictObject({
        label: text(200),
        experimentId: Id,
        originalPointCount: Count.refine((n) => n > 0),
        points: z
          .array(z.strictObject({ x: Finite, y: Finite }))
          .min(1)
          .max(2000),
      }),
    )
    .min(1)
    .max(4),
});

/** A shared screen/PDF document, not publication authority or a correctness
 * certificate. Trusted assembly must resolve all referenced evidence first.
 * PDF availability is external metadata, avoiding a report/PDF digest cycle.
 */
export const EvidenceReport = z
  .strictObject({
    schemaVersion: SchemaVersion,
    reportId: Id,
    reportVersion: Count.refine((n) => n > 0),
    auditId: Id,
    revisionId: Id,
    inputDigest: Digest,
    domain: Domain,
    contextDigest: Digest.nullable(),
    adapterDigest: Digest.nullable(),
    planDigest: Digest.nullable(),
    title: text(200),
    scope: text(2000),
    summary: text(4000),
    createdAt: Timestamp,
    expiresAt: Timestamp,
    coverage: z.enum(['full', 'limited']),
    incompleteReasons: z.array(text(1000)).max(20),
    assumptions: z
      .array(
        z.strictObject({
          id: Id,
          statement: text(1000),
          basis: z.enum([
            'user_declaration',
            'verified_evidence',
            'unresolved',
          ]),
          evidenceIds: z.array(Id).max(20),
        }),
      )
      .max(40),
    unansweredQuestions: z.array(Question).max(20),
    readiness: z.strictObject({
      status: ReadinessStatus.nullable(),
      explanation: text(2000),
      evidenceIds: z.array(Id).max(20),
    }),
    adapter: z.strictObject({
      status: z.enum([
        'not_attempted',
        'baseline_matched',
        'baseline_mismatched',
        'verified',
        'inconclusive',
      ]),
      explanation: text(2000),
      evidenceIds: z.array(Id).max(20),
      comparedElements: Count.nullable(),
    }),
    checks: z.array(ReportCheck).max(10),
    experiments: z.array(ReportExperiment).max(8),
    metrics: z.array(MetricEvidence).max(40),
    plots: z.array(ReportPlot).max(8),
    narrative: z.strictObject({
      facts: z
        .array(z.strictObject({ text: text(2000), evidenceIds: references }))
        .max(20),
      hypotheses: z
        .array(
          z.strictObject({
            text: text(2000),
            evidenceIds: references,
            verification: text(2000),
          }),
        )
        .max(20),
      recommendations: z
        .array(
          z.strictObject({
            text: text(2000),
            evidenceIds: references,
            validation: text(2000),
          }),
        )
        .max(20),
    }),
    evidenceCatalog: z
      .array(
        z.strictObject({
          id: Id,
          kind: z.enum([
            'source',
            'inspection',
            'context',
            'adapter_verification',
            'plan',
            'experiment',
            'target',
            'uncertainty',
            'metric',
            'diagnostic',
            'investigation',
          ]),
          digest: Digest,
          description: text(1000),
          expiresAt: Timestamp.nullable(),
        }),
      )
      .max(150),
    references: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
          title: text(500),
          url: z
            .url({ protocol: /^https$/ })
            .max(2000)
            .refine((value) => {
              const url = new URL(value);
              return !url.username && !url.password;
            }),
          accessedAt: Timestamp,
        }),
      )
      .max(40),
    artifacts: z
      .array(
        z.strictObject({
          artifactId: Id,
          displayName: text(200),
          kind: z.enum([
            'source',
            'numeric_input',
            'observation',
            'chart',
            'log',
          ]),
          sha256: Digest,
          bytes: Count,
          expiresAt: Timestamp,
          availabilityAtCreation: z.enum([
            'available',
            'expired',
            'unavailable',
          ]),
        }),
      )
      .max(40),
    software: z
      .array(
        z.strictObject({
          name: text(100),
          version: Version,
          digest: Digest.nullable(),
        }),
      )
      .min(1)
      .max(30),
    reproduction: z.strictObject({
      instructions: z.array(text(2000)).max(20),
      artifactIds: z.array(Id).max(40),
      limitations: z.array(text(1000)).min(1).max(20),
    }),
    limitations: z.array(text(1000)).min(1).max(30),
  })
  .superRefine((report, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const unique = (values: readonly string[], label: string) => {
      if (new Set(values).size !== values.length) fail(`Duplicate ${label}`);
    };
    const date = Date.parse(report.createdAt);
    if (Date.parse(report.expiresAt) <= date)
      fail('Report expiry must follow creation');
    for (const [values, label] of [
      [report.checks.map((v) => v.checkId), 'check'],
      [report.experiments.map((v) => v.id), 'experiment'],
      [report.metrics.map((v) => v.id), 'metric'],
      [report.evidenceCatalog.map((v) => v.id), 'evidence'],
      [report.plots.map((v) => v.id), 'plot'],
      [report.artifacts.map((v) => v.artifactId), 'artifact'],
      [report.references.map((v) => v.id), 'reference'],
      [report.assumptions.map((v) => v.id), 'assumption'],
      [report.unansweredQuestions.map((v) => v.id), 'question'],
      [report.unansweredQuestions.map((v) => v.key), 'question key'],
      [report.software.map((v) => v.name), 'software'],
    ] as const)
      unique(values, label);
    const catalog = new Map(report.evidenceCatalog.map((v) => [v.id, v]));
    const link = (ids: readonly string[]) => {
      unique(ids, 'evidence reference');
      for (const id of ids)
        if (!catalog.has(id)) fail('Dangling evidence reference');
    };
    const artifacts = new Map(report.artifacts.map((v) => [v.artifactId, v]));
    const experiments = new Map(report.experiments.map((v) => [v.id, v]));
    const metrics = new Map(report.metrics.map((v) => [v.id, v]));
    const referenceIds = new Set(report.references.map((v) => v.id));
    const assigned = new Set<string>();
    for (const assumption of report.assumptions) {
      link(assumption.evidenceIds);
      if (
        assumption.basis === 'verified_evidence' &&
        !assumption.evidenceIds.length
      )
        fail('Verified assumptions require evidence');
    }
    link(report.readiness.evidenceIds);
    link(report.adapter.evidenceIds);
    if (
      report.readiness.status !== null &&
      !report.readiness.evidenceIds.length
    )
      fail('Readiness requires evidence');
    if (
      report.adapter.status !== 'not_attempted' &&
      !report.adapter.evidenceIds.length
    )
      fail('Adapter outcome requires evidence');
    if (
      ['baseline_matched', 'baseline_mismatched', 'verified'].includes(
        report.adapter.status,
      ) &&
      (report.adapter.comparedElements === null ||
        report.adapter.comparedElements < 1)
    )
      fail('Baseline outcome requires compared elements');
    if (
      report.adapter.status === 'not_attempted' &&
      report.adapter.comparedElements !== null
    )
      fail('Unattempted adapter cannot claim comparisons');
    for (const check of report.checks) {
      if (
        (report.domain === 'heat_diffusion') !==
        check.checkId.startsWith('H_')
      )
        fail('Check domain mismatch');
      unique(check.referenceIds, 'method reference');
      unique(check.experimentIds, 'check experiment');
      unique(check.metricEvidenceIds, 'check metric');
      if (check.referenceIds.some((id) => !referenceIds.has(id)))
        fail('Dangling method reference');
      if (
        check.selection !== 'selected' &&
        (check.experimentIds.length || check.metricEvidenceIds.length)
      )
        fail('Unselected check cannot claim experiments or results');
      if (
        check.selection === 'selected' &&
        (!report.planDigest ||
          !report.contextDigest ||
          !report.adapterDigest ||
          !check.referenceIds.length ||
          !check.experimentIds.length)
      )
        fail(
          'Selected checks require plan, context, adapter, methods and experiments',
        );
      if (check.experimentIds.some((id) => !experiments.has(id)))
        fail('Dangling experiment reference');
      for (const id of check.metricEvidenceIds) {
        const metric = metrics.get(id);
        if (
          !metric ||
          metric.checkId !== check.checkId ||
          metric.checkVersion !== check.checkVersion ||
          assigned.has(id) ||
          metric.experimentIds.some(
            (experimentId) => !check.experimentIds.includes(experimentId),
          )
        )
          fail('Metric does not belong to exactly one matching check');
        assigned.add(id);
      }
    }
    if (assigned.size !== metrics.size)
      fail('Every metric must belong to a selected check');
    const usedExperiments = new Set(
      report.checks.flatMap((v) => v.experimentIds),
    );
    for (const experiment of report.experiments) {
      if (!usedExperiments.has(experiment.id))
        fail('Experiment must belong to a selected check');
      unique(
        experiment.controls.map((v) => v.name),
        'experiment control',
      );
      if (
        experiment.status === 'completed' &&
        (!experiment.sourceOperationId || !experiment.resultDigest)
      )
        fail('Completed experiments require provenance');
      if (
        experiment.status === 'not_run' &&
        (experiment.sourceOperationId || experiment.resultDigest)
      )
        fail('Unrun experiment cannot claim results');
    }
    for (const metric of report.metrics) {
      if (
        metric.auditId !== report.auditId ||
        metric.revisionId !== report.revisionId ||
        metric.inputDigest !== report.inputDigest ||
        metric.contextDigest !== report.contextDigest ||
        metric.adapterDigest !== report.adapterDigest ||
        metric.planDigest !== report.planDigest
      )
        fail('Metric snapshot mismatch');
      link([metric.id]);
      if (catalog.get(metric.id)?.kind !== 'metric')
        fail('Metric catalog kind mismatch');
      for (const supporting of [metric.target, metric.uncertainty])
        if (supporting) link(supporting.evidenceIds);
      if (
        metric.experimentIds.some(
          (id) => experiments.get(id)?.status !== 'completed',
        )
      )
        fail('Metrics require completed experiments');
    }
    for (const item of [
      ...report.narrative.facts,
      ...report.narrative.hypotheses,
      ...report.narrative.recommendations,
    ])
      link(item.evidenceIds);
    let pointCount = 0;
    for (const plot of report.plots) {
      link(plot.evidenceIds);
      unique(
        plot.series.map((series) => series.label),
        'plot series',
      );
      for (const series of plot.series) {
        if (
          experiments.get(series.experimentId)?.status !== 'completed' ||
          series.originalPointCount < series.points.length
        )
          fail('Plot provenance or point count mismatch');
        pointCount += series.points.length;
      }
    }
    if (pointCount > 16000) fail('Report plot point budget exceeded');
    for (const artifact of report.artifacts) {
      if (
        (artifact.availabilityAtCreation === 'available' &&
          Date.parse(artifact.expiresAt) <= date) ||
        (artifact.availabilityAtCreation === 'expired' &&
          Date.parse(artifact.expiresAt) > date)
      )
        fail('Artifact availability contradicts expiry');
    }
    unique(report.reproduction.artifactIds, 'reproduction artifact');
    if (report.reproduction.artifactIds.some((id) => !artifacts.has(id)))
      fail('Dangling reproduction artifact');
    if (report.coverage === 'limited' && !report.incompleteReasons.length)
      fail('Limited reports require reasons');
    if (
      report.coverage === 'full' &&
      (report.incompleteReasons.length ||
        report.unansweredQuestions.length ||
        report.assumptions.some((v) => v.basis === 'unresolved') ||
        report.readiness.status !== 'ready' ||
        report.adapter.status !== 'verified' ||
        !report.planDigest ||
        !report.contextDigest ||
        !report.adapterDigest ||
        !report.checks.some((v) => v.selection === 'selected') ||
        report.checks.some(
          (v) =>
            v.selection === 'unresolved' ||
            (v.selection === 'selected' && !v.metricEvidenceIds.length),
        ) ||
        report.experiments.some((v) => v.status !== 'completed') ||
        report.evidenceCatalog.some(
          (v) => v.expiresAt !== null && Date.parse(v.expiresAt) <= date,
        ))
    )
      fail('Incomplete evidence cannot claim full coverage');
    if (new TextEncoder().encode(JSON.stringify(report)).length > 256 * 1024)
      fail('Report exceeds canonical payload limit');
  });
export type EvidenceReport = z.infer<typeof EvidenceReport>;

export const ReportPdfAvailability = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    artifactId: Id,
    sha256: Digest,
    bytes: Count.refine((n) => n > 0),
    expiresAt: Timestamp,
  }),
  ...(['not_ready', 'failed', 'unavailable', 'expired'] as const).map(
    (status) => z.strictObject({ status: z.literal(status) }),
  ),
]);
export const EvidenceReportResponse = z.strictObject({
  schemaVersion: SchemaVersion,
  report: EvidenceReport,
  reportDigest: Digest,
  pdf: ReportPdfAvailability,
  retention: z.strictObject({
    checkedAt: Timestamp,
    expiredEvidenceIds: z.array(Id).max(150),
    expiredArtifactIds: z.array(Id).max(40),
  }),
});
