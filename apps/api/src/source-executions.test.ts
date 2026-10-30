import { describe, expect, it } from 'vitest';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { SourceExecutions } from './source-executions.js';
import { SourceJobRequest, AdapterProposal } from '@siphon/contracts';
import { sha256, canonicalJson } from './hashing.js';
import { AuditCommands } from './audit-commands.js';
import { SourcePipeline } from './source-pipeline.js';

async function setup() {
  const docs = new TestDocuments();
  docs.documents.set('testers/alice', { active: true });
  const { audit } = await new FirestoreAuditRepository(docs).create(
    'alice',
    {
      schemaVersion: '1.0',
      domain: 'heat_diffusion',
      title: 'Source claim',
    },
    'create',
  );
  const now = new Date('2026-10-29T00:00:00.000Z');
  const path = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
  const sourceId = crypto.randomUUID(),
    operationId = crypto.randomUUID(),
    approvalId = crypto.randomUUID();
  const file = {
    schemaVersion: '1.0' as const,
    artifactId: sourceId,
    path: 'fixture.py',
    bytes: 0,
    sha256: await sha256(''),
  };
  const inputDigest = await sha256(
    canonicalJson({ uploads: [file], answers: [] }),
  );
  docs.documents.set(`audits/${audit.id}/artifacts/${sourceId}`, {
    ...file,
    auditId: audit.id,
    ownerUid: 'alice',
    lifecycle: 'ready',
    expiresAt: '2026-10-30T00:00:00Z',
  });
  Object.assign(docs.documents.get(path)!, {
    stage: 'adapting',
    status: 'running',
    inputDigest,
    sourceManifest: [file],
  });
  const adapter = AdapterProposal.parse({
    schemaVersion: '1.0',
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest,
    contextDigest: 'a'.repeat(64),
    sourceArtifactId: sourceId,
    sourceDigest: file.sha256,
    domain: 'heat_diffusion',
    handler: 'script_globals_v1',
    mappings: [
      {
        key: 'times',
        root: 't',
        steps: [],
        expectedShape: [2],
        axisOrder: [0],
        declaredUnit: 's',
      },
      {
        key: 'temperature',
        root: 'T',
        steps: [],
        expectedShape: [2, 1],
        axisOrder: [0, 1],
        declaredUnit: 'K',
      },
    ],
  });
  const request = SourceJobRequest.parse({
    schemaVersion: '1.0',
    operationId,
    inputDigest,
    adapterDigest: await sha256(canonicalJson(adapter)),
    entryArtifactId: sourceId,
    files: [{ ...file, dataBase64: '' }],
    mappings: adapter.mappings,
    maximumOutputBytes: 4096,
    maximumElements: 100,
  });
  // Authored approval/readiness fixtures, not real model/adapter verification.
  const assessment = {
    schemaVersion: '1.0',
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest,
    contextDigest: adapter.contextDigest,
    sourceManifestDigest: await sha256(canonicalJson([file])),
    status: 'ready',
    evidenceIds: [crypto.randomUUID()],
  };
  docs.documents.set(`${path}/readiness/current`, { assessment });
  const payloadDigest = await sha256(JSON.stringify(request));
  docs.documents.set(`sourceExecutionApprovals/${approvalId}`, {
    schemaVersion: '1.0',
    id: approvalId,
    ownerUid: 'alice',
    payloadDigest,
    readinessDigest: await sha256(canonicalJson(assessment)),
    adapter,
    executionProfile: 'runpy_main_root_v1',
    purpose: 'baseline_observation',
    verifiedAt: now.toISOString(),
    expiresAt: '2026-10-30T00:00:00Z',
  });
  const sandboxRequest = {
    operationId,
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest,
    role: 'source',
    templateId: 'fixture-template',
    templateEvidenceId: crypto.randomUUID(),
    lifetimeSeconds: 60,
  };
  const sandboxDigest = await sha256(canonicalJson(sandboxRequest));
  docs.documents.set(`operations/${operationId}`, {
    schemaVersion: '1.0',
    id: operationId,
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest,
    ownerUid: 'alice',
    requestDigest: sandboxDigest,
    fence: 0,
    outcome: 'reserved',
    usage: null,
    providerHandle: null,
    charges: [
      {
        counterKey: 'fixture',
        unit: 'seconds',
        amount: 60,
        consumeOnDispatch: false,
      },
    ],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  docs.documents.set(`sandboxJobs/${operationId}`, {
    request: sandboxRequest,
    requestDigest: sandboxDigest,
  });
  const outputKey = `revision_output_bytes_${audit.currentRevisionId}`;
  for (const key of ['r2_storage_bytes', outputKey])
    docs.documents.set(`budgets/${key}`, {
      schemaVersion: '1.0',
      limit: 100000,
      reserved: 0,
      spent: 0,
      halted: false,
    });
  const executions = new SourceExecutions(docs, () => now);
  const dispatch = () => {
    Object.assign(docs.documents.get(`operations/${operationId}`)!, {
      outcome: 'dispatching',
      providerHandle: 'fixture-source',
    });
    docs.documents.set('sandboxHandles/fixture-source', {
      operationId,
      ownerUid: 'alice',
      auditId: audit.id,
      revisionId: audit.currentRevisionId,
    });
  };
  return {
    docs,
    audit,
    path,
    request,
    approvalId,
    operationId,
    payloadDigest,
    outputKey,
    executions,
    dispatch,
  };
}
describe('durable baseline execution and output reservation', () => {
  it('reserves before creation and connects the real source claim/collector to termination', async () => {
    const f = await setup();
    const raw = 'unvalidated';
    const descriptors = await Promise.all(
      f.request.mappings.map(async (mapping) => ({
        key: mapping.key,
        filename: `obs_${mapping.key}.npy`,
        bytes: raw.length,
        sha256: await sha256(raw),
        dtype: 'float64',
        shape: mapping.expectedShape,
        declaredUnit: mapping.declaredUnit,
      })),
    );
    let killed = false;
    const sandboxRequest = f.docs.documents.get(
      `sandboxJobs/${f.operationId}`,
    )!.request;
    const pipeline = new SourcePipeline(f.executions, {
      createSource: async () => {
        expect(f.docs.documents.get('budgets/r2_storage_bytes')?.reserved).toBe(
          36864,
        );
        f.dispatch();
        return {
          sandboxId: 'fixture-source',
          session: {
            sandboxId: 'fixture-source',
            writeRequest: async () => {},
            run: async () => 0,
            readManifest: async () =>
              new Response(
                JSON.stringify({
                  schemaVersion: '1.0',
                  operationId: f.operationId,
                  inputDigest: f.request.inputDigest,
                  adapterDigest: f.request.adapterDigest,
                  executionProfile: 'runpy_main_root_v1',
                  observations: descriptors,
                }),
              ).body!,
            readObservation: async () => new Response(raw).body!,
          },
        };
      },
      kill: async () => {
        killed = true;
        return 'killed';
      },
    });
    const result = await pipeline.run(sandboxRequest, f.request, f.approvalId);
    expect(result).toMatchObject({
      cleanup: 'confirmed',
      validation: 'unvalidated_numeric_bytes',
    });
    expect(result.payloads).toHaveLength(2);
    expect(killed).toBe(true);
  });
  it('does not create a sandbox when output reservation fails', async () => {
    const f = await setup();
    f.docs.documents.get('budgets/r2_storage_bytes')!.halted = true;
    let created = false;
    const pipeline = new SourcePipeline(f.executions, {
      createSource: async () => {
        created = true;
        throw new Error('unexpected');
      },
      kill: async () => 'killed',
    });
    await expect(
      pipeline.run(
        f.docs.documents.get(`sandboxJobs/${f.operationId}`)!.request,
        f.request,
        f.approvalId,
      ),
    ).rejects.toThrow('exhausted');
    expect(created).toBe(false);
  });
  it.each(['artifact', 'readiness', 'adapter'])(
    'rejects changed %s evidence before reserving outputs',
    async (kind) => {
      const f = await setup();
      if (kind === 'artifact')
        f.docs.documents.get(
          `audits/${f.audit.id}/artifacts/${f.request.entryArtifactId}`,
        )!.expiresAt = '2026-10-28T00:00:00Z';
      if (kind === 'readiness')
        f.docs.documents.get(`${f.path}/readiness/current`)!.assessment = null;
      if (kind === 'adapter') f.request.adapterDigest = 'c'.repeat(64);
      const before = structuredClone(f.docs.documents);
      await expect(
        f.executions.bind(f.request, f.approvalId),
      ).rejects.toThrow();
      expect(f.docs.documents).toEqual(before);
    },
  );
  it('reserves output/manifest and global storage together once before dispatch', async () => {
    const f = await setup();
    const binding = await f.executions.bind(f.request, f.approvalId);
    expect(binding.reservedBytes).toBe(4096 + 32768);
    expect(await f.executions.bind(f.request, f.approvalId)).toEqual(binding);
    for (const key of ['r2_storage_bytes', f.outputKey])
      expect(f.docs.documents.get(`budgets/${key}`)?.reserved).toBe(
        binding.reservedBytes,
      );
    expect(
      JSON.stringify(f.docs.documents.get(`sourceExecutions/${f.operationId}`)),
    ).not.toContain('dataBase64');
  });
  it.each(['r2_storage_bytes', 'output'])(
    'rolls back both reservations when %s budget is exhausted',
    async (key) => {
      const f = await setup();
      f.docs.documents.get(
        `budgets/${key === 'output' ? f.outputKey : key}`,
      )!.limit = 1;
      const before = structuredClone(f.docs.documents);
      await expect(f.executions.bind(f.request, f.approvalId)).rejects.toThrow(
        'exhausted',
      );
      expect(f.docs.documents).toEqual(before);
    },
  );
  it('requires a matching fresh approval and reviewed mapping instead of trusting model fields', async () => {
    const f = await setup();
    f.docs.documents.get(
      `sourceExecutionApprovals/${f.approvalId}`,
    )!.expiresAt = '2026-10-28T00:00:00Z';
    await expect(f.executions.bind(f.request, f.approvalId)).rejects.toThrow(
      'stale',
    );
    expect(f.docs.documents.has(`sourceExecutions/${f.operationId}`)).toBe(
      false,
    );
  });
  it('claims only the bound sandbox once and rejects collection after cancellation without refunds', async () => {
    const f = await setup();
    await f.executions.bind(f.request, f.approvalId);
    f.dispatch();
    await expect(
      f.executions.claim(f.request, f.payloadDigest, 'other-sandbox'),
    ).rejects.toThrow();
    await f.executions.claim(f.request, f.payloadDigest, 'fixture-source');
    await expect(
      f.executions.claim(f.request, f.payloadDigest, 'fixture-source'),
    ).rejects.toThrow('already claimed');
    await f.executions.authorizeCollection(f.operationId);
    await new AuditCommands(f.docs).cancel(
      'alice',
      f.audit.id,
      f.audit.currentRevisionId,
      'cancel',
    );
    await expect(
      f.executions.authorizeCollection(f.operationId),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    expect(f.docs.documents.get('budgets/r2_storage_bytes')?.reserved).toBe(
      36864,
    );
  });
  it('refuses a fresh binding after dispatch, including an otherwise approved request', async () => {
    const f = await setup();
    f.dispatch();
    await expect(f.executions.bind(f.request, f.approvalId)).rejects.toThrow(
      'precede dispatch',
    );
  });
});
