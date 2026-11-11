import { describe, expect, it } from 'vitest';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { FirestoreAccountingStore } from './firestore-accounting.js';
import { AdmissionRepository } from './admission.js';
import { AuditCommands } from './audit-commands.js';
import { Operation, reserveOperation, markDispatching } from './accounting.js';
import { SandboxJobs } from './sandbox-jobs.js';
import { E2bClient, type SandboxRequest } from './e2b-client.js';
import { canonicalJson, sha256 } from './hashing.js';
import { InspectionJobs } from './inspection-jobs.js';

async function setup(role: SandboxRequest['role'] = 'source') {
  const docs = new TestDocuments();
  docs.documents.set('testers/alice', { active: true });
  const { audit } = await new FirestoreAuditRepository(docs).create(
    'alice',
    {
      schemaVersion: '1.0',
      title: 'Sandbox',
      domain: 'heat_diffusion',
    },
    'create',
  );
  const revision = docs.documents.get(
    `audits/${audit.id}/revisions/${audit.currentRevisionId}`,
  )!;
  Object.assign(revision, { stage: 'inspecting', status: 'running' });
  const request: SandboxRequest = {
    operationId: crypto.randomUUID(),
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest: String(revision.inputDigest),
    role,
    templateId: 'fixture-template',
    templateBuildId: 'fixture-build',
    templateTag: 'fixture-build-tag',
    templateEvidenceId: crypto.randomUUID(),
    lifetimeSeconds: 60,
  };
  const now = '2026-10-29T00:00:00Z';
  docs.documents.set('configuration/e2b_credits', {
    schemaVersion: '1.0',
    evidenceId: crypto.randomUUID(),
    allocationMicroUsd: 20000,
    availableMicroUsd: 20000,
    accountedSpentMicroUsd: 0,
    verifiedAt: now,
    expiresAt: '2026-10-30T00:00:00Z',
  });
  docs.documents.set(`sandboxTemplates/${request.templateEvidenceId}`, {
    schemaVersion: '1.0',
    id: request.templateEvidenceId,
    templateId: request.templateId,
    templateBuildId: request.templateBuildId,
    templateTag: request.templateTag,
    role,
    imageDigest: 'a'.repeat(64),
    runtimeDigest: 'b'.repeat(64),
    verifiedAt: now,
    expiresAt: '2026-10-30T00:00:00Z',
    networkIsolationVerified: true,
    privateAccessVerified: true,
    resourceLimitsVerified: true,
    singlePrivateBuildVerified: true,
    microUsdPerSecondCeiling: 10,
  });
  const charges = [
    {
      counterKey: 'e2b_global_micro_usd',
      amount: 600,
      unit: 'micro_usd',
      consumeOnDispatch: false,
    },
    {
      counterKey: `e2b_seconds_${request.revisionId}`,
      amount: 60,
      unit: 'seconds',
      consumeOnDispatch: false,
    },
    ...(role === 'source'
      ? [
          {
            counterKey: `source_executions_${request.revisionId}`,
            amount: 1,
            unit: 'attempts',
            consumeOnDispatch: true,
          },
        ]
      : []),
  ];
  for (const charge of charges)
    docs.documents.set(`budgets/${charge.counterKey}`, {
      schemaVersion: '1.0',
      limit:
        charge.unit === 'seconds'
          ? 900
          : charge.unit === 'attempts'
            ? 8
            : 10000,
      reserved: 0,
      spent: 0,
      halted: false,
    });
  const operation = Operation.parse({
    schemaVersion: '1.0',
    id: request.operationId,
    auditId: audit.id,
    revisionId: request.revisionId,
    inputDigest: request.inputDigest,
    ownerUid: 'alice',
    requestDigest: await sha256(canonicalJson(request)),
    fence: 0,
    outcome: 'reserved',
    usage: null,
    providerHandle: null,
    charges,
    createdAt: now,
    updatedAt: now,
  });
  const accounting = new FirestoreAccountingStore(docs);
  await reserveOperation(accounting, operation);
  await new AdmissionRepository(docs).acquire('alice', {
    auditId: audit.id,
    revisionId: request.revisionId,
    inputDigest: request.inputDigest,
    generation: 0,
  });
  return {
    docs,
    request,
    operation,
    accounting,
    now,
    jobs: new SandboxJobs(docs, () => new Date(now)),
  };
}
async function terminatedUsage() {
  const f = await setup();
  await f.jobs.bind(f.request);
  const client = new E2bClient('fixture', f.jobs, {
    verifyTemplate: async () => ({
      buildId: f.request.templateBuildId!,
      tagBuildId: f.request.templateBuildId!,
      buildCount: 1,
      isPrivate: true,
    }),
    create: async () => ({ sandboxId: 'sandbox-usage' }),
    kill: async () => true,
  });
  await client.create(f.request);
  await client.kill(f.operation.id, 'sandbox-usage');
  const evidenceId = crypto.randomUUID();
  f.docs.documents.set(`sandboxUsageEvidence/${evidenceId}`, {
    schemaVersion: '1.0',
    id: evidenceId,
    operationId: f.operation.id,
    sandboxId: 'sandbox-usage',
    requestDigest: f.operation.requestDigest,
    sourceEvidenceDigest: 'd'.repeat(64),
    billableSeconds: 30,
    chargedMicroUsd: 300,
    finalizedAt: f.now,
  });
  return { ...f, evidenceId };
}
describe('durable sandbox bindings', () => {
  it('claims inspection against the original source manifest exactly once and denies results after cancellation', async () => {
    const f = await setup('inspection');
    const artifactId = crypto.randomUUID();
    const sourceDigest =
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const path = `audits/${f.request.auditId}/revisions/${f.request.revisionId}`;
    f.docs.documents.get(path)!.sourceManifest = [
      {
        schemaVersion: '1.0',
        artifactId,
        path: 'fixture.py',
        bytes: 0,
        sha256: sourceDigest,
      },
    ];
    f.docs.documents.set(
      `audits/${f.request.auditId}/artifacts/${artifactId}`,
      {
        ownerUid: 'alice',
        auditId: f.request.auditId,
        artifactId,
        kind: 'upload',
        lifecycle: 'ready',
        sha256: sourceDigest,
        bytes: 0,
        expiresAt: '2026-10-30T00:00:00Z',
      },
    );
    await f.jobs.bind(f.request);
    await f.jobs.authorizeCreate(f.request, f.operation.requestDigest);
    await f.jobs.recordCreated(f.operation.id, 'inspection-sandbox');
    const inspector = new InspectionJobs(f.docs, () => new Date(f.now));
    const payload = {
      schemaVersion: '1.0',
      operationId: f.operation.id,
      inputDigest: f.request.inputDigest,
      maximumSourceBytes: 131072,
      sources: [{ artifactId, sourceDigest, sourceBase64: '' }],
    };
    const digest = await sha256(JSON.stringify(payload));
    await expect(
      inspector.claim(payload, digest, 'wrong-sandbox'),
    ).rejects.toThrow();
    await inspector.claim(payload, digest, 'inspection-sandbox');
    await expect(
      inspector.claim(payload, digest, 'inspection-sandbox'),
    ).rejects.toThrow();
    await inspector.authorizeResult(f.operation.id);
    const inspectionResult = {
      schemaVersion: '1.0',
      operationId: f.operation.id,
      inputDigest: f.request.inputDigest,
      sources: [
        {
          artifactId,
          inspection: {
            schemaVersion: '1.0',
            sourceDigest,
            parsed: true,
            truncated: false,
            dependencies: [],
            definitions: [],
            findings: [],
          },
        },
      ],
    };
    expect((await inspector.publish(payload, inspectionResult)).replayed).toBe(
      false,
    );
    expect((await inspector.publish(payload, inspectionResult)).replayed).toBe(
      true,
    );
    expect(
      f.docs.documents.get(`${path}/inspection/current`)?.gate,
    ).toMatchObject({ status: 'needs_input' });
    expect(
      f.docs.documents.has(`${path}/inspectionSources/${artifactId}`),
    ).toBe(true);
    const changed = structuredClone(inspectionResult);
    changed.sources[0]!.inspection.truncated = true;
    await expect(inspector.publish(payload, changed)).rejects.toThrow(
      'immutable',
    );
    await new AuditCommands(f.docs).cancel(
      'alice',
      f.request.auditId,
      f.request.revisionId,
      'cancel',
    );
    await expect(
      inspector.authorizeResult(f.operation.id),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    await expect(
      inspector.publish(payload, inspectionResult),
    ).rejects.toMatchObject({ code: 'stale_revision' });
  });
  it('settles final usage once after cancellation without refunding the source attempt', async () => {
    const f = await terminatedUsage();
    await new AuditCommands(f.docs).cancel(
      'alice',
      f.request.auditId,
      f.request.revisionId,
      'cancel',
    );
    f.docs.documents.set('testers/alice', { active: false });
    await f.jobs.settle(f.operation.id, f.evidenceId);
    await f.jobs.settle(f.operation.id, f.evidenceId);
    expect(f.docs.documents.get('budgets/e2b_global_micro_usd')).toMatchObject({
      spent: 300,
      reserved: 0,
    });
    expect(
      f.docs.documents.get(`budgets/e2b_seconds_${f.request.revisionId}`),
    ).toMatchObject({ spent: 30, reserved: 0 });
    expect(
      f.docs.documents.get(`budgets/source_executions_${f.request.revisionId}`),
    ).toMatchObject({ spent: 1, reserved: 0 });
  });
  it('records real overruns and halts the affected counters', async () => {
    const f = await terminatedUsage();
    Object.assign(
      f.docs.documents.get(`sandboxUsageEvidence/${f.evidenceId}`)!,
      { billableSeconds: 70, chargedMicroUsd: 700 },
    );
    await f.jobs.settle(f.operation.id, f.evidenceId);
    expect(f.docs.documents.get('budgets/e2b_global_micro_usd')).toMatchObject({
      spent: 700,
      reserved: 0,
      halted: true,
    });
    expect(
      f.docs.documents.get(`budgets/e2b_seconds_${f.request.revisionId}`),
    ).toMatchObject({ spent: 70, reserved: 0, halted: true });
  });
  it.each(['identity', 'missing_termination', 'early_usage', 'future_usage'])(
    'refuses %s before modifying accounting',
    async (kind) => {
      const f = await terminatedUsage();
      const evidence = f.docs.documents.get(
        `sandboxUsageEvidence/${f.evidenceId}`,
      )!;
      if (kind === 'identity') evidence.sandboxId = 'different-sandbox';
      if (kind === 'missing_termination')
        f.docs.documents.delete(`sandboxTerminations/${f.operation.id}`);
      if (kind === 'early_usage') evidence.finalizedAt = '2026-10-28T00:00:00Z';
      if (kind === 'future_usage')
        evidence.finalizedAt = '2026-10-30T00:00:00Z';
      const before = structuredClone(f.docs.documents);
      await expect(
        f.jobs.settle(f.operation.id, f.evidenceId),
      ).rejects.toThrow();
      expect(f.docs.documents).toEqual(before);
    },
  );
  it('resumes after evidence persistence without permitting a replacement statement', async () => {
    const f = await terminatedUsage();
    const budget = f.docs.documents.get('budgets/e2b_global_micro_usd')!;
    f.docs.documents.delete('budgets/e2b_global_micro_usd');
    await expect(f.jobs.settle(f.operation.id, f.evidenceId)).rejects.toThrow();
    expect(f.docs.documents.has(`sandboxSettlements/${f.operation.id}`)).toBe(
      true,
    );
    f.docs.documents.set('budgets/e2b_global_micro_usd', budget);
    await f.jobs.settle(f.operation.id, f.evidenceId);
    f.docs.documents.get(
      `sandboxUsageEvidence/${f.evidenceId}`,
    )!.chargedMicroUsd = 1;
    await expect(f.jobs.settle(f.operation.id, f.evidenceId)).rejects.toThrow(
      'conflict',
    );
    expect(f.docs.documents.get('budgets/e2b_global_micro_usd')?.spent).toBe(
      300,
    );
  });
  it.each([true, false])(
    'reconciles confirmed termination (%s) after cancellation without refunding usage',
    async (found) => {
      const f = await setup();
      await f.jobs.bind(f.request);
      const path = `audits/${f.request.auditId}/revisions/${f.request.revisionId}`;
      const leaseId = String(f.docs.documents.get(path)!.slotLeaseId);
      const client = new E2bClient('fixture', f.jobs, {
        verifyTemplate: async () => ({
          buildId: f.request.templateBuildId!,
          tagBuildId: f.request.templateBuildId!,
          buildCount: 1,
          isPrivate: true,
        }),
        create: async () => ({ sandboxId: 'sandbox-ended' }),
        kill: async () => found,
      });
      await client.create(f.request);
      await new AuditCommands(f.docs).cancel(
        'alice',
        f.request.auditId,
        f.request.revisionId,
        'cancel',
      );
      f.docs.documents.set('testers/alice', { active: false });
      const budgets = structuredClone(
        f.docs.documents.get('budgets/e2b_global_micro_usd'),
      );
      await client.kill(f.operation.id, 'sandbox-ended');
      await client.kill(f.operation.id, 'sandbox-ended');
      expect(
        f.docs.documents.get(`slotLeases/${leaseId}`)?.pendingOperations,
      ).toBe(0);
      expect(
        f.docs.documents.get(`leaseOperations/${f.operation.id}`)
          ?.completionKind,
      ).toBe('sandbox_termination');
      expect(f.docs.documents.get('budgets/e2b_global_micro_usd')).toEqual(
        budgets,
      );
      expect(
        f.docs.documents.get(`operations/${f.operation.id}`)?.outcome,
      ).toBe('dispatching');
      const maintenanceId = await sha256(
        `cancel_revision:${f.request.auditId}:${f.request.revisionId}`,
      );
      expect(
        await new AdmissionRepository(f.docs).releaseForMaintenance(
          maintenanceId,
        ),
      ).toBe('released');
    },
  );
  it('retains execution capacity and financial reservations on uncertain kill', async () => {
    const f = await setup();
    await f.jobs.bind(f.request);
    const client = new E2bClient('fixture', f.jobs, {
      verifyTemplate: async () => ({
        buildId: f.request.templateBuildId!,
        tagBuildId: f.request.templateBuildId!,
        buildCount: 1,
        isPrivate: true,
      }),
      create: async () => ({ sandboxId: 'sandbox-uncertain' }),
      kill: async () => {
        throw new Error('timeout');
      },
    });
    await client.create(f.request);
    const before = structuredClone(f.docs.documents);
    await expect(
      client.kill(f.operation.id, 'sandbox-uncertain'),
    ).rejects.toMatchObject({ code: 'kill_unknown' });
    expect(f.docs.documents).toEqual(before);
  });
  it('creates through the real gate, commits admission once and records the handle', async () => {
    const f = await setup();
    await f.jobs.bind(f.request);
    let creates = 0;
    const client = new E2bClient('fixture-key', f.jobs, {
      verifyTemplate: async () => ({
        buildId: f.request.templateBuildId!,
        tagBuildId: f.request.templateBuildId!,
        buildCount: 1,
        isPrivate: true,
      }),
      create: async () => {
        creates++;
        return { sandboxId: 'sandbox-gated' };
      },
      kill: async () => true,
    });
    await client.create(f.request);
    expect(f.docs.documents.get(`operations/${f.operation.id}`)).toMatchObject({
      outcome: 'dispatching',
      providerHandle: 'sandbox-gated',
    });
    expect(f.docs.documents.get('dailyQuotas/global_2026-10-29')?.count).toBe(
      1,
    );
    await expect(client.create(f.request)).rejects.toThrow();
    expect(creates).toBe(1);
    expect(await client.kill(f.operation.id, 'sandbox-gated')).toBe('killed');
  });
  it.each([
    'missing_credit',
    'expired_credit',
    'changed_template',
    'reduced_credit',
    'bad_snapshot',
    'raised_limit',
  ])(
    'rejects %s at dispatch without consuming admission or attempts',
    async (kind) => {
      const f = await setup();
      await f.jobs.bind(f.request);
      const credit = f.docs.documents.get('configuration/e2b_credits')!;
      if (kind === 'missing_credit')
        f.docs.documents.delete('configuration/e2b_credits');
      if (kind === 'expired_credit') credit.expiresAt = f.now;
      if (kind === 'reduced_credit') credit.availableMicroUsd = 600;
      if (kind === 'bad_snapshot') credit.accountedSpentMicroUsd = 1;
      if (kind === 'changed_template')
        f.docs.documents.get(
          `sandboxTemplates/${f.request.templateEvidenceId}`,
        )!.imageDigest = 'f'.repeat(64);
      if (kind === 'raised_limit')
        f.docs.documents.get(
          `budgets/source_executions_${f.request.revisionId}`,
        )!.limit = 9;
      const before = structuredClone(f.docs.documents);
      await expect(
        f.jobs.authorizeCreate(f.request, f.operation.requestDigest),
      ).rejects.toThrow();
      expect(f.docs.documents).toEqual(before);
    },
  );
  it('counts unsettled reservations against refreshed verified available credit', async () => {
    const f = await setup();
    await f.jobs.bind(f.request);
    const money = f.docs.documents.get('budgets/e2b_global_micro_usd')!;
    money.spent = 500;
    const credit = f.docs.documents.get('configuration/e2b_credits')!;
    credit.accountedSpentMicroUsd = 400;
    credit.availableMicroUsd = 750;
    // 90% of 750 is 675; 100 newly spent plus 600 reserved exceeds it.
    await expect(
      f.jobs.authorizeCreate(f.request, f.operation.requestDigest),
    ).rejects.toThrow('allowance');
    credit.availableMicroUsd = 800;
    await f.jobs.authorizeCreate(f.request, f.operation.requestDigest);
  });
  it.each(['source', 'inspection', 'evaluation', 'pdf'] as const)(
    'binds %s role with correct accounting and stable timestamp hashes',
    async (role) => {
      const f = await setup(role);
      const job = await f.jobs.bind(f.request);
      expect(await f.jobs.bind(f.request)).toEqual(job);
      expect(job.reservedMicroUsd).toBe(600);
      expect(f.operation.charges).toHaveLength(role === 'source' ? 3 : 2);
    },
  );
  it.each(['expired', 'role', 'network', 'price', 'time_budget'])(
    'rejects invalid %s evidence or accounting',
    async (kind) => {
      const f = await setup();
      const evidence = f.docs.documents.get(
        `sandboxTemplates/${f.request.templateEvidenceId}`,
      )!;
      if (kind === 'expired') evidence.expiresAt = f.now;
      if (kind === 'role') evidence.role = 'pdf';
      if (kind === 'network') evidence.networkIsolationVerified = false;
      if (kind === 'price') evidence.microUsdPerSecondCeiling = 11;
      if (kind === 'time_budget')
        f.docs.documents.get(
          `budgets/e2b_seconds_${f.request.revisionId}`,
        )!.limit = 901;
      await expect(f.jobs.bind(f.request)).rejects.toThrow();
      expect(f.docs.documents.has(`sandboxJobs/${f.operation.id}`)).toBe(false);
    },
  );
  it('journals late handles after cancellation without allowing replacement or foreign termination', async () => {
    const f = await setup();
    await f.jobs.bind(f.request);
    await expect(
      f.jobs.recordCreated(f.operation.id, 'sandbox-a'),
    ).rejects.toThrow('dispatched');
    await markDispatching(f.accounting, f.operation.id, 0, f.now);
    await new AuditCommands(f.docs).cancel(
      'alice',
      f.request.auditId,
      f.request.revisionId,
      'cancel',
    );
    f.docs.documents.set('testers/alice', { active: false });
    await f.jobs.recordCreated(f.operation.id, 'sandbox-a');
    await f.jobs.recordCreated(f.operation.id, 'sandbox-a');
    await expect(
      f.jobs.recordCreated(f.operation.id, 'sandbox-b'),
    ).rejects.toThrow('bound');
    await f.jobs.authorizeKill(f.operation.id, 'sandbox-a');
    await expect(
      f.jobs.authorizeKill(f.operation.id, 'sandbox-b'),
    ).rejects.toThrow('authorized');
  });
  it('authorizes reconnect only for the active inspection operation and journaled handle', async () => {
    const f = await setup('inspection');
    await f.jobs.bind(f.request);
    await markDispatching(f.accounting, f.operation.id, 0, f.now);
    await f.jobs.recordCreated(f.operation.id, 'sandbox-inspection');
    await f.jobs.authorizeConnect(f.operation.id, 'sandbox-inspection');
    await expect(
      f.jobs.authorizeConnect(f.operation.id, 'sandbox-other'),
    ).rejects.toThrow('connection handle is not authorized');
    f.docs.documents.set(`sandboxTerminations/${f.operation.id}`, {
      sandboxId: 'sandbox-inspection',
    });
    await expect(
      f.jobs.authorizeConnect(f.operation.id, 'sandbox-inspection'),
    ).rejects.toThrow('connection handle is not authorized');

    const source = await setup('source');
    await source.jobs.bind(source.request);
    await markDispatching(
      source.accounting,
      source.operation.id,
      0,
      source.now,
    );
    await source.jobs.recordCreated(source.operation.id, 'sandbox-source');
    await expect(
      source.jobs.authorizeConnect(source.operation.id, 'sandbox-source'),
    ).rejects.toThrow('connection handle is not authorized');
  });
});
