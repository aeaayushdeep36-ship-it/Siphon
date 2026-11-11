import { describe, expect, it, vi } from 'vitest';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { RunQueue, InspectionStageJob } from './run-queue.js';
import { InspectionCoordinator } from './inspection-coordinator.js';
import { SandboxJobs } from './sandbox-jobs.js';
import { E2bClient, type SandboxControlPlane } from './e2b-client.js';
import { InspectionPipeline } from './inspection-pipeline.js';
import { InspectionSourceLoader } from './inspection-sources.js';
import { InspectionJobs } from './inspection-jobs.js';
import { ArtifactDownloadService } from './artifact-download.js';
import { canonicalJson, sha256 } from './hashing.js';
import { AuditCommands } from './audit-commands.js';
import { type InspectionJobRequest } from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import { firestoreTransport } from '../test/firestore-transport.js';
import {
  runInspectionPhase,
  runInspectionWorkflow,
  type InspectionWorkflowSteps,
} from './inspection-workflow.js';
import { InspectionPhasePayload } from './workflow-phases.js';
import {
  createInspectionRuntime,
  type InspectionWorkflowEnvironment,
} from './inspection-runtime.js';
import { generateKeyPair, exportPKCS8, jwtVerify } from 'jose';

function workflowSteps(
  hooks: {
    before?: (name: string) => void;
    after?: (name: string) => void;
  } = {},
) {
  const saved = new Map<string, unknown>();
  const steps: InspectionWorkflowSteps = {
    do: async <T>(
      name: string,
      config: Parameters<InspectionWorkflowSteps['do']>[1],
      callback: () => Promise<T>,
    ) => {
      expect(config.retries.limit).toBe(0);
      if (saved.has(name)) return structuredClone(saved.get(name)) as T;
      hooks.before?.(name);
      const result = await callback();
      hooks.after?.(name);
      saved.set(name, structuredClone(result));
      return structuredClone(result);
    },
  };
  return { steps, saved };
}

async function setup(
  decorate?: (documents: TestDocuments) => DocumentStore,
  sourceCount = 1,
  requestCount: () => number = () => 0,
) {
  const docs = new TestDocuments();
  const store = decorate?.(docs) ?? docs;
  const now = new Date('2026-10-29T00:00:00Z');
  const clock = () => now;
  docs.documents.set('testers/alice', { active: true });
  const { audit } = await new FirestoreAuditRepository(store, clock).create(
    'alice',
    {
      schemaVersion: '1.0',
      title: 'Coordinated inspection',
      domain: 'heat_diffusion',
    },
    'create',
  );
  const path = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
  const source = 'x = 1\n',
    bytes = new TextEncoder().encode(source),
    artifactId = crypto.randomUUID();
  const entry = {
    schemaVersion: '1.0' as const,
    artifactId,
    path: 'model.py',
    bytes: bytes.length,
    sha256: await sha256(source),
  };
  const manifest = [
    entry,
    ...Array.from({ length: sourceCount - 1 }, (_, index) => ({
      ...entry,
      artifactId: crypto.randomUUID(),
      path: `model_${index + 1}.py`,
    })),
  ];
  Object.assign(docs.documents.get(path)!, {
    sourceManifest: manifest,
    inputDigest: await sha256(
      canonicalJson({ uploads: manifest, answers: [] }),
    ),
    generation: 1,
  });
  const artifactPath = `audits/${audit.id}/artifacts/${artifactId}`;
  for (const file of manifest)
    docs.documents.set(`audits/${audit.id}/artifacts/${file.artifactId}`, {
      ...file,
      id: file.artifactId,
      ownerUid: 'alice',
      auditId: audit.id,
      revisionId: audit.currentRevisionId,
      kind: 'upload',
      lifecycle: 'ready',
      objectKey: `audits/alice/${audit.id}/artifacts/${file.artifactId}/content`,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: '2026-10-30T00:00:00Z',
    });
  const revision = docs.documents.get(path)!;
  const input = {
    schemaVersion: '1.0',
    expectedGeneration: 1,
    expectedInputDigest: revision.inputDigest,
  };
  const queue = new RunQueue(store, clock);
  const enqueue = (key = 'run') =>
    queue.enqueue('alice', audit.id, audit.currentRevisionId, input, key);
  const templateId = crypto.randomUUID();
  docs.documents.set('configuration/inspection_dispatch', {
    templateEvidenceId: templateId,
    lifetimeSeconds: 60,
  });
  docs.documents.set(`sandboxTemplates/${templateId}`, {
    schemaVersion: '1.0',
    id: templateId,
    templateId: 'authored-inspection',
    templateBuildId: 'authored-build',
    templateTag: 'authored-build-tag',
    role: 'inspection',
    imageDigest: 'a'.repeat(64),
    runtimeDigest: 'b'.repeat(64),
    verifiedAt: '2026-10-28T00:00:00Z',
    expiresAt: '2026-10-30T00:00:00Z',
    networkIsolationVerified: true,
    privateAccessVerified: true,
    resourceLimitsVerified: true,
    singlePrivateBuildVerified: true,
    microUsdPerSecondCeiling: 1,
  });
  docs.documents.set('configuration/e2b_credits', {
    schemaVersion: '1.0',
    evidenceId: crypto.randomUUID(),
    allocationMicroUsd: 1000,
    availableMicroUsd: 1000,
    accountedSpentMicroUsd: 0,
    verifiedAt: '2026-10-28T00:00:00Z',
    expiresAt: '2026-10-30T00:00:00Z',
  });
  docs.documents.set('budgets/e2b_global_micro_usd', {
    schemaVersion: '1.0',
    limit: 900,
    reserved: 0,
    spent: 0,
    halted: false,
  });
  docs.documents.set('configuration/r2_class_b_period', {
    counterKey: 'class_b',
    startsAt: '2026-10-01T00:00:00Z',
    endsAt: '2026-11-01T00:00:00Z',
  });
  docs.documents.set('budgets/class_b', {
    schemaVersion: '1.0',
    limit: 100,
    reserved: 0,
    spent: 0,
    halted: false,
  });
  let staged: InspectionJobRequest;
  const session = {
    sandboxId: 'authored-inspection-vm',
    writeRequest: vi.fn(async (value: Uint8Array) => {
      staged = JSON.parse(new TextDecoder().decode(value));
    }),
    run: vi.fn(async () => 0),
    readResult: async () =>
      new Response(
        JSON.stringify({
          schemaVersion: '1.0',
          operationId: staged.operationId,
          inputDigest: staged.inputDigest,
          sources: staged.sources.map((item) => ({
            artifactId: item.artifactId,
            inspection: {
              schemaVersion: '1.0',
              sourceDigest: item.sourceDigest,
              parsed: true,
              truncated: false,
              dependencies: [],
              definitions: [],
              findings: [],
            },
          })),
        }),
      ).body!,
  };
  const provider = {
    verifyTemplate: vi.fn<NonNullable<SandboxControlPlane['verifyTemplate']>>(
      async () => ({
        buildId: 'authored-build',
        tagBuildId: 'authored-build',
        buildCount: 1,
        isPrivate: true,
      }),
    ),
    create: vi.fn<SandboxControlPlane['create']>(async () => ({
      sandboxId: session.sandboxId,
      inspectionSession: session,
    })),
    kill: vi.fn<SandboxControlPlane['kill']>(async () => true),
  };
  const jobs = new SandboxJobs(store, clock),
    client = new E2bClient('authored-secret', jobs, provider);
  const downloads = new ArtifactDownloadService(
    store,
    {
      get: async (key) => {
        expect(
          manifest.some(
            (file) =>
              key ===
              `audits/alice/${audit.id}/artifacts/${file.artifactId}/content`,
          ),
        ).toBe(true);
        return {
          size: bytes.length,
          sha256: entry.sha256,
          body: new Response(bytes).body!,
        };
      },
    },
    clock,
  );
  const pipelineBoundaries: { name: string; requestCount: number }[] = [];
  const pipeline = new InspectionPipeline(
    new InspectionSourceLoader(store, downloads),
    client,
    new InspectionJobs(store, clock),
    (name) =>
      pipelineBoundaries.push({
        name,
        requestCount: requestCount(),
      }),
  );
  const coordinator = new InspectionCoordinator(store, jobs, pipeline, clock);
  return {
    docs,
    now,
    audit,
    path,
    artifactPath,
    entry,
    bytes,
    queue,
    input,
    enqueue,
    templateId,
    session,
    provider,
    jobs,
    client,
    coordinator,
    pipeline,
    pipelineBoundaries,
    store,
  };
}

