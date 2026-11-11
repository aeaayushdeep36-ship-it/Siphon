import { describe, expect, it, vi } from 'vitest';
import { TestDocuments } from '../test/document-store.js';
import { authoredReport } from '../test/report-fixture.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { canonicalJson, sha256 } from './hashing.js';
import {
  ReportPdfPublications,
  ReportPublication,
} from './report-publication.js';
import { ReportRepository } from './reports.js';
import { MAX_PDF_BYTES } from './pdf-runner.js';
import { PdfPipeline } from './pdf-pipeline.js';
import { ScientificFinishStage } from './scientific-finish-stage.js';
import { ScientificPdfStage } from './scientific-pdf-stage.js';
import { SandboxJobs } from './sandbox-jobs.js';
import { AdmissionRepository } from './admission.js';

async function setup() {
  const docs = new TestDocuments(),
    now = new Date('2026-10-29T01:00:00.000Z');
  docs.documents.set('testers/alice', { active: true });
  const { audit } = await new FirestoreAuditRepository(docs).create(
    'alice',
    {
      schemaVersion: '1.0',
      title: 'PDF publication fixture',
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
  const base = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
  Object.assign(docs.documents.get(base)!, {
    reportId: report.reportId,
    inputDigest: report.inputDigest,
    stage: 'reporting',
    status: 'running',
  });
  const reportDigest = await sha256(canonicalJson(report));
  docs.documents.set(`${base}/reports/${report.reportId}`, {
    schemaVersion: '1.0',
    ownerUid: 'alice',
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    reportId: report.reportId,
    inputDigest: report.inputDigest,
    reportDigest,
    reportJson: canonicalJson(report),
    createdAt: report.createdAt,
    expiresAt: report.expiresAt,
  });
  const operationId = crypto.randomUUID(),
    sandboxId = 'fresh_pdf_vm';
  const sandbox = {
    operationId,
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest: report.inputDigest,
    role: 'pdf',
    templateId: 'reviewed_pdf_image',
    templateEvidenceId: crypto.randomUUID(),
    lifetimeSeconds: 180,
  };
  const requestDigest = await sha256(canonicalJson(sandbox));
  const operation = {
    schemaVersion: '1.0',
    id: operationId,
    ownerUid: 'alice',
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest: report.inputDigest,
    requestDigest,
    fence: 0,
    outcome: 'reserved',
    charges: [
      {
        counterKey: 'sandbox_seconds',
        amount: 180,
        unit: 'seconds',
        consumeOnDispatch: false,
      },
    ],
    usage: null,
    providerHandle: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  docs.documents.set(`operations/${operationId}`, operation);
  docs.documents.set(`sandboxJobs/${operationId}`, {
    request: sandbox,
    requestDigest,
  });
  const outputKey = `revision_output_bytes_${audit.currentRevisionId}`;
  for (const key of [outputKey, 'r2_storage_bytes'])
    docs.documents.set(`budgets/${key}`, {
      schemaVersion: '1.0',
      limit: 50 * 1024 * 1024,
      reserved: 0,
      spent: 0,
      halted: false,
    });
  docs.documents.set('configuration/r2_class_a_period', {
    counterKey: 'r2_a',
    startsAt: '2026-10-01T00:00:00.000Z',
    endsAt: '2026-11-01T00:00:00.000Z',
  });
  docs.documents.set('budgets/r2_a', {
    schemaVersion: '1.0',
    limit: 50000,
    spent: 0,
    reserved: 0,
    halted: false,
  });
  const putOnce = vi.fn(
    async (_key: string, bytes: Uint8Array<ArrayBuffer>, digest: string) => ({
      size: bytes.length,
      sha256: digest,
    }),
  );
  const publications = new ReportPdfPublications(docs, { putOnce }, () => now);
  const bind = async () => publications.bind(operationId);
  const created = () => {
    Object.assign(docs.documents.get(`operations/${operationId}`)!, {
      outcome: 'dispatching',
      providerHandle: sandboxId,
    });
    docs.documents.set(`sandboxHandles/${sandboxId}`, {
      operationId,
      ownerUid: 'alice',
      auditId: audit.id,
      revisionId: audit.currentRevisionId,
    });
  };
  const terminated = () =>
    docs.documents.set(`sandboxTerminations/${operationId}`, {
      schemaVersion: '1.0',
      operationId,
      sandboxId,
      ownerUid: 'alice',
      auditId: audit.id,
      revisionId: audit.currentRevisionId,
      inputDigest: report.inputDigest,
      requestDigest,
      outcome: 'killed',
      observedAt: now.toISOString(),
    });
  const bytes = new TextEncoder().encode(
    '%PDF-authored bytes for publication test',
  );
  const candidate = async () => {
    const bound = await bind();
    created();
    await publications
      .gate(operationId)
      .claim(
        bound.document,
        await sha256(canonicalJson(bound.document)),
        sandboxId,
      );
    const receipt = {
      schemaVersion: '1.0',
      reportId: report.reportId,
      reportDigest,
      documentDigest: await sha256(canonicalJson(bound.document)),
      pdfSha256: await sha256(new TextDecoder().decode(bytes)),
      bytes: bytes.length,
    };
    await publications.storeCandidate(operationId, receipt, bytes);
    return receipt;
  };
  return {
    docs,
    audit,
    base,
    report,
    reportDigest,
    operationId,
    outputKey,
    sandbox,
    publications,
    putOnce,
    bind,
    created,
    terminated,
    bytes,
    candidate,
    now,
  };
}

describe('private PDF publication authority', () => {
  it('reserves a PDF renderer and does not repeat an uncertain dispatch', async () => {
    const f = await setup(),
      id = crypto.randomUUID();
    const fence = {
      auditId: f.audit.id,
      revisionId: f.audit.currentRevisionId,
      inputDigest: f.report.inputDigest,
      generation: 0,
    };
    f.docs.documents.set('configuration/pdf_dispatch', {
      templateEvidenceId: id,
      lifetimeSeconds: 60,
    });
    f.docs.documents.set(`sandboxTemplates/${id}`, {
      schemaVersion: '1.0',
      id,
      templateId: 'authored-pdf',
      role: 'pdf',
      imageDigest: 'c'.repeat(64),
      runtimeDigest: 'd'.repeat(64),
      verifiedAt: f.now.toISOString(),
      expiresAt: '2026-10-31T00:00:00.000Z',
      networkIsolationVerified: true,
      privateAccessVerified: true,
      resourceLimitsVerified: true,
      singlePrivateBuildVerified: true,
      microUsdPerSecondCeiling: 10,
    });
    for (const [key, limit] of [
      ['e2b_global_micro_usd', 10000],
      [`e2b_seconds_${fence.revisionId}`, 900],
    ] as const)
      f.docs.documents.set(`budgets/${key}`, {
        schemaVersion: '1.0',
        limit,
        reserved: 0,
        spent: 0,
        halted: false,
      });
    const pipeline = {
      run: vi.fn(async () => ({ status: 'awaiting_termination' as const })),
      recover: vi.fn(async () => ({
        status: 'published' as const,
        artifactId: crypto.randomUUID(),
        reportDigest: f.reportDigest,
        replayed: true,
      })),
    };
    const stage = new ScientificPdfStage(
      f.docs,
      new SandboxJobs(f.docs, () => f.now),
      pipeline,
      () => f.now,
    );
    const first = await stage.run('alice', fence);
    expect(first.status).toBe('awaiting_termination');
    expect(
      f.docs.documents.get(`operations/${first.operationId}`),
    ).toMatchObject({ outcome: 'reserved', providerHandle: null });
    f.docs.documents.get(`operations/${first.operationId}`)!.outcome =
      'dispatching';
    expect(await stage.run('alice', fence)).toMatchObject({
      status: 'blocked',
      code: 'pdf_requires_reconciliation',
    });
    expect(pipeline.run).toHaveBeenCalledOnce();
  });
  it('finishes as partial only after the structured report and PDF proofs agree', async () => {
    const f = await setup();
    const fence = {
      auditId: f.audit.id,
      revisionId: f.audit.currentRevisionId,
      inputDigest: f.report.inputDigest,
      generation: 0,
    };
    await f.candidate();
    f.terminated();
    await f.publications.publish(f.operationId);
    const finish = new ScientificFinishStage(f.docs, () => f.now);
    const exportRecord = f.docs.documents.get(
      `${f.base}/reports/${f.report.reportId}/exports/pdf`,
    )!;
    const savedSha = exportRecord.pdfSha256;
    exportRecord.pdfSha256 = '0'.repeat(64);
    await expect(finish.finish('alice', fence, f.operationId)).rejects.toThrow(
      'proof changed',
    );
    f.docs.documents.get(
      `${f.base}/reports/${f.report.reportId}/exports/pdf`,
    )!.pdfSha256 = savedSha;
    const lease = await new AdmissionRepository(f.docs, () => f.now).acquire(
      'alice',
      fence,
    );
    const held = f.docs.documents.get(`slotLeases/${lease.id}`)!;
    held.pendingOperations = 1;
    held.dispatchMayHaveStarted = true;
    await expect(finish.finish('alice', fence, f.operationId)).rejects.toThrow(
      'Capacity cannot be released',
    );
    f.docs.documents.get(`slotLeases/${lease.id}`)!.pendingOperations = 0;
    await expect(
      finish.finish('alice', fence, f.operationId),
    ).resolves.toMatchObject({
      status: 'partial',
      reportId: f.report.reportId,
    });
    expect(f.docs.documents.get(f.base)).toMatchObject({
      stage: 'finished',
      status: 'partial',
      generation: 1,
      slotLeaseId: null,
    });
    expect(f.docs.documents.get(`slotLeases/${lease.id}`)?.status).toBe(
      'released',
    );
  });
  it('reserves once, charges PUT before I/O, publishes only after termination and exposes matching download metadata', async () => {
    const f = await setup();
    await f.bind();
    await f.bind();
    expect(f.docs.documents.get(`budgets/${f.outputKey}`)?.reserved).toBe(
      MAX_PDF_BYTES,
    );
    const receipt = await f.candidate();
    expect(f.docs.documents.get('budgets/r2_a')?.spent).toBe(1);
    await expect(f.publications.publish(f.operationId)).rejects.toThrow();
    f.terminated();
    const result = await f.publications.publish(f.operationId);
    expect(result.replayed).toBe(false);
    expect((await f.publications.publish(f.operationId)).replayed).toBe(true);
    const response = await new ReportRepository(f.docs, () => f.now).get(
      'alice',
      f.audit.id,
      f.audit.currentRevisionId,
    );
    expect(response.pdf).toMatchObject({
      status: 'available',
      artifactId: result.artifactId,
      sha256: receipt.pdfSha256,
      bytes: f.bytes.length,
    });
    expect(f.docs.documents.get(`budgets/${f.outputKey}`)).toMatchObject({
      reserved: 0,
      spent: f.bytes.length,
    });
    expect(f.putOnce).toHaveBeenCalledTimes(1);
  });
  it('retains charges/reservations on ambiguous PUT and never blindly retries', async () => {
    const f = await setup();
    f.putOnce.mockRejectedValue(new Error('provider unknown'));
    await expect(f.candidate()).rejects.toThrow('provider unknown');
    expect(f.docs.documents.get('budgets/r2_a')?.spent).toBe(1);
    expect(f.docs.documents.get(`budgets/${f.outputKey}`)?.reserved).toBe(
      MAX_PDF_BYTES,
    );
    expect(
      f.docs.documents.get(`operations/pdf_put_${f.operationId}`)?.outcome,
    ).toBe('dispatching');
    await expect(f.bind()).rejects.toThrow('reconciliation');
  });
  it('denies cancellation or foreign role before any PDF command/write', async () => {
    const f = await setup();
    Object.assign(f.docs.documents.get(f.base)!, {
      status: 'cancelled',
      stage: 'finished',
      cancellationRequestedAt: f.now.toISOString(),
    });
    await expect(f.bind()).rejects.toThrow();
    expect(f.putOnce).not.toHaveBeenCalled();
    const createPdf = vi.fn(),
      kill = vi.fn();
    await expect(
      new PdfPipeline(f.publications, { createPdf, kill }).run({
        ...f.sandbox,
        role: 'source',
      }),
    ).rejects.toThrow('PDF role');
    expect(createPdf).not.toHaveBeenCalled();
  });
});

async function assemblyFixture() {
  const f = await setup();
  f.docs.documents.delete(`${f.base}/reports/${f.report.reportId}`);
  Object.assign(f.docs.documents.get(f.base)!, {
    reportId: null,
    generation: 2,
  });
  const inputDigest = f.report.inputDigest,
    auditId = f.audit.id,
    revisionId = f.audit.currentRevisionId;
  const contextOperationId = crypto.randomUUID(),
    originalId = crypto.randomUUID(),
    sourceId = crypto.randomUUID(),
    planId = crypto.randomUUID(),
    evaluationId = f.operationId;
  const context = {
    schemaVersion: '1.0',
    auditId,
    revisionId,
    inputDigest,
    domain: 'heat_diffusion',
    summary: 'Authored context fixture.',
    domainMismatchSuspected: false,
    candidates: [],
  };
  const contextDigest = await sha256(canonicalJson(context));
  const adapter = {
    schemaVersion: '1.0',
    auditId,
    revisionId,
    inputDigest,
    contextDigest,
    sourceArtifactId: crypto.randomUUID(),
    sourceDigest: 'a'.repeat(64),
    domain: 'heat_diffusion',
    handler: 'script_globals_v1',
    mappings: [
      {
        key: 'times',
        root: 'times',
        steps: [],
        expectedShape: [2],
        axisOrder: [0],
        declaredUnit: 's',
      },
      {
        key: 'temperature',
        root: 'temperature',
        steps: [],
        expectedShape: [2, 1],
        axisOrder: [0, 1],
        declaredUnit: 'K',
      },
    ],
  };
  const adapterDigest = await sha256(canonicalJson(adapter)),
    sourceDigest = '7'.repeat(64);
  const checks = [
    'H_ENERGY',
    'H_BALANCE',
    'H_TIME_REF',
    'H_GRID_REF',
    'H_REFERENCE',
  ];
  const plan = {
    schemaVersion: '1.0',
    id: planId,
    auditId,
    revisionId,
    inputDigest,
    domain: 'heat_diffusion',
    contextDigest,
    adapterDigest,
    registryVersion: '0.1.0',
    assessment: {
      schemaVersion: '1.0',
      domain: 'heat_diffusion',
      inputDigest,
      contextDigest,
      adapterDigest,
      decisions: checks.map((checkId, i) => ({
        checkId,
        registryVersion: '0.1.0',
        status: i ? 'ineligible' : 'eligible',
        applicability: i ? 'ineligible' : 'eligible',
        released: i === 0,
        reasons: [],
      })),
    },
    checks: checks.map((checkId, i) => ({
      checkId,
      checkVersion: '0.1.0',
      selection: i ? 'excluded' : 'selected',
      reasons: ['Authored plan fixture.'],
      procedure: 'Reported-sample measurement.',
      requiredObservations: ['temperature'],
      accuracyPolicy: 'No target supplied.',
      referenceIds: i ? [] : ['reviewed_method'],
      experimentIds: i ? [] : [sourceId],
    })),
    experiments: [
      {
        id: sourceId,
        description: 'Verified baseline sample.',
        status: 'completed',
        controls: [],
        sourceOperationId: sourceId,
        resultDigest: sourceDigest,
      },
    ],
    accuracyPolicies: { H_ENERGY: { scope: 'reported_samples', target: null } },
    references: [
      {
        id: 'reviewed_method',
        title: 'Authored test reference',
        url: 'https://example.org/method',
        accessedAt: f.now.toISOString(),
      },
    ],
    createdAt: f.now.toISOString(),
  };
  const planDigest = await sha256(canonicalJson(plan));
  const metric = {
    ...f.report.metrics[0]!,
    contextDigest,
    adapterDigest,
    planDigest,
    checkVersion: '0.1.0',
    experimentIds: [sourceId],
    target: null,
    uncertainty: null,
    interval: null,
    status: 'inconclusive',
    reason: 'missing_target',
  };
  const diagnostics = {
    schemaVersion: '1.0',
    auditId,
    revisionId,
    operationId: evaluationId,
    validationOperationId: crypto.randomUUID(),
    sourceOperationId: sourceId,
    inputDigest,
    contextDigest,
    adapterDigest,
    profile: { kind: 'heat_energy_si', densityKgM3: 1, heatCapacityJKgK: 1 },
    kind: 'numeric_diagnostics',
    methodVersion: '0.1.0',
    sampleCount: 2,
    timeRangeSeconds: [0, 1],
    metrics: [
      {
        name: 'thermal_energy_change',
        unit: 'J',
        value: 0,
        normalization: 'absolute',
        status: 'inconclusive',
        reason: 'measurement_only',
        arithmetic: null,
      },
    ],
    limitations: ['Authored evaluator fixture only.'],
  };
  const result = { schemaVersion: '1.0', diagnostics, evidence: [metric] };
  const common = {
    ownerUid: 'alice',
    auditId,
    revisionId,
    inputDigest,
    createdAt: f.now.toISOString(),
    expiresAt: f.report.expiresAt,
  };
  f.docs.documents.set(`${f.base}/context/current`, {
    ...common,
    operationId: contextOperationId,
    proposal: context,
    proposalDigest: contextDigest,
  });
  f.docs.documents.set(`${f.base}/adapters/current`, {
    ...common,
    proposal: adapter,
    adapterDigest,
    status: 'verified',
    originalOperationId: originalId,
    adaptedOperationId: sourceId,
    baseline: {
      schemaVersion: '1.0',
      status: 'matched',
      comparedElements: 4,
      observations: [
        { key: 'times', status: 'matched', reason: null },
        { key: 'temperature', status: 'matched', reason: null },
      ],
    },
  });
  f.docs.documents.set(`${f.base}/plans/current`, {
    ...common,
    plan,
    planDigest,
  });
  const parameters = { densityKgM3: 1, heatCapacityJKgK: 1 };
  f.docs.documents.set(`${f.base}/scientificParameters/current`, {
    ...common,
    planDigest,
    parameters,
    parametersDigest: await sha256(canonicalJson(parameters)),
    declaration: 'user_supplied',
  });
  const savedEvidence = {
    ...common,
    operationId: evaluationId,
    contextDigest,
    adapterDigest,
    planDigest,
    report: result,
    reportDigest: await sha256(canonicalJson(result)),
  };
  f.docs.documents.set(`${f.base}/evidence/${evaluationId}`, savedEvidence);
  f.created();
  f.terminated();
  const evaluationRequest = { ...f.sandbox, role: 'evaluation' };
  const evaluationRequestDigest = await sha256(
    canonicalJson(evaluationRequest),
  );
  f.docs.documents.set(`sandboxJobs/${evaluationId}`, {
    request: evaluationRequest,
    requestDigest: evaluationRequestDigest,
  });
  f.docs.documents.get(`operations/${evaluationId}`)!.requestDigest =
    evaluationRequestDigest;
  f.docs.documents.get(`sandboxTerminations/${evaluationId}`)!.requestDigest =
    evaluationRequestDigest;
  for (const id of [sourceId, originalId])
    f.docs.documents.set(`operations/${id}`, {
      ...f.docs.documents.get(`operations/${evaluationId}`),
      id,
      providerHandle: `vm_${id}`,
    });
  f.docs.documents.set(`sourceOutputPlans/${sourceId}`, {
    ...common,
    operationId: sourceId,
    outputDigest: sourceDigest,
    status: 'stored',
  });
  const publication = new ReportPublication(f.docs, () => f.now);
  const publish = () =>
    publication.assembleAndPublish(
      'alice',
      { auditId, revisionId, generation: 2, inputDigest },
      { reportId: f.report.reportId, conservationOperationIds: [evaluationId] },
    );
  return { ...f, publish, savedEvidence };
}

describe('authoritative report assembly', () => {
  it('publishes only actual stored numerical evidence, retains inconclusive status and retries immutably', async () => {
    const f = await assemblyFixture();
    const result = await f.publish();
    expect(result.report.coverage).toBe('limited');
    expect(result.report.metrics[0]?.status).toBe('inconclusive');
    expect(result.report.experiments[0]?.resultDigest).toBe('7'.repeat(64));
    expect(result.report.narrative.hypotheses).toEqual([]);
    expect(result.report.assumptions).toEqual([
      expect.objectContaining({
        basis: 'user_declaration',
        statement: expect.stringContaining('density 1 kg/m³'),
      }),
    ]);
    expect((await f.publish()).replayed).toBe(true);
  });
  it('rejects a modified evaluation payload and mismatched termination before publishing', async () => {
    const f = await assemblyFixture();
    f.savedEvidence.report.evidence[0]!.metric.value += 1;
    await expect(f.publish()).rejects.toThrow();
    expect(f.docs.documents.get(f.base)?.reportId).toBeNull();
    const g = await assemblyFixture();
    g.docs.documents.get(`sandboxTerminations/${g.operationId}`)!.sandboxId =
      'another_vm';
    await expect(g.publish()).rejects.toThrow('termination mismatch');
  });
  it('rejects thermal declarations that do not match the evaluated profile', async () => {
    const f = await assemblyFixture();
    const record = f.docs.documents.get(
      `${f.base}/scientificParameters/current`,
    )!;
    record.parameters = { densityKgM3: 2, heatCapacityJKgK: 1 };
    record.parametersDigest = await sha256(canonicalJson(record.parameters));
    await expect(f.publish()).rejects.toThrow('thermal declarations differ');
  });
});
