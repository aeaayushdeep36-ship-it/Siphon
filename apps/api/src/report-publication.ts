import { z } from 'zod';
import {
  EvidenceReport,
  Id,
  ResourcePolicy,
  Timestamp,
  DEFAULT_POLICY,
  AdapterProposal,
  BaselineComparison,
  ContextProposal,
  DiagnosticJobResult,
  MetricEvidence,
  AuditPlan,
} from '@siphon/contracts';
import { type DocumentStore, type DocumentTransaction } from './firestore.js';
import { Operation, BudgetCounter } from './accounting.js';
import { requireActiveRevision, nativeTimestamps } from './audit-commands.js';
import { canonicalJson, sha256 } from './hashing.js';
import { SandboxRequest } from './e2b-client.js';
import { SandboxTermination } from './sandbox-termination.js';
import { buildPdfDocument } from './report-layout.js';
import {
  MAX_PDF_BYTES,
  PdfReceipt,
  type PdfExecutionGate,
} from './pdf-runner.js';
import { type UploadObjectStore } from './r2-upload.js';
import { DispatchFence, authorize } from './audit-commands.js';
import { RETENTION } from './retention.js';
import { HeatParameterValues } from './scientific-parameters.js';
import { readInvestigationReview } from './investigation-review.js';

/** Builds the report from actual trusted stage records. No report-shaped caller
 * payload, model-supplied verdicts, numerical values or evidence URLs are accepted. */