describe('durable audit queue and concrete inspection coordination (offline)', () => {
  it('composes the configured Workflow runtime with real OAuth signing, REST boundaries and private R2 byte verification', async () => {
    const f = await setup();
    const { receipt } = await f.enqueue();
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKey = await exportPKCS8(keys.privateKey);
    const http = firestoreTransport(f.docs);
    let oauthCalls = 0;
    const transport: typeof fetch = async (input, init) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        oauthCalls++;
        const assertion = new URLSearchParams(String(init?.body)).get(
          'assertion',
        )!;
        const verified = await jwtVerify(assertion, keys.publicKey, {
          issuer: 'workflow@siphon-test.iam.gserviceaccount.com',
          audience: 'https://oauth2.googleapis.com/token',
          currentDate: f.now,
        });
        expect(verified.payload.scope).toBe(
          'https://www.googleapis.com/auth/datastore',
        );
        return Response.json({
          access_token: 'authored-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      return http.transport(input, init);
    };
    const environment: InspectionWorkflowEnvironment = {
      SIPHON_INSPECTION_WORKFLOW_ENABLED: 'true',
      FIREBASE_PROJECT_ID: 'siphon-test',
      GOOGLE_SERVICE_ACCOUNT_EMAIL:
        'workflow@siphon-test.iam.gserviceaccount.com',
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey,
      E2B_API_KEY: 'authored-runtime-secret',
      SIPHON_ARTIFACTS: {
        get: async (key) => {
          expect(key).toBe(
            `audits/alice/${f.audit.id}/artifacts/${f.entry.artifactId}/content`,
          );
          return {
            size: f.bytes.length,
            checksums: {
              sha256: Uint8Array.from(f.entry.sha256.match(/../g)!, (value) =>
                Number.parseInt(value, 16),
              ).buffer,
            },
            body: new Response(f.bytes).body!,
          };
        },
      },
    };
    expect(() =>
      createInspectionRuntime(
        { ...environment, SIPHON_INSPECTION_WORKFLOW_ENABLED: 'false' },
        transport,
        f.provider,
        () => f.now,
      ),
    ).toThrow();
    expect(oauthCalls).toBe(0);
    expect(f.provider.create).not.toHaveBeenCalled();
    const runtime = createInspectionRuntime(
      environment,
      transport,
      f.provider,
      () => f.now,
    );
    const durable = workflowSteps();
    expect(
      (
        await runInspectionWorkflow(
          { schemaVersion: '1.0', jobId: receipt.jobId },
          durable.steps,
          runtime,
        )
      ).status,
    ).toBe('inspection_complete');
    expect(oauthCalls).toBe(1);
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    expect(f.provider.kill).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...durable.saved.values()])).not.toContain(
      privateKey,
    );
    expect(JSON.stringify([...durable.saved.values()])).not.toContain(
      'authored-runtime-secret',
    );
    expect(f.docs.documents.get('budgets/class_b')?.spent).toBe(1);
  });
  it('drives retry-disabled workflow steps with bounded metadata and no repeated provider or private reads on replay', async () => {
    const f = await setup();
    const { receipt } = await f.enqueue();
    const durable = workflowSteps();
    const payload = { schemaVersion: '1.0', jobId: receipt.jobId };
    const result = await runInspectionWorkflow(
      payload,
      durable.steps,
      f.coordinator,
    );
    expect(result.status).toBe('inspection_complete');
    expect([...durable.saved.keys()]).toEqual([
      'inspection.begin',
      'inspection.reserve',
      'inspection.execute',
      'inspection.cleanup',
      'inspection.finish',
    ]);
    const checkpoints = JSON.stringify([...durable.saved.values()]);
    expect(checkpoints).not.toContain('sourceBase64');
    expect(checkpoints).not.toContain('x = 1');
    expect(checkpoints).not.toContain('authored-secret');
    expect(new TextEncoder().encode(checkpoints).length).toBeLessThan(16_384);
    expect(
      await runInspectionWorkflow(payload, durable.steps, f.coordinator),
    ).toEqual(result);
    durable.saved.set('inspection.finish', {
      ...result,
      operationId: crypto.randomUUID(),
    });
    await expect(
      runInspectionWorkflow(payload, durable.steps, f.coordinator),
    ).rejects.toThrow('result identity mismatch');
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    expect(f.provider.kill).toHaveBeenCalledTimes(1);
    expect(f.docs.documents.get('budgets/class_b')?.spent).toBe(1);
  });
  it('recovers from a lost execution-step checkpoint without running the parser or downloading source again', async () => {
    const f = await setup();
    const { receipt } = await f.enqueue();
    let loseCheckpoint = true;
    const durable = workflowSteps({
      after: (name) => {
        if (name === 'inspection.execute' && loseCheckpoint) {
          loseCheckpoint = false;
          throw new Error('Authored lost Workflow checkpoint');
        }
      },
    });
    const payload = { schemaVersion: '1.0', jobId: receipt.jobId };
    expect(
      (await runInspectionWorkflow(payload, durable.steps, f.coordinator))
        .status,
    ).toBe('inspection_complete');
    expect(durable.saved.has('inspection.execute')).toBe(false);
    expect(
      (await runInspectionWorkflow(payload, durable.steps, f.coordinator))
        .status,
    ).toBe('inspection_complete');
    expect(durable.saved.get('inspection.execute')).toMatchObject({
      status: 'already_claimed',
    });
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    expect(f.session.run).toHaveBeenCalledTimes(1);
    expect(f.provider.kill).toHaveBeenCalledTimes(1);
    expect(f.docs.documents.get('budgets/class_b')?.spent).toBe(1);
  });
  it('resumes cleanup after an interrupted cleanup step and honors existing termination proof', async () => {
    const f = await setup();
    const { receipt } = await f.enqueue();
    let interrupt = true;
    const durable = workflowSteps({
      before: (name) => {
        if (name === 'inspection.cleanup' && interrupt) {
          interrupt = false;
          throw new Error('Authored interruption before cleanup');
        }
      },
    });
    const payload = { schemaVersion: '1.0', jobId: receipt.jobId };
    await expect(
      runInspectionWorkflow(payload, durable.steps, f.coordinator),
    ).rejects.toThrow('before cleanup');
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    expect(f.provider.kill).not.toHaveBeenCalled();
    expect(
      (await runInspectionWorkflow(payload, durable.steps, f.coordinator))
        .status,
    ).toBe('inspection_complete');
    expect((await f.coordinator.cleanup(receipt.jobId)).cleanup).toBe(
      'confirmed',
    );
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    expect(f.provider.kill).toHaveBeenCalledTimes(1);
  });
  it('checkpoints metadata between separate preparation, dispatch and recovery deliveries', async () => {
    const f = await setup();
    const { receipt } = await f.enqueue();
    const initial = await f.coordinator.begin(receipt.jobId);
    if (initial.action !== 'prepare')
      throw new Error('Missing preparation phase');
    const recreate = () =>
      new InspectionCoordinator(f.store, f.jobs, f.pipeline, () => f.now);
    const reserved = await recreate().reserve(
      JSON.parse(JSON.stringify(initial.job)),
    );
    expect(f.provider.create).not.toHaveBeenCalled();
    const counter = structuredClone(
      f.docs.documents.get('budgets/e2b_global_micro_usd'),
    );
    expect(await recreate().reserve(initial.job)).toEqual(reserved);
    expect(f.docs.documents.get('budgets/e2b_global_micro_usd')).toEqual(
      counter,
    );
    await recreate().dispatch(JSON.parse(JSON.stringify(reserved)));
    await recreate().dispatch(reserved);
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    expect(f.provider.kill).toHaveBeenCalledTimes(1);
    expect((await recreate().recover(receipt.jobId)).status).toBe(
      'inspection_complete',
    );
    expect((await recreate().begin(receipt.jobId)).action).toBe('recover');
  });
  it('refuses provider dispatch when a prepared snapshot is changed or cancelled', async () => {
    const f = await setup();
    const { receipt } = await f.enqueue();
    const initial = await f.coordinator.begin(receipt.jobId);
    if (initial.action !== 'prepare')
      throw new Error('Missing preparation phase');
    const reserved = await f.coordinator.reserve(initial.job);
    await expect(
      f.coordinator.dispatch({
        ...reserved,
        sandboxRequest: { ...reserved.sandboxRequest, lifetimeSeconds: 59 },
      }),
    ).rejects.toThrow();
    Object.assign(f.docs.documents.get(f.path)!, {
      cancellationRequestedAt: f.now.toISOString(),
      status: 'cancelled',
      generation: reserved.generation + 1,
    });
    await expect(f.coordinator.dispatch(reserved)).rejects.toThrow();
    expect(f.provider.create).not.toHaveBeenCalled();
  });
  it('denies a corrupted reservation checkpoint before touching either operation or refunding money', async () => {
    const f = await setup();
    const { receipt } = await f.enqueue();
    const initial = await f.coordinator.begin(receipt.jobId);
    if (initial.action !== 'prepare')
      throw new Error('Missing preparation phase');
    const reserved = await f.coordinator.reserve(initial.job);
    const foreignId = crypto.randomUUID();
    const foreign = {
      ...f.docs.documents.get(`operations/${reserved.operationId}`)!,
      id: foreignId,
    };
    f.docs.documents.set(`operations/${foreignId}`, foreign);
    const before = structuredClone(f.docs.documents);
    await expect(
      f.coordinator.reserve({ ...reserved, operationId: foreignId }),
    ).rejects.toThrow('checkpoint changed');
    expect(f.docs.documents).toEqual(before);
    expect(f.provider.create).not.toHaveBeenCalled();
  });
  it('allows concurrent prepared-phase deliveries to dispatch only one provider job', async () => {
    const f = await setup();
    const { receipt } = await f.enqueue();
    const initial = await f.coordinator.begin(receipt.jobId);
    if (initial.action !== 'prepare')
      throw new Error('Missing preparation phase');
    const reserved = await f.coordinator.reserve(initial.job);
    await Promise.all([
      f.coordinator.dispatch(reserved),
      f.coordinator.dispatch(reserved),
    ]);
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    expect(f.provider.kill).toHaveBeenCalledTimes(1);
    expect((await f.coordinator.recover(receipt.jobId)).status).toBe(
      'inspection_complete',
    );
  });
  it('cannot refund preparation after a concurrent delivery claims provider dispatch', async () => {
    const f = await setup();
    const { receipt } = await f.enqueue();
    const initial = await f.coordinator.begin(receipt.jobId);
    if (initial.action !== 'prepare')
      throw new Error('Missing preparation phase');
    const reserved = await f.coordinator.reserve(initial.job);
    let failPreparation!: () => void, finishPipeline!: () => void;
    let enteredBinding!: () => void, enteredPipeline!: () => void;
    const binding = new Promise<void>((resolve) => {
      enteredBinding = resolve;
    });
    const started = new Promise<void>((resolve) => {
      enteredPipeline = resolve;
    });
    vi.spyOn(f.jobs, 'bind').mockImplementationOnce(async () => {
      enteredBinding();
      await new Promise<void>((resolve) => {
        failPreparation = resolve;
      });
      throw new Error('Authored late preparation failure');
    });
    const late = f.coordinator.reserve(reserved);
    const rejected = expect(late).rejects.toThrow('late preparation failure');
    await binding;
    const dispatcher = new InspectionCoordinator(
      f.store,
      f.jobs,
      {
        run: async () => {
          enteredPipeline();
          await new Promise<void>((resolve) => {
            finishPipeline = resolve;
          });
          return {
            resultDigest: 'a'.repeat(64),
            replayed: false,
            cleanup: 'pending' as const,
          };
        },
      },
      () => f.now,
    );
    const dispatch = dispatcher.dispatch(reserved);
    await started;
    const counter = structuredClone(
      f.docs.documents.get('budgets/e2b_global_micro_usd'),
    );
    failPreparation();
    await rejected;
    expect(f.docs.documents.get('budgets/e2b_global_micro_usd')).toEqual(
      counter,
    );
    expect(
      f.docs.documents.get(`operations/${reserved.operationId}`)?.outcome,
    ).toBe('reserved');
    expect(f.docs.documents.get(`stageJobs/${reserved.id}`)?.status).toBe(
      'dispatching',
    );
    expect(f.docs.documents.get(`slotLeases/${reserved.leaseId}`)?.status).toBe(
      'held',
    );
    finishPipeline();
    await dispatch;
  });
  it('executes once, returns only a receipt and leaves cleanup to a separate durable phase', async () => {
    const f = await setup();
    const { receipt } = await f.enqueue();
    const initial = await f.coordinator.begin(receipt.jobId);
    if (initial.action !== 'prepare')
      throw new Error('Missing preparation phase');
    const reserved = await f.coordinator.reserve(initial.job);
    const execution = await f.coordinator.execute(reserved);
    expect(execution).toMatchObject({
      status: 'execution_finished',
      receipt: { status: 'published', operationId: reserved.operationId },
    });
    expect(JSON.stringify(execution)).not.toContain('x = 1');
    expect(JSON.stringify(execution)).not.toContain('authored-secret');
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    expect(f.provider.kill).not.toHaveBeenCalled();
    expect((await f.coordinator.recover(receipt.jobId)).status).toBe(
      'awaiting_reconciliation',
    );
    expect(
      f.docs.documents.get(`slotLeases/${reserved.leaseId}`)?.pendingOperations,
    ).toBe(1);
    expect((await f.coordinator.execute(reserved)).status).toBe(
      'already_claimed',
    );
    expect(await f.coordinator.cleanup(receipt.jobId)).toMatchObject({
      cleanup: 'confirmed',
    });
    expect(await f.coordinator.cleanup(receipt.jobId)).toMatchObject({
      cleanup: 'confirmed',
    });
    expect((await f.coordinator.finish(receipt.jobId)).status).toBe(
      'inspection_complete',
    );
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    expect(f.provider.kill).toHaveBeenCalledTimes(1);
  });
  it('uses a redacted failure receipt and reconciles a known failed execution after cleanup', async () => {
    const f = await setup();
    const { receipt } = await f.enqueue();
    const initial = await f.coordinator.begin(receipt.jobId);
    if (initial.action !== 'prepare')
      throw new Error('Missing preparation phase');
    const reserved = await f.coordinator.reserve(initial.job);
    f.session.run.mockRejectedValueOnce(new Error('private exception marker'));
    const result = await f.coordinator.execute(reserved);
    expect(result).toMatchObject({
      receipt: { status: 'execution_failed', failureCode: 'inspection_failed' },
    });
    expect(JSON.stringify(result)).not.toContain('private exception marker');
    expect(f.provider.kill).not.toHaveBeenCalled();
    await f.coordinator.cleanup(receipt.jobId);
    expect((await f.coordinator.finish(receipt.jobId)).status).toBe(
      'inspection_failed',
    );
    expect(f.docs.documents.get(`slotLeases/${reserved.leaseId}`)?.status).toBe(
      'released',
    );
    expect(f.docs.documents.get('budgets/e2b_global_micro_usd')?.reserved).toBe(
      60,
    );
  });
  it('retains unknown creation and permits no second execution when cleanup has no known handle', async () => {
    const f = await setup();
    const { receipt } = await f.enqueue();
    const initial = await f.coordinator.begin(receipt.jobId);
    if (initial.action !== 'prepare')
      throw new Error('Missing preparation phase');
    const reserved = await f.coordinator.reserve(initial.job);
    f.provider.create.mockRejectedValueOnce(
      new Error('Authored ambiguous create'),
    );
    expect(await f.coordinator.execute(reserved)).toMatchObject({
      receipt: {
        status: 'execution_failed',
        failureCode: 'create_unknown',
        sandboxId: null,
      },
    });
    expect(await f.coordinator.cleanup(receipt.jobId)).toMatchObject({
      cleanup: 'pending',
    });
    expect((await f.coordinator.finish(receipt.jobId)).status).toBe(
      'awaiting_reconciliation',
    );
    expect((await f.coordinator.execute(reserved)).status).toBe(
      'already_claimed',
    );
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    expect(f.docs.documents.get(`slotLeases/${reserved.leaseId}`)?.status).toBe(
      'held',
    );
  });
  it('can terminate after cancellation while denying final evidence continuation', async () => {
    const f = await setup();
    const { receipt } = await f.enqueue();
    const initial = await f.coordinator.begin(receipt.jobId);
    if (initial.action !== 'prepare')
      throw new Error('Missing preparation phase');
    const reserved = await f.coordinator.reserve(initial.job);
    await f.coordinator.execute(reserved);
    await new AuditCommands(f.docs, () => f.now).cancel(
      'alice',
      f.audit.id,
      f.audit.currentRevisionId,
      'cancel',
    );
    expect(await f.coordinator.cleanup(receipt.jobId)).toMatchObject({
      cleanup: 'confirmed',
    });
    await expect(f.coordinator.finish(receipt.jobId)).rejects.toThrow();
    expect(f.provider.kill).toHaveBeenCalledTimes(1);
    expect(f.docs.documents.get(f.path)?.status).toBe('cancelled');
    expect(
      f.docs.documents.get(`slotLeases/${reserved.leaseId}`)?.pendingOperations,
    ).toBe(0);
  });
  it('repairs pending-operation inventory from existing termination proof without a second kill', async () => {
    const f = await setup();
    const { receipt } = await f.enqueue();
    const initial = await f.coordinator.begin(receipt.jobId);
    if (initial.action !== 'prepare')
      throw new Error('Missing preparation phase');
    const reserved = await f.coordinator.reserve(initial.job);
    await f.coordinator.execute(reserved);
    await f.coordinator.cleanup(receipt.jobId);
    // Authored crash snapshot: termination proof committed, completion inventory
    // commit lost. No timeout or assumed provider result manufactures the proof.
    f.docs.documents.get(`slotLeases/${reserved.leaseId}`)!.pendingOperations =
      1;
    Object.assign(
      f.docs.documents.get(`leaseOperations/${reserved.operationId}`)!,
      { status: 'pending', completionKind: null },
    );
    expect((await f.coordinator.cleanup(receipt.jobId)).cleanup).toBe(
      'confirmed',
    );
    expect(f.provider.kill).toHaveBeenCalledTimes(1);
    expect(
      f.docs.documents.get(`slotLeases/${reserved.leaseId}`)?.pendingOperations,
    ).toBe(0);
    expect((await f.coordinator.finish(receipt.jobId)).status).toBe(
      'inspection_complete',
    );
  });
  it('chains begin, reserve, execute, cleanup and finish as metadata-only child phases', async () => {
    const f = await setup();
    const { receipt } = await f.enqueue();
    const job = InspectionStageJob.parse(
      f.docs.documents.get(`stageJobs/${receipt.jobId}`),
    );
    const phase = InspectionPhasePayload.parse({
      schemaVersion: '1.0',
      jobId: receipt.jobId,
      phase: 'inspection_begin',
      phaseKey: job.operationId,
    });
    const dispatched: InspectionPhasePayload[] = [];
    const steps = {
      run: async <T>(_name: string, callback: () => Promise<T>) => callback(),
    };
    const run = (value: unknown) =>
      runInspectionPhase(
        value,
        steps,
        f.coordinator,
        async (jobId) =>
          InspectionStageJob.parse(f.docs.documents.get(`stageJobs/${jobId}`)),
        async (payload) => void dispatched.push(payload),
      );

    const begin = await run(phase);
    expect(begin).toMatchObject({ phase: 'inspection_reserve' });
    const reserve = await run(dispatched.pop());
    expect(reserve).toMatchObject({ phase: 'inspection_execute' });
    const execute = await run(dispatched.pop());
    expect(execute).toMatchObject({ phase: 'inspection_cleanup' });
    const cleanup = await run(dispatched.pop());
    expect(cleanup).toMatchObject({ phase: 'inspection_finish' });
    const finish = await run(dispatched.pop());
    expect(finish).toMatchObject({ status: 'inspection_complete' });
    expect(dispatched).toHaveLength(0);
    expect(JSON.stringify(phase)).not.toMatch(
      /sourceText|requestBody|sandboxId/,
    );
  });
  it.each([
    [1, false],
    [10, false],
    [10, true],
  ] as const)(
    'bounds separate phase REST calls for %i sources (distinct original revisions: %s)',
    async (sourceCount, originalRevisions) => {
      let counted: ReturnType<typeof firestoreTransport>;
      const f = await setup(
        (documents) => {
          counted = firestoreTransport(documents);
          return counted.client;
        },
        sourceCount,
        () => counted.calls.length,
      );
      if (originalRevisions) {
        const current = structuredClone(f.docs.documents.get(f.path)!);
        const uploads = [...f.docs.documents.values()].filter(
          (record) => record.kind === 'upload',
        );
        for (const artifact of uploads) {
          const originalId = crypto.randomUUID();
          f.docs.documents.set(`audits/${f.audit.id}/revisions/${originalId}`, {
            ...current,
            revisionId: originalId,
            stage: 'draft',
            status: 'idle',
          });
          artifact.revisionId = originalId;
        }
      }
      const { receipt } = await f.enqueue();
      const counts: Record<string, number> = {};
      let cursor = counted!.calls.length;
      const measure = (name: string) => {
        counts[name] = counted!.calls.length - cursor;
        cursor = counted!.calls.length;
      };
      const initial = await f.coordinator.begin(receipt.jobId);
      measure('begin');
      if (initial.action !== 'prepare')
        throw new Error('Missing preparation phase');
      const reserved = await f.coordinator.reserve(initial.job);
      measure('reserve');
      const executeStart = counted!.calls.length;
      expect((await f.coordinator.execute(reserved)).status).toBe(
        'execution_finished',
      );
      const pipelineSegments = f.pipelineBoundaries.map(
        (boundary, index) =>
          boundary.requestCount -
          (index === 0
            ? executeStart
            : f.pipelineBoundaries[index - 1]!.requestCount),
      );
      expect(pipelineSegments).toEqual(
        originalRevisions ? [18, 12, 9, 4] : [16, 12, 9, 4],
      );
      if (process.env.SIPHON_TRACE_REST === '1')
        console.log('Inspection execute REST boundaries', {
          start: executeStart,
          boundaries: f.pipelineBoundaries,
          segments: pipelineSegments,
        });
      measure('execute');
      expect((await f.coordinator.cleanup(receipt.jobId)).cleanup).toBe(
        'confirmed',
      );
      measure('cleanup');
      expect((await f.coordinator.finish(receipt.jobId)).status).toBe(
        'inspection_complete',
      );
      measure('finish');
      // Leave headroom for authentication and scheduler calls. These are metadata
      // phase regression bounds, not a claim that hosted CPU/provider I/O fits Free.
      for (const name of ['begin', 'reserve', 'execute', 'cleanup', 'finish'])
        expect(counts[name]).toBeLessThanOrEqual(44);
      if (process.env.SIPHON_TRACE_REST === '1')
        console.log(
          'Inspection REST requests',
          sourceCount,
          originalRevisions,
          counts,
        );
      expect(counted!.batches.every((paths) => paths.length <= 40)).toBe(true);
      expect(f.provider.create).toHaveBeenCalledTimes(1);
      expect(f.provider.kill).toHaveBeenCalledTimes(1);
    },
  );
  it('queues one frozen snapshot with real progress and initializes only missing revision counters', async () => {
    const f = await setup();
    const first = await f.enqueue();
    expect(first.receipt.status).toBe('queued');
    expect(first.receipt.generation).toBe(2);
    expect((await f.enqueue()).replayed).toBe(true);
    expect((await f.enqueue('different-key')).receipt.jobId).toBe(
      first.receipt.jobId,
    );
    expect(f.docs.documents.get(f.path)).toMatchObject({
      generation: 2,
      stage: 'draft',
      status: 'queued',
      progress: { activity: 'queued', eventCount: 1 },
    });
    expect(
      f.docs.documents.get(`budgets/e2b_seconds_${f.audit.currentRevisionId}`),
    ).toMatchObject({ limit: 900, spent: 0, reserved: 0 });
    expect(f.docs.documents.has('budgets/meta_global_micro_usd')).toBe(false);
    expect(f.provider.create).not.toHaveBeenCalled();
  });
  it.each([
    'missing_source',
    'unready',
    'expired',
    'changed_hash',
    'wrong_owner',
    'stale_generation',
  ])('rejects %s before any queue/counter/provider work', async (kind) => {
    const f = await setup();
    if (kind === 'missing_source')
      f.docs.documents.get(f.path)!.sourceManifest = [];
    if (kind === 'unready')
      f.docs.documents.get(f.artifactPath)!.lifecycle = 'reserved';
    if (kind === 'expired')
      f.docs.documents.get(f.artifactPath)!.expiresAt = '2026-10-28T00:00:00Z';
    if (kind === 'changed_hash')
      f.docs.documents.get(f.artifactPath)!.sha256 = 'f'.repeat(64);
    if (kind === 'wrong_owner')
      f.docs.documents.get(f.artifactPath)!.ownerUid = 'bob';
    if (kind === 'stale_generation') f.input.expectedGeneration = 0;
    await expect(f.enqueue()).rejects.toThrow();
    expect(
      [...f.docs.documents.keys()].some((key) => key.startsWith('stageJobs/')),
    ).toBe(false);
    expect(
      f.docs.documents.has(`budgets/e2b_seconds_${f.audit.currentRevisionId}`),
    ).toBe(false);
    expect(f.provider.create).not.toHaveBeenCalled();
  });
  it('preserves a stricter existing allowance and does not reset spending on replay', async () => {
    const f = await setup();
    const key = `budgets/model_attempts_${f.audit.currentRevisionId}`;
    f.docs.documents.set(key, {
      schemaVersion: '1.0',
      limit: 4,
      spent: 1,
      reserved: 1,
      halted: false,
    });
    await f.enqueue();
    await f.enqueue();
    expect(f.docs.documents.get(key)).toMatchObject({
      limit: 4,
      spent: 1,
      reserved: 1,
    });
  });
  it('denies cancelled input and changed idempotency payload rather than reviving queued work', async () => {
    const f = await setup();
    await f.enqueue();
    await expect(
      f.queue.enqueue(
        'alice',
        f.audit.id,
        f.audit.currentRevisionId,
        { ...f.input, expectedGeneration: 0 },
        'run',
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await new AuditCommands(f.docs, () => f.now).cancel(
      'alice',
      f.audit.id,
      f.audit.currentRevisionId,
      'cancel',
    );
    await expect(f.enqueue()).rejects.toMatchObject({ code: 'stale_revision' });
  });
  it('connects capacity, exact reservations, private reads, inspection publication and termination without duplicate dispatch', async () => {
    const f = await setup();
    const { receipt } = await f.enqueue();
    const result = await f.coordinator.run(receipt.jobId);
    expect(result).toMatchObject({
      status: 'inspection_complete',
      next: 'review_requirements',
    });
    expect(f.provider.create).toHaveBeenCalledOnce();
    expect(f.session.run).toHaveBeenCalledOnce();
    expect(f.provider.kill).toHaveBeenCalledOnce();
    expect(await f.coordinator.run(receipt.jobId)).toEqual(result);
    expect(f.provider.create).toHaveBeenCalledOnce();
    expect(f.docs.documents.get('slots/global')).toMatchObject({
      leaseIds: [],
    });
    expect(f.docs.documents.get('budgets/e2b_global_micro_usd')).toMatchObject({
      reserved: 60,
      spent: 0,
    });
    expect(f.docs.documents.get('budgets/class_b')?.spent).toBe(1);
    expect(f.docs.documents.get('dailyQuotas/global_2026-10-29')?.count).toBe(
      1,
    );
    const job = InspectionStageJob.parse(
      f.docs.documents.get(`stageJobs/${receipt.jobId}`),
    );
    expect(job.status).toBe('inspection_complete');
    expect(f.docs.documents.get(`operations/${job.operationId}`)?.fence).toBe(
      3,
    );
  });
  it('retains an ambiguous kill and recovers its recorded result without rerunning or repeating downloads', async () => {
    const f = await setup();
    f.provider.kill.mockRejectedValueOnce(new Error('unknown kill'));
    const { receipt } = await f.enqueue();
    expect((await f.coordinator.run(receipt.jobId)).status).toBe(
      'awaiting_reconciliation',
    );
    expect((await f.coordinator.run(receipt.jobId)).status).toBe(
      'awaiting_reconciliation',
    );
    expect(f.provider.create).toHaveBeenCalledOnce();
    expect(f.docs.documents.get('budgets/class_b')?.spent).toBe(1);
    expect(f.docs.documents.get('slots/global')?.leaseIds).toHaveLength(1);
    const job = InspectionStageJob.parse(
      f.docs.documents.get(`stageJobs/${receipt.jobId}`),
    );
    await f.client.kill(job.operationId, f.session.sandboxId);
    expect((await f.coordinator.recover(receipt.jobId)).status).toBe(
      'inspection_complete',
    );
    expect(f.docs.documents.get('slots/global')?.leaseIds).toHaveLength(0);
    expect(f.provider.create).toHaveBeenCalledOnce();
  });
  it.each(['template', 'money', 'binding'])(
    'releases known unused capacity on %s preparation failure without consuming admission',
    async (kind) => {
      const f = await setup();
      if (kind === 'template')
        f.docs.documents.get(`sandboxTemplates/${f.templateId}`)!.expiresAt =
          '2026-10-28T00:00:00Z';
      if (kind === 'money')
        f.docs.documents.get('budgets/e2b_global_micro_usd')!.limit = 0;
      const coordinator =
        kind === 'binding'
          ? new InspectionCoordinator(
              f.docs,
              {
                bind: async () => {
                  throw new Error('binding failed');
                },
              },
              {
                run: async () => {
                  throw new Error('must not run');
                },
              },
              () => f.now,
            )
          : f.coordinator;
      const { receipt } = await f.enqueue();
      await expect(coordinator.run(receipt.jobId)).rejects.toThrow();
      expect(f.provider.create).not.toHaveBeenCalled();
      expect(f.docs.documents.get('slots/global')?.leaseIds).toHaveLength(0);
      expect(f.docs.documents.has('dailyQuotas/global_2026-10-29')).toBe(false);
      expect(
        f.docs.documents.get('budgets/e2b_global_micro_usd')?.reserved,
      ).toBe(0);
      expect((await coordinator.run(receipt.jobId)).status).toBe(
        'awaiting_reconciliation',
      );
    },
  );
  it('allows concurrent delivery to invoke the pipeline only once', async () => {
    const f = await setup();
    const { receipt } = await f.enqueue();
    const results = await Promise.all([
      f.coordinator.run(receipt.jobId),
      f.coordinator.run(receipt.jobId),
    ]);
    expect(
      results.some((result) => result.status === 'inspection_complete'),
    ).toBe(true);
    expect(f.provider.create).toHaveBeenCalledOnce();
    expect(f.session.run).toHaveBeenCalledOnce();
    expect(f.docs.documents.get('dailyQuotas/global_2026-10-29')?.count).toBe(
      1,
    );
  });
  it('retains ambiguous creation and refuses a second provider invocation', async () => {
    const f = await setup();
    f.provider.create.mockRejectedValueOnce(new Error('response lost'));
    const { receipt } = await f.enqueue();
    await expect(f.coordinator.run(receipt.jobId)).rejects.toMatchObject({
      code: 'create_unknown',
    });
    expect((await f.coordinator.run(receipt.jobId)).status).toBe(
      'awaiting_reconciliation',
    );
    expect(f.provider.create).toHaveBeenCalledOnce();
    expect(f.provider.kill).not.toHaveBeenCalled();
    expect(f.docs.documents.get('slots/global')?.leaseIds).toHaveLength(1);
    expect(f.docs.documents.get('budgets/e2b_global_micro_usd')?.reserved).toBe(
      60,
    );
  });
  it.each(['process', 'source_bytes'])(
    'records a known %s failure without rerunning and releases only safe resources',
    async (kind) => {
      const f = await setup();
      if (kind === 'process') f.session.run.mockResolvedValueOnce(2);
      if (kind === 'source_bytes') f.bytes[0] = 0;
      const { receipt } = await f.enqueue();
      await expect(f.coordinator.run(receipt.jobId)).rejects.toThrow();
      expect((await f.coordinator.run(receipt.jobId)).status).toBe(
        'inspection_failed',
      );
      expect(f.docs.documents.get('slots/global')?.leaseIds).toHaveLength(0);
      expect(f.provider.create).toHaveBeenCalledTimes(
        kind === 'process' ? 1 : 0,
      );
      expect(
        f.docs.documents.get('budgets/e2b_global_micro_usd')?.reserved,
      ).toBe(kind === 'process' ? 60 : 0);
      expect(f.docs.documents.get('budgets/class_b')?.spent).toBe(1);
    },
  );
  it.each(['gate', 'source', 'digest'])(
    'rejects altered %s evidence during recovery before advancing the stage checkpoint',
    async (kind) => {
      const f = await setup();
      f.provider.kill.mockRejectedValueOnce(new Error('unknown kill'));
      const { receipt } = await f.enqueue();
      await f.coordinator.run(receipt.jobId);
      const job = InspectionStageJob.parse(
        f.docs.documents.get(`stageJobs/${receipt.jobId}`),
      );
      await f.client.kill(job.operationId, f.session.sandboxId);
      if (kind === 'gate') {
        const inspection = f.docs.documents.get(
          `${f.path}/inspection/current`,
        )!;
        inspection.gate = { ...(inspection.gate as object), status: 'ready' };
      }
      if (kind === 'source') {
        const source = f.docs.documents.get(
          `${f.path}/inspectionSources/${f.entry.artifactId}`,
        )!;
        source.inspection = {
          ...(source.inspection as object),
          truncated: true,
        };
      }
      if (kind === 'digest')
        f.docs.documents.get(`${f.path}/inspection/current`)!.resultDigest =
          'f'.repeat(64);
      await expect(f.coordinator.recover(receipt.jobId)).rejects.toThrow();
      expect(f.docs.documents.get(`stageJobs/${receipt.jobId}`)?.status).toBe(
        'dispatching',
      );
      expect(f.provider.create).toHaveBeenCalledOnce();
    },
  );
});