export class ReportPublication {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async assembleAndPublish(
    uid: string,
    expected: unknown,
    options: { reportId: string; conservationOperationIds: string[] },
  ) {
    const fence = DispatchFence.parse(expected);
    const reportId = Id.parse(options.reportId);
    const ids = z
      .array(Id)
      .min(1)
      .max(1)
      .refine((value) => new Set(value).size === value.length)
      .parse(options.conservationOperationIds);
    return this.store.transaction(async (tx) => {
      const state = await requireActiveRevision(tx, uid, fence);
      if (state.stage !== 'reporting')
        throw new Error('Report publication requires reporting stage');
      const audit = await authorize(tx, uid, fence.auditId, false);
      const base = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
      const [
        revision,
        rawContext,
        rawAdapter,
        rawPlan,
        prior,
        outputRaw,
        rawParameters,
      ] = await tx.getMany([
        base,
        `${base}/context/current`,
        `${base}/adapters/current`,
        `${base}/plans/current`,
        `${base}/reports/${reportId}`,
        `budgets/revision_output_bytes_${fence.revisionId}`,
        `${base}/scientificParameters/current`,
      ]);
      if (!rawContext || !rawAdapter || !rawPlan)
        throw new Error('Trusted report stage records missing');
      const context = ContextProposal.parse(rawContext.proposal),
        adapter = AdapterProposal.parse(rawAdapter.proposal),
        baseline = BaselineComparison.parse(rawAdapter.baseline),
        plan = AuditPlan.parse(rawPlan.plan);
      const contextDigest = await sha256(canonicalJson(context)),
        adapterDigest = await sha256(canonicalJson(adapter)),
        planDigest = await sha256(canonicalJson(plan));
      for (const record of [rawContext, rawAdapter, rawPlan])
        if (record.ownerUid !== uid || record.inputDigest !== fence.inputDigest)
          throw new Error('Report provenance owner/input mismatch');
      for (const value of [context, adapter, plan])
        if (
          value.auditId !== fence.auditId ||
          value.revisionId !== fence.revisionId ||
          value.inputDigest !== fence.inputDigest ||
          value.domain !== audit.domain
        )
          throw new Error('Report snapshot mismatch');
      if (
        rawContext.proposalDigest !== contextDigest ||
        rawAdapter.adapterDigest !== adapterDigest ||
        rawPlan.planDigest !== planDigest ||
        adapter.contextDigest !== contextDigest ||
        plan.contextDigest !== contextDigest ||
        plan.adapterDigest !== adapterDigest ||
        rawAdapter.status !== 'verified' ||
        baseline.status !== 'matched'
      )
        throw new Error('Report context/adapter/plan integrity mismatch');
      const now = this.clock(),
        createdAt = prior
          ? Timestamp.parse(prior.createdAt)
          : now.toISOString();
      const expiresAt = prior
        ? Timestamp.parse(prior.expiresAt)
        : new Date(
            now.getTime() + RETENTION.reportDays * 86400000,
          ).toISOString();
      const catalog: EvidenceReport['evidenceCatalog'] = [];
      const add = (item: EvidenceReport['evidenceCatalog'][number]) => {
        const old = catalog.find((value) => value.id === item.id);
        if (old && canonicalJson(old) !== canonicalJson(item))
          throw new Error('Conflicting authoritative evidence identifiers');
        if (!old) catalog.push(item);
      };
      const contextId = Id.parse(rawContext.operationId),
        originalId = Id.parse(rawAdapter.originalOperationId),
        adaptedId = Id.parse(rawAdapter.adaptedOperationId);
      add({
        id: contextId,
        kind: 'context',
        digest: contextDigest,
        description:
          'AI context proposal; candidate interpretations remain unverified.',
        expiresAt: null,
      });
      add({
        id: plan.id,
        kind: 'plan',
        digest: planDigest,
        description:
          'Deterministic selected/excluded plan and declared reported-sample accuracy policies.',
        expiresAt: Timestamp.parse(rawPlan.expiresAt),
      });
      add({
        id: adaptedId,
        kind: 'adapter_verification',
        digest: await sha256(canonicalJson(baseline)),
        description:
          'Exact original/adapted exported-array baseline comparison.',
        expiresAt: Timestamp.parse(rawAdapter.expiresAt),
      });
      const metrics: MetricEvidence[] = [],
        results = new Map<
          string,
          { sourceOperationId: string; reportDigest: string }
        >();
      const assumptions: EvidenceReport['assumptions'] = [];
      for (const operationId of ids) {
        const [record, rawOperation, rawTermination, rawJob] = await tx.getMany(
          [
            `${base}/evidence/${operationId}`,
            `operations/${operationId}`,
            `sandboxTerminations/${operationId}`,
            `sandboxJobs/${operationId}`,
          ],
        );
        if (!record) throw new Error('Trusted conservation evidence missing');
        const operation = Operation.parse(rawOperation),
          termination = SandboxTermination.parse(rawTermination);
        const sandboxRequest = SandboxRequest.parse(rawJob?.request);
        const result = z
          .strictObject({
            schemaVersion: z.literal('1.0'),
            diagnostics: DiagnosticJobResult,
            evidence: z.array(MetricEvidence).min(1).max(3),
          })
          .parse(record.report);
        const digest = await sha256(canonicalJson(result)),
          diagnostics = result.diagnostics;
        if (audit.domain === 'heat_diffusion') {
          const values = HeatParameterValues.parse(rawParameters?.parameters);
          if (
            rawParameters?.ownerUid !== uid ||
            rawParameters.auditId !== fence.auditId ||
            rawParameters.revisionId !== fence.revisionId ||
            rawParameters.inputDigest !== fence.inputDigest ||
            rawParameters.planDigest !== planDigest ||
            rawParameters.declaration !== 'user_supplied' ||
            rawParameters.parametersDigest !==
              (await sha256(canonicalJson(values))) ||
            !(
              diagnostics.profile.kind === 'heat_energy_si' ||
              diagnostics.profile.kind === 'heat_balance_si'
            ) ||
            diagnostics.profile.densityKgM3 !== values.densityKgM3 ||
            diagnostics.profile.heatCapacityJKgK !== values.heatCapacityJKgK
          )
            throw new Error(
              'Report thermal declarations differ from evaluated values',
            );
          assumptions.push({
            id: operationId,
            statement: `The user declared constant density ${values.densityKgM3} kg/m³ and specific heat capacity ${values.heatCapacityJKgK} J/(kg·K).`,
            basis: 'user_declaration',
            evidenceIds: [operationId],
          });
        }
        if (
          record.ownerUid !== uid ||
          record.auditId !== fence.auditId ||
          record.revisionId !== fence.revisionId ||
          record.operationId !== operationId ||
          record.inputDigest !== fence.inputDigest ||
          record.contextDigest !== contextDigest ||
          record.adapterDigest !== adapterDigest ||
          record.planDigest !== planDigest ||
          record.reportDigest !== digest ||
          Date.parse(Timestamp.parse(record.expiresAt)) <= now.getTime() ||
          operation.id !== operationId ||
          operation.ownerUid !== uid ||
          operation.auditId !== fence.auditId ||
          operation.revisionId !== fence.revisionId ||
          operation.inputDigest !== fence.inputDigest ||
          operation.fence > fence.generation ||
          operation.outcome === 'reserved' ||
          sandboxRequest.role !== 'evaluation' ||
          sandboxRequest.operationId !== operationId ||
          sandboxRequest.auditId !== fence.auditId ||
          sandboxRequest.revisionId !== fence.revisionId ||
          sandboxRequest.inputDigest !== fence.inputDigest ||
          rawJob?.requestDigest !== operation.requestDigest ||
          (await sha256(canonicalJson(sandboxRequest))) !==
            operation.requestDigest ||
          termination.operationId !== operationId ||
          termination.sandboxId !== operation.providerHandle ||
          termination.ownerUid !== uid ||
          termination.auditId !== fence.auditId ||
          termination.revisionId !== fence.revisionId ||
          termination.inputDigest !== fence.inputDigest ||
          termination.requestDigest !== operation.requestDigest ||
          diagnostics.operationId !== operationId ||
          diagnostics.auditId !== fence.auditId ||
          diagnostics.revisionId !== fence.revisionId ||
          diagnostics.inputDigest !== fence.inputDigest ||
          diagnostics.contextDigest !== contextDigest ||
          diagnostics.adapterDigest !== adapterDigest ||
          diagnostics.sourceOperationId !== adaptedId
        )
          throw new Error(
            'Conservation evidence snapshot/termination mismatch',
          );
        add({
          id: operationId,
          kind: 'diagnostic',
          digest,
          description:
            'Trusted data-only reported-sample conservation evaluation.',
          expiresAt: Timestamp.parse(record.expiresAt),
        });
        for (const metric of result.evidence) {
          if (
            metric.auditId !== fence.auditId ||
            metric.revisionId !== fence.revisionId ||
            metric.inputDigest !== fence.inputDigest ||
            metric.contextDigest !== contextDigest ||
            metric.adapterDigest !== adapterDigest ||
            metric.planDigest !== planDigest
          )
            throw new Error('Metric snapshot mismatch');
          const selected = plan.checks.find(
            (check) => check.checkId === metric.checkId,
          );
          if (
            selected?.selection !== 'selected' ||
            selected.checkVersion !== metric.checkVersion ||
            metric.experimentIds.some(
              (id) => !selected.experimentIds.includes(id),
            )
          )
            throw new Error('Metric is not assigned to trusted selected plan');
          const accuracyPolicy = plan.accuracyPolicies[metric.checkId];
          if (
            !accuracyPolicy ||
            accuracyPolicy.scope !== 'reported_samples' ||
            canonicalJson(metric.target) !==
              canonicalJson(accuracyPolicy.target)
          )
            throw new Error('Metric target does not match trusted plan policy');
          metrics.push(metric);
          add({
            id: metric.id,
            kind: 'metric',
            digest: await sha256(canonicalJson(metric)),
            description: `${metric.checkId}: ${metric.metric.name}; ${metric.status}.`,
            expiresAt: Timestamp.parse(record.expiresAt),
          });
          for (const experimentId of metric.experimentIds) {
            const old = results.get(experimentId);
            if (old && old.reportDigest !== digest)
              throw new Error('Experiment has conflicting evaluator results');
            results.set(experimentId, {
              sourceOperationId: diagnostics.sourceOperationId,
              reportDigest: digest,
            });
          }
        }
      }
      // Source execution operation records bind both baseline identities; no
      // filename-based evidence or caller references are synthesized.
      const [originalOperation, adaptedOperation, adaptedOutput] =
        await tx.getMany([
          `operations/${originalId}`,
          `operations/${adaptedId}`,
          `sourceOutputPlans/${adaptedId}`,
        ]);
      for (const [id, raw] of [
        [originalId, originalOperation],
        [adaptedId, adaptedOperation],
      ] as const) {
        const operation = Operation.parse(raw);
        if (
          operation.id !== id ||
          operation.ownerUid !== uid ||
          operation.auditId !== fence.auditId ||
          operation.revisionId !== fence.revisionId ||
          operation.inputDigest !== fence.inputDigest ||
          operation.outcome === 'reserved'
        )
          throw new Error('Baseline source operation mismatch');
      }
      if (
        adaptedOutput?.operationId !== adaptedId ||
        adaptedOutput.ownerUid !== uid ||
        adaptedOutput.auditId !== fence.auditId ||
        adaptedOutput.revisionId !== fence.revisionId ||
        adaptedOutput.status !== 'stored'
      )
        throw new Error('Adapted baseline output is not durably stored');
      const experiments = plan.experiments.map((experiment) => {
        const result = results.get(experiment.id);
        if (!result) return experiment;
        if (
          experiment.id !== adaptedId ||
          experiment.sourceOperationId !== adaptedId ||
          experiment.status !== 'completed' ||
          experiment.resultDigest !== adaptedOutput.outputDigest
        )
          throw new Error(
            'Report experiment does not resolve to stored source output',
          );
        return {
          ...experiment,
        };
      });
      const checks = plan.checks.map((check) => ({
        ...check,
        metricEvidenceIds: metrics
          .filter((metric) => metric.checkId === check.checkId)
          .map((metric) => metric.id),
      }));
      for (const metric of metrics)
        for (const support of [metric.target, metric.uncertainty])
          for (const id of support?.evidenceIds ?? [])
            if (!catalog.some((item) => item.id === id))
              throw new Error('Metric support lacks authoritative reference');
      const investigation = await readInvestigationReview(
        tx,
        uid,
        fence,
        this.clock,
      );
      if (investigation?.status === 'awaiting_review')
        throw new Error('Investigation text requires owner review');
      const accepted =
        investigation?.status === 'accepted' ? investigation.draft : null;
      if (accepted && investigation)
        add({
          id: investigation.operationId,
          kind: 'investigation',
          digest: investigation.draftDigest,
          description: `Advisory investigation generated by ${investigation.provider}/${investigation.model} and accepted by the owner. Hypotheses remain unverified.`,
          expiresAt: investigation.expiresAt,
        });
      const report = EvidenceReport.parse({
        schemaVersion: '1.0',
        reportId,
        reportVersion: 1,
        auditId: fence.auditId,
        revisionId: fence.revisionId,
        inputDigest: fence.inputDigest,
        domain: audit.domain,
        contextDigest,
        adapterDigest,
        planDigest,
        title: audit.title,
        scope:
          'Reported-sample conservation audit of immutable uploaded simulation output, with exact exported-array adapter baseline verification.',
        summary: `${metrics.length} conservation measurement(s): ${metrics.filter((item) => item.status === 'passed_within_tolerance').length} within declared targets, ${metrics.filter((item) => item.status === 'flagged').length} flagged, ${metrics.filter((item) => item.status === 'inconclusive').length} inconclusive. Results apply only to reported samples and the listed model assumptions.`,
        createdAt,
        expiresAt,
        coverage: 'limited',
        incompleteReasons: [
          'Reported-sample conservation does not establish continuous-time, trajectory, discretization or physical correctness. Additional accuracy and refinement checks are unavailable in this release.',
          ...(!accepted
            ? [
                investigation?.status === 'omitted'
                  ? 'The owner omitted AI advisory investigation text after review.'
                  : 'AI advisory investigation is unavailable; only deterministic numerical interpretation is included.',
              ]
            : []),
        ],
        assumptions,
        unansweredQuestions: [],
        readiness: {
          status: null,
          explanation:
            'Only the prerequisites resolved by the trusted selected plan are asserted here; no global readiness certificate is issued.',
          evidenceIds: [plan.id],
        },
        adapter: {
          status: 'verified',
          explanation:
            'Original and adapted deterministic exported arrays matched exactly under the supported extraction contract.',
          evidenceIds: [adaptedId],
          comparedElements: baseline.comparedElements,
        },
        checks,
        experiments,
        metrics,
        plots: [],
        narrative: {
          facts: metrics.map((metric) => ({
            text: `${metric.checkId}: ${metric.metric.name} = ${metric.metric.value} ${metric.metric.unit}; ${metric.status}. Reason: ${metric.reason}.`,
            evidenceIds: [metric.id],
          })),
          hypotheses: accepted?.hypotheses ?? [],
          recommendations:
            accepted?.recommendations ??
            metrics
              .filter((metric) => metric.status !== 'passed_within_tolerance')
              .map((metric) => ({
                text:
                  metric.status === 'inconclusive'
                    ? 'Resolve the missing accuracy target or uncertainty support before interpreting this measurement as a pass or flag.'
                    : 'Investigate the flagged reported-sample invariant drift; this observation alone does not diagnose a code defect.',
                evidenceIds: [metric.id],
                validation:
                  'Repeat a separately budgeted audit with justified targets and controlled numerical refinement; compare the same physical horizon and preserve model assumptions.',
              })),
        },
        evidenceCatalog: catalog,
        references: plan.references,
        artifacts: [],
        software: [
          {
            name: 'Siphon reported-sample conservation evaluator',
            version: '0.1.0',
            digest: null,
          },
        ],
        reproduction: {
          instructions: [
            'Use the immutable revision input digest, adapter mappings and plan snapshot to reproduce the recorded observations in a fresh isolated environment.',
          ],
          artifactIds: [],
          limitations: [
            'Raw artifact retrieval and preservation must be verified separately; this report does not promise indefinite reproduction.',
          ],
        },
        limitations: [
          'Conservation is necessary for the declared model, but conservation alone does not prove physical or numerical correctness.',
          'Arithmetic enclosure describes the represented reported samples; it does not bound omitted samples, input uncertainty, quadrature or discretization error.',
          accepted
            ? 'AI advisory hypotheses and recommendations were reviewed by the owner. Acceptance does not establish their truth or diagnose a code defect; deterministic measurements and verdicts are unchanged.'
            : 'AI context candidates are interpretations, not verified physical facts. No AI investigation or cause diagnosis is claimed.',
        ],
      });
      const reportJson = canonicalJson(report),
        reportDigest = await sha256(reportJson);
      if (prior) {
        if (
          prior.ownerUid !== uid ||
          prior.reportDigest !== reportDigest ||
          prior.reportJson !== reportJson ||
          revision?.reportId !== reportId
        )
          throw new Error('Published report is immutable');
        return { report, reportDigest, replayed: true };
      }
      if (revision?.reportId !== null && revision?.reportId !== undefined)
        throw new Error('Revision already has a report');
      const output = BudgetCounter.parse(outputRaw),
        policy = ResourcePolicy.parse(revision?.policy),
        bytes = new TextEncoder().encode(reportJson).length;
      if (
        output.halted ||
        BigInt(output.spent) + BigInt(output.reserved) + BigInt(bytes) >
          BigInt(
            Math.min(
              output.limit,
              policy.outputBytes,
              DEFAULT_POLICY.outputBytes,
            ),
          )
      )
        throw new Error('Report output budget unavailable');
      tx.set(`budgets/revision_output_bytes_${fence.revisionId}`, {
        ...output,
        spent: output.spent + bytes,
      });
      tx.set(`${base}/reports/${reportId}`, {
        schemaVersion: '1.0',
        reportId,
        ownerUid: uid,
        auditId: fence.auditId,
        revisionId: fence.revisionId,
        inputDigest: fence.inputDigest,
        reportDigest,
        reportJson,
        createdAt: new Date(createdAt),
        expiresAt: new Date(expiresAt),
      });
      tx.set(
        base,
        nativeTimestamps({
          ...revision,
          reportId,
          updatedAt: now.toISOString(),
        }),
      );
      return { report, reportDigest, replayed: false };
    });
  }
}

const periodSchema = z.object({
  counterKey: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  startsAt: Timestamp,
  endsAt: Timestamp,
});

/** Concrete PDF publication authority. Report must already be immutable and
 * published; never accepts caller-selected layout, scientific verdicts or paths.
 * One operation gets one fresh role-bound VM and one create-only accounted PUT.
 */
export class ReportPdfPublications {
  constructor(
    private readonly store: DocumentStore,
    private readonly objects: UploadObjectStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async inspect(tx: DocumentTransaction, operationId: string) {
    Id.parse(operationId);
    const operation = Operation.parse(
      await tx.get(`operations/${operationId}`),
    );
    if (operation.id !== operationId)
      throw new Error('PDF operation key mismatch');
    const state = await requireActiveRevision(tx, operation.ownerUid, {
      auditId: operation.auditId,
      revisionId: operation.revisionId,
      generation: operation.fence,
      inputDigest: operation.inputDigest,
    });
    if (state.stage !== 'reporting')
      throw new Error('PDF requires current reporting stage');
    const revisionPath = `audits/${operation.auditId}/revisions/${operation.revisionId}`;
    const revision = await tx.get(revisionPath);
    const reportId = Id.parse(revision?.reportId);
    const reportPath = `${revisionPath}/reports/${reportId}`;
    const [record, job] = await tx.getMany([
      reportPath,
      `sandboxJobs/${operationId}`,
    ]);
    const report = EvidenceReport.parse(
      JSON.parse(z.string().parse(record?.reportJson)),
    );
    const reportDigest = await sha256(canonicalJson(report));
    const sandbox = SandboxRequest.parse(job?.request);
    const now = this.clock().getTime();
    if (
      record?.ownerUid !== operation.ownerUid ||
      record.auditId !== operation.auditId ||
      record.revisionId !== operation.revisionId ||
      record.reportId !== reportId ||
      record.inputDigest !== operation.inputDigest ||
      report.reportId !== reportId ||
      report.auditId !== operation.auditId ||
      report.revisionId !== operation.revisionId ||
      report.inputDigest !== operation.inputDigest ||
      record.reportJson !== canonicalJson(report) ||
      record.reportDigest !== reportDigest ||
      Date.parse(report.expiresAt) <= now ||
      sandbox.operationId !== operationId ||
      sandbox.role !== 'pdf' ||
      sandbox.auditId !== operation.auditId ||
      sandbox.revisionId !== operation.revisionId ||
      sandbox.inputDigest !== operation.inputDigest ||
      job?.requestDigest !== operation.requestDigest ||
      (await sha256(canonicalJson(sandbox))) !== operation.requestDigest
    )
      throw new Error('PDF report/sandbox snapshot mismatch');
    const document = await buildPdfDocument(report);
    const documentDigest = await sha256(canonicalJson(document));
    const policy = ResourcePolicy.parse(revision?.policy);
    return {
      operation,
      report,
      reportPath,
      reportDigest,
      document,
      documentDigest,
      policy,
      sandbox,
    };
  }

  async bind(operationId: string) {
    return this.store.transaction(async (tx) => {
      const snapshot = await this.inspect(tx, operationId);
      const { operation, report, documentDigest, reportDigest, policy } =
        snapshot;
      const [previous, exported] = await tx.getMany([
        `pdfExecutions/${operationId}`,
        `${snapshot.reportPath}/exports/pdf`,
      ]);
      if (previous) {
        this.assertBinding(previous, snapshot);
        await this.assertReservation(tx, previous);
        if (previous.status !== 'bound')
          throw new Error('PDF execution requires reconciliation');
        return { document: snapshot.document, sandbox: snapshot.sandbox };
      }
      if (operation.outcome !== 'reserved' || exported)
        throw new Error('PDF export already attempted or operation dispatched');
      const outputKey = `revision_output_bytes_${operation.revisionId}`;
      const [rawOutput, rawStorage, reservation] = await tx.getMany([
        `budgets/${outputKey}`,
        'budgets/r2_storage_bytes',
        `reservations/pdf_output_${operationId}`,
      ]);
      if (reservation) throw new Error('PDF reservation conflict');
      const output = BudgetCounter.parse(rawOutput),
        storage = BudgetCounter.parse(rawStorage);
      for (const [counter, cap] of [
        [output, Math.min(policy.outputBytes, DEFAULT_POLICY.outputBytes)],
        [storage, Math.min(policy.storageBytes, DEFAULT_POLICY.storageBytes)],
      ] as const)
        if (
          counter.halted ||
          BigInt(counter.spent) +
            BigInt(counter.reserved) +
            BigInt(MAX_PDF_BYTES) >
            BigInt(Math.min(counter.limit, cap))
        )
          throw new Error('PDF output/storage budget unavailable');
      const now = this.clock();
      const binding = {
        schemaVersion: '1.0',
        operationId,
        ownerUid: operation.ownerUid,
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        inputDigest: operation.inputDigest,
        generation: operation.fence,
        sandboxRequestDigest: operation.requestDigest,
        reportId: report.reportId,
        reportDigest,
        documentDigest,
        artifactId: crypto.randomUUID(),
        sandboxId: null,
        status: 'bound',
        createdAt: now,
        updatedAt: now,
      };
      tx.set(`budgets/${outputKey}`, {
        ...output,
        reserved: output.reserved + MAX_PDF_BYTES,
      });
      tx.set('budgets/r2_storage_bytes', {
        ...storage,
        reserved: storage.reserved + MAX_PDF_BYTES,
      });
      tx.set(`reservations/pdf_output_${operationId}`, {
        ...binding,
        amount: MAX_PDF_BYTES,
        outputCounterKey: outputKey,
        status: 'reserved',
      });
      tx.set(`pdfExecutions/${operationId}`, binding);
      tx.set(`${snapshot.reportPath}/exports/pdf`, {
        schemaVersion: '1.0',
        ownerUid: operation.ownerUid,
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        reportId: report.reportId,
        reportDigest,
        status: 'pending',
        artifactId: null,
        pdfSha256: null,
        bytes: null,
        createdAt: now,
        updatedAt: now,
      });
      return { document: snapshot.document, sandbox: snapshot.sandbox };
    });
  }

  private assertBinding(
    binding: Record<string, unknown>,
    snapshot: Awaited<ReturnType<ReportPdfPublications['inspect']>>,
  ) {
    const { operation } = snapshot;
    if (
      binding.operationId !== operation.id ||
      binding.ownerUid !== operation.ownerUid ||
      binding.auditId !== operation.auditId ||
      binding.revisionId !== operation.revisionId ||
      binding.inputDigest !== operation.inputDigest ||
      binding.generation !== operation.fence ||
      binding.sandboxRequestDigest !== operation.requestDigest ||
      binding.reportId !== snapshot.report.reportId ||
      binding.reportDigest !== snapshot.reportDigest ||
      binding.documentDigest !== snapshot.documentDigest
    )
      throw new Error('PDF execution binding mismatch');
    Id.parse(binding.artifactId);
  }

  private async assertReservation(
    tx: DocumentTransaction,
    binding: Record<string, unknown>,
    settled = false,
  ) {
    const reservation = await tx.get(
      `reservations/pdf_output_${binding.operationId}`,
    );
    if (
      !reservation ||
      reservation.operationId !== binding.operationId ||
      reservation.ownerUid !== binding.ownerUid ||
      reservation.auditId !== binding.auditId ||
      reservation.revisionId !== binding.revisionId ||
      reservation.inputDigest !== binding.inputDigest ||
      reservation.generation !== binding.generation ||
      reservation.sandboxRequestDigest !== binding.sandboxRequestDigest ||
      reservation.reportId !== binding.reportId ||
      reservation.reportDigest !== binding.reportDigest ||
      reservation.documentDigest !== binding.documentDigest ||
      reservation.artifactId !== binding.artifactId ||
      reservation.amount !== MAX_PDF_BYTES ||
      reservation.outputCounterKey !==
        `revision_output_bytes_${binding.revisionId}` ||
      reservation.status !== (settled ? 'settled' : 'reserved')
    )
      throw new Error('PDF output reservation mismatch');
  }

  gate(operationId: string): PdfExecutionGate {
    return {
      claim: async (document, documentDigest, sandboxId) => {
        await this.store.transaction(async (tx) => {
          const snapshot = await this.inspect(tx, operationId);
          const [binding, handle, termination] = await tx.getMany([
            `pdfExecutions/${operationId}`,
            `sandboxHandles/${sandboxId}`,
            `sandboxTerminations/${operationId}`,
          ]);
          if (!binding) throw new Error('PDF not bound');
          this.assertBinding(binding, snapshot);
          await this.assertReservation(tx, binding);
          const { operation } = snapshot;
          if (
            binding.status !== 'bound' ||
            operation.outcome !== 'dispatching' ||
            operation.providerHandle !== sandboxId ||
            handle?.operationId !== operationId ||
            handle.ownerUid !== operation.ownerUid ||
            handle.auditId !== operation.auditId ||
            handle.revisionId !== operation.revisionId ||
            termination ||
            documentDigest !== snapshot.documentDigest ||
            canonicalJson(document) !== canonicalJson(snapshot.document)
          )
            throw new Error('PDF requires fresh bound sandbox');
          tx.set(
            `pdfExecutions/${operationId}`,
            nativeTimestamps({
              ...binding,
              status: 'claimed',
              sandboxId,
              updatedAt: this.clock().toISOString(),
            }),
          );
        });
      },
      authorizeResult: async () => {
        await this.store.transaction(async (tx) => {
          const snapshot = await this.inspect(tx, operationId);
          const binding = await tx.get(`pdfExecutions/${operationId}`);
          if (!binding) throw new Error('PDF not bound');
          this.assertBinding(binding, snapshot);
          await this.assertReservation(tx, binding);
          if (
            binding.status !== 'claimed' ||
            binding.sandboxId !== snapshot.operation.providerHandle
          )
            throw new Error('PDF result is not authorized');
        });
      },
    };
  }

  async storeCandidate(
    operationId: string,
    receiptValue: unknown,
    inputBytes: Uint8Array,
    signal?: AbortSignal,
  ) {
    const receipt = PdfReceipt.parse(receiptValue),
      bytes = new Uint8Array(inputBytes);
    if (
      bytes.length !== receipt.bytes ||
      new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-' ||
      Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (n) => n.toString(16).padStart(2, '0'),
      ).join('') !== receipt.pdfSha256
    )
      throw new Error('PDF candidate bytes mismatch');
    signal?.throwIfAborted();
    const dispatch = await this.store.transaction(async (tx) => {
      const snapshot = await this.inspect(tx, operationId);
      const [binding, journal] = await tx.getMany([
        `pdfExecutions/${operationId}`,
        `operations/pdf_put_${operationId}`,
      ]);
      if (!binding) throw new Error('PDF not bound');
      this.assertBinding(binding, snapshot);
      await this.assertReservation(tx, binding);
      if (
        binding.status !== 'claimed' ||
        binding.sandboxId !== snapshot.operation.providerHandle ||
        receipt.reportId !== binding.reportId ||
        receipt.reportDigest !== binding.reportDigest ||
        receipt.documentDigest !== binding.documentDigest
      )
        throw new Error('PDF candidate is not authorized');
      if (journal) throw new Error('PDF PUT outcome requires reconciliation');
      const period = periodSchema.parse(
        await tx.get('configuration/r2_class_a_period'),
      );
      const counter = BudgetCounter.parse(
        await tx.get(`budgets/${period.counterKey}`),
      );
      const now = this.clock();
      if (
        now.getTime() < Date.parse(period.startsAt) ||
        now.getTime() >= Date.parse(period.endsAt) ||
        counter.halted ||
        BigInt(counter.spent) + BigInt(counter.reserved) + 1n >
          BigInt(Math.min(counter.limit, snapshot.policy.monthlyClassA))
      )
        throw new Error('PDF PUT allowance unavailable');
      const objectKey = `audits/${snapshot.operation.ownerUid}/${snapshot.operation.auditId}/artifacts/${binding.artifactId}/content`;
      tx.set(`budgets/${period.counterKey}`, {
        ...counter,
        spent: counter.spent + 1,
      });
      tx.set(`operations/pdf_put_${operationId}`, {
        schemaVersion: '1.0',
        operationId,
        artifactId: binding.artifactId,
        reportDigest: receipt.reportDigest,
        pdfSha256: receipt.pdfSha256,
        bytes: receipt.bytes,
        outcome: 'dispatching',
        createdAt: now,
        updatedAt: now,
      });
      return { binding, objectKey, expiresAt: snapshot.report.expiresAt };
    });
    // No automatic retry. Ambiguous outcome retains both reservations and journal.
    const transfer = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000);
    transfer.throwIfAborted();
    let abort = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('PDF storage transfer interrupted'));
      transfer.addEventListener('abort', abort, { once: true });
      if (transfer.aborted) abort();
    });
    let stored: { size: number; sha256: string };
    try {
      stored = await Promise.race([
        this.objects.putOnce(dispatch.objectKey, bytes, receipt.pdfSha256, {
          expiresAt: dispatch.expiresAt,
        }),
        interrupted,
      ]);
    } finally {
      transfer.removeEventListener('abort', abort);
    }
    if (stored.size !== receipt.bytes || stored.sha256 !== receipt.pdfSha256)
      throw new Error('PDF storage integrity failure');
    signal?.throwIfAborted();
    await this.store.transaction(async (tx) => {
      const snapshot = await this.inspect(tx, operationId);
      const [binding, journal] = await tx.getMany([
        `pdfExecutions/${operationId}`,
        `operations/pdf_put_${operationId}`,
      ]);
      if (!binding || !journal) throw new Error('PDF storage journal missing');
      this.assertBinding(binding, snapshot);
      await this.assertReservation(tx, binding);
      if (
        binding.status !== 'claimed' ||
        journal.outcome !== 'dispatching' ||
        journal.artifactId !== binding.artifactId ||
        journal.pdfSha256 !== receipt.pdfSha256 ||
        journal.bytes !== receipt.bytes
      )
        throw new Error('PDF storage journal mismatch');
      const now = this.clock();
      tx.set(
        `operations/pdf_put_${operationId}`,
        nativeTimestamps({
          ...journal,
          outcome: 'succeeded',
          updatedAt: now.toISOString(),
        }),
      );
      tx.set(
        `audits/${snapshot.operation.auditId}/artifacts/${binding.artifactId}`,
        {
          schemaVersion: '1.0',
          artifactId: binding.artifactId,
          ownerUid: snapshot.operation.ownerUid,
          auditId: snapshot.operation.auditId,
          revisionId: snapshot.operation.revisionId,
          operationId,
          reportId: receipt.reportId,
          reportDigest: receipt.reportDigest,
          sha256: receipt.pdfSha256,
          bytes: receipt.bytes,
          mime: 'application/pdf',
          kind: 'report_pdf',
          objectKey: dispatch.objectKey,
          lifecycle: 'uploaded',
          retentionClass: 'report',
          retentionVersion: RETENTION.version,
          expiresAt: new Date(snapshot.report.expiresAt),
          createdAt: now,
          updatedAt: now,
        },
      );
    });
    return receipt;
  }

  async publish(operationId: string) {
    return this.store.transaction(async (tx) => {
      const snapshot = await this.inspect(tx, operationId);
      const { operation, reportPath } = snapshot;
      const [binding, journal, rawTermination, reservation] = await tx.getMany([
        `pdfExecutions/${operationId}`,
        `operations/pdf_put_${operationId}`,
        `sandboxTerminations/${operationId}`,
        `reservations/pdf_output_${operationId}`,
      ]);
      if (!binding || !reservation)
        throw new Error('PDF publication binding missing');
      this.assertBinding(binding, snapshot);
      await this.assertReservation(tx, binding, binding.status === 'published');
      const termination = SandboxTermination.parse(rawTermination);
      const artifactPath = `audits/${operation.auditId}/artifacts/${binding.artifactId}`;
      const [artifact, exported] = await tx.getMany([
        artifactPath,
        `${reportPath}/exports/pdf`,
      ]);
      if (
        termination.operationId !== operationId ||
        termination.sandboxId !== binding.sandboxId ||
        termination.sandboxId !== operation.providerHandle ||
        termination.ownerUid !== operation.ownerUid ||
        termination.auditId !== operation.auditId ||
        termination.revisionId !== operation.revisionId ||
        termination.inputDigest !== operation.inputDigest ||
        termination.requestDigest !== operation.requestDigest ||
        journal?.outcome !== 'succeeded' ||
        journal.operationId !== operationId ||
        journal.artifactId !== binding.artifactId ||
        !artifact ||
        artifact.artifactId !== binding.artifactId ||
        artifact.ownerUid !== operation.ownerUid ||
        artifact.auditId !== operation.auditId ||
        artifact.revisionId !== operation.revisionId ||
        artifact.operationId !== operationId ||
        artifact.reportId !== snapshot.report.reportId ||
        artifact.reportDigest !== snapshot.reportDigest ||
        artifact.objectKey !==
          `audits/${operation.ownerUid}/${operation.auditId}/artifacts/${binding.artifactId}/content` ||
        artifact.kind !== 'report_pdf' ||
        artifact.mime !== 'application/pdf' ||
        artifact.expiresAt !== snapshot.report.expiresAt ||
        artifact.sha256 !== journal.pdfSha256 ||
        artifact.bytes !== journal.bytes ||
        reservation.amount !== MAX_PDF_BYTES ||
        reservation.documentDigest !== binding.documentDigest ||
        reservation.reportDigest !== binding.reportDigest ||
        reservation.outputCounterKey !==
          `revision_output_bytes_${operation.revisionId}` ||
        exported?.reportDigest !== snapshot.reportDigest
      )
        throw new Error('PDF publication proof mismatch');
      if (binding.status === 'published') {
        if (
          reservation.status !== 'settled' ||
          exported.status !== 'ready' ||
          exported.artifactId !== binding.artifactId ||
          artifact.lifecycle !== 'ready'
        )
          throw new Error('PDF replay integrity mismatch');
        return {
          artifactId: String(binding.artifactId),
          reportDigest: snapshot.reportDigest,
          replayed: true,
        };
      }
      if (
        binding.status !== 'claimed' ||
        reservation.status !== 'reserved' ||
        artifact.lifecycle !== 'uploaded' ||
        exported.status !== 'pending'
      )
        throw new Error('PDF publication state mismatch');
      const outputKey = `revision_output_bytes_${operation.revisionId}`;
      const [rawOutput, rawStorage] = await tx.getMany([
        `budgets/${outputKey}`,
        'budgets/r2_storage_bytes',
      ]);
      const output = BudgetCounter.parse(rawOutput),
        storage = BudgetCounter.parse(rawStorage);
      const measured = z
        .number()
        .int()
        .positive()
        .max(MAX_PDF_BYTES)
        .parse(artifact.bytes);
      for (const [key, counter] of [
        [outputKey, output],
        ['r2_storage_bytes', storage],
      ] as const) {
        if (counter.reserved < MAX_PDF_BYTES)
          throw new Error('PDF reservation accounting mismatch');
        const reserved = counter.reserved - MAX_PDF_BYTES,
          spent = counter.spent + measured;
        tx.set(`budgets/${key}`, {
          ...counter,
          reserved,
          spent,
          halted: counter.halted || spent + reserved > counter.limit,
        });
      }
      const now = this.clock().toISOString();
      tx.set(
        `pdfExecutions/${operationId}`,
        nativeTimestamps({ ...binding, status: 'published', updatedAt: now }),
      );
      tx.set(
        `reservations/pdf_output_${operationId}`,
        nativeTimestamps({
          ...reservation,
          status: 'settled',
          measuredUsage: measured,
          updatedAt: now,
        }),
      );
      tx.set(
        artifactPath,
        nativeTimestamps({ ...artifact, lifecycle: 'ready', updatedAt: now }),
      );
      tx.set(
        `${reportPath}/exports/pdf`,
        nativeTimestamps({
          ...exported,
          status: 'ready',
          artifactId: binding.artifactId,
          pdfSha256: artifact.sha256,
          bytes: measured,
          updatedAt: now,
        }),
      );
      return {
        artifactId: String(binding.artifactId),
        reportDigest: snapshot.reportDigest,
        replayed: false,
      };
    });
  }

  /** A known renderer/transfer failure keeps the readable report and records a
   * truthful failed export. Financial reservations remain for reconciliation. */
  async recordFailure(operationId: string) {
    await this.store.transaction(async (tx) => {
      const snapshot = await this.inspect(tx, operationId);
      const [binding, rawTermination, exported] = await tx.getMany([
        `pdfExecutions/${operationId}`,
        `sandboxTerminations/${operationId}`,
        `${snapshot.reportPath}/exports/pdf`,
      ]);
      if (!binding || !exported) throw new Error('PDF failure binding missing');
      this.assertBinding(binding, snapshot);
      const termination = SandboxTermination.parse(rawTermination);
      const operation = snapshot.operation;
      if (
        binding.status === 'published' ||
        exported.status === 'ready' ||
        termination.operationId !== operationId ||
        termination.sandboxId !== operation.providerHandle ||
        termination.ownerUid !== operation.ownerUid ||
        termination.auditId !== operation.auditId ||
        termination.revisionId !== operation.revisionId ||
        termination.inputDigest !== operation.inputDigest ||
        termination.requestDigest !== operation.requestDigest
      )
        throw new Error('PDF failure requires current termination proof');
      const now = this.clock().toISOString();
      tx.set(
        `pdfExecutions/${operationId}`,
        nativeTimestamps({ ...binding, status: 'failed', updatedAt: now }),
      );
      tx.set(
        `${snapshot.reportPath}/exports/pdf`,
        nativeTimestamps({
          ...exported,
          status: 'failed',
          artifactId: null,
          pdfSha256: null,
          bytes: null,
          updatedAt: now,
        }),
      );
    });
  }
}
