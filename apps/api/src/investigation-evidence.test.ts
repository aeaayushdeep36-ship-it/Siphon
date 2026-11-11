import { spawnSync } from 'node:child_process';
import { delimiter, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ConservationJobRequest,
  validateConservationJobResult,
} from '@siphon/contracts';
import { sciencePython } from '../../../scripts/science-python.js';
import { TestDocuments } from '../test/document-store.js';
import { groqFixtureConfig } from '../test/groq-stage-fixture.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { canonicalJson, sha256 } from './hashing.js';
import { prepareOwnedInvestigation } from './investigation-evidence.js';
import { GroqModelJobs } from './groq-model-jobs.js';
import { ScientificInvestigationStage } from './scientific-investigation-stage.js';
import {
  InvestigationReviews,
  readInvestigationReview,
} from './investigation-review.js';
import { WorkspaceRepository } from './workspace.js';
import { firestoreTransport } from '../test/firestore-transport.js';
import {
  InvestigationTasks,
  requireInvestigationTask,
} from './investigation-tasks.js';

async function fixture() {
  const child = spawnSync(
    sciencePython,
    [
      '-c',
      [
        'import json',
        'from test_scientific_checks import heat_case',
        'from siphon_science.experiments import evaluate_conservation_job',
        'request, payloads = heat_case(faulty=False)',
        'print(json.dumps({"request": request, "evidence": evaluate_conservation_job(request, payloads)}))',
      ].join('\n'),
    ],
    {
      cwd: resolve('packages/science'),
      env: {
        ...process.env,
        PYTHONPATH: [
          resolve('packages/science'),
          resolve('packages/science/tests'),
        ].join(delimiter),
      },
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  if (child.error || child.status !== 0)
    throw new Error('Authored fixture failed');
  const raw = JSON.parse(child.stdout) as {
    request: unknown;
    evidence: unknown;
  };
  const request = ConservationJobRequest.parse(raw.request);
  const report = validateConservationJobResult(raw.evidence, request);
  const diagnostic = request.diagnostic;
  const fence = {
    auditId: diagnostic.auditId,
    revisionId: diagnostic.revisionId,
    inputDigest: diagnostic.validation.inputDigest,
    generation: 2,
  };
  const operationId = diagnostic.operationId;
  const base = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
  const docs = new TestDocuments();
  docs.documents.set('testers/alice', { active: true });
  const { audit } = await new FirestoreAuditRepository(docs).create(
    'alice',
    { schemaVersion: '1.0', title: 'Fixture', domain: 'heat_diffusion' },
    'fixture',
  );
  const auditRecord = docs.documents.get(`audits/${audit.id}`)!;
  const revision = docs.documents.get(
    `audits/${audit.id}/revisions/${audit.currentRevisionId}`,
  )!;
  docs.documents.set(`audits/${fence.auditId}`, {
    ...auditRecord,
    id: fence.auditId,
    currentRevisionId: fence.revisionId,
  });
  docs.documents.set(base, {
    ...revision,
    auditId: fence.auditId,
    revisionId: fence.revisionId,
    inputDigest: fence.inputDigest,
    generation: 2,
    stage: 'investigating',
    status: 'running',
  });
  const common = {
    ownerUid: 'alice',
    auditId: fence.auditId,
    revisionId: fence.revisionId,
    inputDigest: fence.inputDigest,
  };
  const requestDigest = await sha256(canonicalJson(request));
  const reportDigest = await sha256(canonicalJson(report));
  const sandboxDigest = 'f'.repeat(64);
  const now = '2026-11-10T18:00:00.000Z';
  docs.documents.set(`operations/${operationId}`, {
    schemaVersion: '1.0',
    id: operationId,
    ...common,
    requestDigest: sandboxDigest,
    fence: 1,
    outcome: 'succeeded',
    charges: [
      {
        counterKey: 'fixture',
        amount: 1,
        unit: 'seconds',
        consumeOnDispatch: false,
      },
    ],
    usage: { fixture: 1 },
    providerHandle: 'sandbox',
    createdAt: now,
    updatedAt: now,
  });
  docs.documents.set(`sandboxTerminations/${operationId}`, {
    schemaVersion: '1.0',
    operationId,
    sandboxId: 'sandbox',
    ...common,
    requestDigest: sandboxDigest,
    outcome: 'killed',
    observedAt: now,
  });
  docs.documents.set(`scientificEvaluationStages/${fence.revisionId}`, {
    ...common,
    generation: 1,
    request,
    requestDigest,
  });
  docs.documents.set(`conservationExecutions/${operationId}`, {
    ...common,
    operationId,
    status: 'published',
    payloadDigest: requestDigest,
    request,
    sandboxId: 'sandbox',
  });
  docs.documents.set(`${base}/evidence/${operationId}`, {
    ...common,
    operationId,
    report,
    reportDigest,
    expiresAt: '2026-11-11T18:00:00.000Z',
  });
  const run = () =>
    prepareOwnedInvestigation(
      docs,
      'alice',
      fence,
      operationId,
      groqFixtureConfig,
      () => new Date(now),
    );
  return { docs, fence, operationId, base, run };
}

describe('owned investigation evidence preparation', () => {
  async function staged(useRest = false) {
    const f = await fixture();
    const prepared = await f.run();
    const { evidenceIds, ...identity } = prepared.expected;
    const draft = {
      schemaVersion: '1.0',
      ...identity,
      hypotheses: [
        {
          text: 'The drift may depend on resolution.',
          evidenceIds,
          verification: 'Compare independently refined runs.',
        },
      ],
      recommendations: [
        {
          text: 'Review sampled conservation.',
          evidenceIds,
          validation: 'Compare the same physical interval.',
        },
      ],
    };
    const transport = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: 'fixture-response',
        object: 'chat.completion',
        model: groqFixtureConfig.model,
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: JSON.stringify(draft) },
          },
        ],
        usage: {
          prompt_tokens: 500,
          completion_tokens: 100,
          total_tokens: 600,
        },
      }),
    );
    const clock = () => new Date('2026-11-10T18:00:00.000Z');
    f.docs.documents.get(f.base)!.stage = 'evaluating';
    const rest = useRest ? firestoreTransport(f.docs) : null;
    const store = rest?.client ?? f.docs;
    const stage = new ScientificInvestigationStage(
      store,
      groqFixtureConfig,
      new GroqModelJobs(
        store,
        groqFixtureConfig.apiKey,
        groqFixtureConfig,
        transport,
        clock,
      ),
      clock,
    );
    const result = await stage.run('alice', f.fence, f.operationId);
    const stageRequests = rest?.calls.length ?? null;
    if (result.status !== 'awaiting_review')
      throw new Error('Expected authored draft');
    const read = () =>
      store.transaction((tx) =>
        readInvestigationReview(tx, 'alice', result.fence, clock),
      );
    const snapshot = (await read())!;
    const review = (decision: 'accept' | 'omit', key = 'review') =>
      new InvestigationReviews(store, clock).submit(
        'alice',
        f.fence.auditId,
        f.fence.revisionId,
        {
          schemaVersion: '1.0',
          expectedGeneration: result.fence.generation,
          expectedInputDigest: f.fence.inputDigest,
          draftDigest: snapshot.draftDigest,
          decision,
        },
        key,
      );
    return {
      ...f,
      draft,
      transport,
      clock,
      stage,
      result,
      snapshot,
      read,
      review,
      rest,
      store,
      stageRequests,
    };
  }
  it('measures the real Firestore REST path without claiming hosted Free feasibility', async () => {
    const f = await staged(true);
    expect(f.stageRequests).toBeGreaterThan(0);
    const before = f.rest!.calls.length;
    await f.review('accept');
    const reviewRequests = f.rest!.calls.length - before;
    if (process.env.SIPHON_TRACE_REST === '1')
      console.log('Investigation REST requests', {
        draft: f.stageRequests,
        review: reviewRequests,
      });
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.rest!.batches.every((paths) => paths.length <= 40)).toBe(true);
  });
  it.each(['accept', 'omit'] as const)(
    'runs one accounted investigation and preserves an immutable %s review',
    async (decision) => {
      const f = await staged();
      expect(f.result.fence.generation).toBe(3);
      expect(f.docs.documents.get(f.base)).toMatchObject({
        stage: 'investigating',
        slotLeaseId: null,
      });
      expect(await f.stage.run('alice', f.fence, f.operationId)).toMatchObject({
        status: 'awaiting_review',
      });
      expect(f.transport).toHaveBeenCalledOnce();
      const workspace = await new WorkspaceRepository(f.docs, f.clock).get(
        'alice',
        f.fence.auditId,
        f.fence.revisionId,
      );
      expect(workspace.investigation).toMatchObject({
        draft: f.draft,
        status: 'awaiting_review',
      });
      const saved = await f.review(decision);
      expect(saved.status).toBe(decision === 'accept' ? 'accepted' : 'omitted');
      expect(await f.review(decision)).toMatchObject({
        ...saved,
        replayed: true,
      });
      await expect(
        f.review(decision === 'accept' ? 'omit' : 'accept', 'other'),
      ).rejects.toThrow('immutable');
      expect(
        await f.stage.run('alice', f.result.fence, f.operationId),
      ).toMatchObject({ status: 'reviewed' });
      expect(f.transport).toHaveBeenCalledOnce();
      expect(
        f.docs.documents.get(`${f.base}/evidence/${f.operationId}`)
          ?.reportDigest,
      ).toBe(f.snapshot.draft.evidenceDigest);
    },
  );
  it.each(['draft', 'receipt', 'usage', 'evidence', 'owner', 'expiry'])(
    'denies a changed %s before advisory review',
    async (change) => {
      const f = await staged();
      const operationId = f.result.operationId!;
      if (change === 'draft')
        f.docs.documents.get(
          `${f.base}/investigationDrafts/${operationId}`,
        )!.draftDigest = '0'.repeat(64);
      if (change === 'receipt')
        f.docs.documents.get(`modelReceipts/${operationId}`)!.model =
          'other-model';
      if (change === 'usage')
        f.docs.documents.get(`operations/${operationId}`)!.usage = {};
      if (change === 'evidence')
        f.docs.documents.get(
          `${f.base}/evidence/${f.operationId}`,
        )!.reportDigest = '0'.repeat(64);
      if (change === 'owner')
        f.docs.documents.get(`audits/${f.fence.auditId}`)!.ownerUid = 'bob';
      if (change === 'expiry')
        f.docs.documents.get(
          `${f.base}/investigationDrafts/${operationId}`,
        )!.expiresAt = f.clock().toISOString();
      await expect(f.review('accept')).rejects.toThrow();
      if (change === 'expiry') {
        const workspace = await new WorkspaceRepository(f.docs, f.clock).get(
          'alice',
          f.fence.auditId,
          f.fence.revisionId,
        );
        expect(workspace.investigation?.status).toBe('expired');
      }
      expect(
        f.docs.documents.has(`${f.base}/investigationReviews/current`),
      ).toBe(false);
      expect(f.transport).toHaveBeenCalledOnce();
    },
  );
  it('does not redispatch after settled output is lost', async () => {
    const f = await staged();
    f.docs.documents.delete(
      `${f.base}/investigationDrafts/${f.result.operationId}`,
    );
    expect(
      await f.stage.run('alice', f.result.fence, f.operationId),
    ).toMatchObject({
      status: 'blocked',
      code: 'investigation_requires_reconciliation',
    });
    expect(f.transport).toHaveBeenCalledOnce();
  });
  it('dispatches a fixture investigation through quotas and stores only a reviewed-pending draft', async () => {
    const f = await fixture();
    const prepared = await f.run();
    const operationId = crypto.randomUUID();
    const { evidenceIds: _ids, ...identity } = prepared.expected;
    expect(_ids.length).toBeGreaterThan(0);
    const draft = {
      schemaVersion: '1.0',
      ...identity,
      hypotheses: [],
      recommendations: [],
    };
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      expect(String(init?.body)).not.toContain('dataBase64');
      return Response.json({
        id: 'fixture-response',
        object: 'chat.completion',
        model: groqFixtureConfig.model,
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: JSON.stringify(draft) },
          },
        ],
        usage: {
          prompt_tokens: 500,
          completion_tokens: 100,
          total_tokens: 600,
        },
      });
    });
    const runner = new GroqModelJobs(
      f.docs,
      groqFixtureConfig.apiKey,
      groqFixtureConfig,
      transport,
      () => new Date('2026-11-10T18:00:00.000Z'),
    );
    await expect(
      runner.run('alice', f.fence, operationId, prepared, 'investigation'),
    ).resolves.toMatchObject({ providerId: 'fixture-response' });
    expect(transport).toHaveBeenCalledOnce();
    expect(f.docs.documents.get(`operations/${operationId}`)).toMatchObject({
      outcome: 'succeeded',
    });
    expect(
      f.docs.documents.get(`${f.base}/investigationDrafts/${operationId}`),
    ).toMatchObject({ status: 'awaiting_review', draft });
    await expect(
      runner.run('alice', f.fence, operationId, prepared, 'investigation'),
    ).rejects.toMatchObject({ code: 'ai_operation_requires_reconciliation' });
    expect(transport).toHaveBeenCalledOnce();
  });
  it('settles the provider usage but discards a response when evidence changes during dispatch', async () => {
    const f = await fixture();
    const prepared = await f.run();
    const operationId = crypto.randomUUID();
    const { evidenceIds, ...identity } = prepared.expected;
    expect(evidenceIds.length).toBeGreaterThan(0);
    const transport = vi.fn<typeof fetch>(async () => {
      f.docs.documents.get(
        `${f.base}/evidence/${f.operationId}`,
      )!.reportDigest = '0'.repeat(64);
      return Response.json({
        id: 'fixture-response',
        object: 'chat.completion',
        model: groqFixtureConfig.model,
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                schemaVersion: '1.0',
                ...identity,
                hypotheses: [],
                recommendations: [],
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: 500,
          completion_tokens: 100,
          total_tokens: 600,
        },
      });
    });
    const runner = new GroqModelJobs(
      f.docs,
      groqFixtureConfig.apiKey,
      groqFixtureConfig,
      transport,
      () => new Date('2026-11-10T18:00:00.000Z'),
    );
    await expect(
      runner.run('alice', f.fence, operationId, prepared, 'investigation'),
    ).rejects.toThrow('provenance');
    expect(f.docs.documents.get(`operations/${operationId}`)).toMatchObject({
      outcome: 'succeeded',
    });
    expect(f.docs.documents.get(`modelReceipts/${operationId}`)).toMatchObject({
      outcome: 'succeeded',
    });
    expect(
      f.docs.documents.has(`${f.base}/investigationDrafts/${operationId}`),
    ).toBe(false);
    expect(transport).toHaveBeenCalledOnce();
  });
  it('releases an undispatched investigation reservation when evidence becomes stale before binding', async () => {
    const f = await fixture();
    const prepared = await f.run();
    const operationId = crypto.randomUUID();
    f.docs.documents.get(`${f.base}/evidence/${f.operationId}`)!.reportDigest =
      '0'.repeat(64);
    const transport = vi.fn<typeof fetch>();
    const runner = new GroqModelJobs(
      f.docs,
      groqFixtureConfig.apiKey,
      groqFixtureConfig,
      transport,
      () => new Date('2026-11-10T18:00:00.000Z'),
    );
    await expect(
      runner.run('alice', f.fence, operationId, prepared, 'investigation'),
    ).rejects.toThrow('provenance');
    expect(transport).not.toHaveBeenCalled();
    expect(f.docs.documents.get(`operations/${operationId}`)).toMatchObject({
      outcome: 'failed',
      providerHandle: null,
    });
    expect(
      f.docs.documents.get('budgets/groq_requests_day_20261110'),
    ).toMatchObject({ reserved: 0, spent: 0 });
    expect(
      f.docs.documents.get('budgets/groq_tokens_day_20261110'),
    ).toMatchObject({ reserved: 0, spent: 0 });
  });
  it('prepares data-only input from published, terminated evidence', async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result.expected.auditId).toBe(f.fence.auditId);
    expect(result.evaluationId).toBe(f.operationId);
    expect(result.expected.evidenceIds.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.request)).not.toContain('dataBase64');
  });
  it.each(['owner', 'expiry', 'termination', 'digest', 'generation', 'stage'])(
    'refuses %s changes before any provider call',
    async (kind) => {
      const f = await fixture();
      const evidence = f.docs.documents.get(
        `${f.base}/evidence/${f.operationId}`,
      )!;
      if (kind === 'owner') evidence.ownerUid = 'other';
      if (kind === 'expiry') evidence.expiresAt = '2026-11-10T18:00:00.000Z';
      if (kind === 'termination')
        f.docs.documents.get(
          `sandboxTerminations/${f.operationId}`,
        )!.sandboxId = 'other';
      if (kind === 'digest') evidence.reportDigest = '0'.repeat(64);
      if (kind === 'generation') f.docs.documents.get(f.base)!.generation = 3;
      if (kind === 'stage') f.docs.documents.get(f.base)!.stage = 'reporting';
      await expect(f.run()).rejects.toThrow();
    },
  );
  it('binds a reserved operation and rechecks evidence and provider settings atomically', async () => {
    const f = await fixture();
    const prepared = await f.run();
    const operationId = crypto.randomUUID();
    const now = '2026-11-10T18:00:00.000Z';
    const clock = () => new Date(now);
    f.docs.documents.set(`operations/${operationId}`, {
      schemaVersion: '1.0',
      id: operationId,
      ownerUid: 'alice',
      auditId: f.fence.auditId,
      revisionId: f.fence.revisionId,
      inputDigest: f.fence.inputDigest,
      fence: f.fence.generation,
      requestDigest: prepared.requestDigest,
      outcome: 'reserved',
      usage: null,
      providerHandle: null,
      charges: [
        {
          counterKey: 'fixture',
          amount: 1,
          unit: 'attempts',
          consumeOnDispatch: true,
        },
      ],
      createdAt: now,
      updatedAt: now,
    });
    const tasks = new InvestigationTasks(f.docs, groqFixtureConfig, clock);
    await tasks.bind('alice', f.fence, operationId, f.operationId);
    await tasks.bind('alice', f.fence, operationId, f.operationId);
    const task = f.docs.documents.get(`investigationTasks/${operationId}`)!;
    expect(task.evidenceDigest).toBe(prepared.expected.evidenceDigest);
    expect(JSON.stringify(task)).not.toContain(groqFixtureConfig.apiKey);
    const verify = (config = groqFixtureConfig) =>
      f.docs.transaction((tx) =>
        requireInvestigationTask(
          tx,
          'alice',
          f.fence,
          operationId,
          config,
          ['reserved'],
          clock,
        ),
      );
    await expect(verify()).resolves.toMatchObject({ task: { operationId } });
    await expect(
      verify({ ...groqFixtureConfig, model: 'other/model' }),
    ).rejects.toThrow();
    f.docs.documents.get(`${f.base}/evidence/${f.operationId}`)!.reportDigest =
      '0'.repeat(64);
    await expect(verify()).rejects.toThrow('provenance');
  });
  it('stores only a settled, snapshot-bound draft for review and never changes evidence', async () => {
    const f = await fixture();
    const prepared = await f.run();
    const operationId = crypto.randomUUID();
    const now = '2026-11-10T18:00:00.000Z';
    const clock = () => new Date(now);
    f.docs.documents.set(`operations/${operationId}`, {
      schemaVersion: '1.0',
      id: operationId,
      ownerUid: 'alice',
      ...f.fence,
      fence: f.fence.generation,
      requestDigest: prepared.requestDigest,
      outcome: 'reserved',
      usage: null,
      providerHandle: null,
      charges: [
        {
          counterKey: 'fixture',
          amount: 1,
          unit: 'attempts',
          consumeOnDispatch: true,
        },
      ],
      createdAt: now,
      updatedAt: now,
    });
    // Operation uses fence rather than a generation field.
    delete f.docs.documents.get(`operations/${operationId}`)!.generation;
    const tasks = new InvestigationTasks(f.docs, groqFixtureConfig, clock);
    await tasks.bind('alice', f.fence, operationId, f.operationId);
    const task = f.docs.documents.get(`investigationTasks/${operationId}`)!;
    const { evidenceIds, ...identity } = prepared.expected;
    const draft = {
      schemaVersion: '1.0',
      ...identity,
      hypotheses: [],
      recommendations: [
        {
          text: 'Review the sampled drift.',
          evidenceIds,
          validation: 'Compare independently recorded samples.',
        },
      ],
    };
    await expect(
      tasks.storeDraft('alice', f.fence, operationId, draft),
    ).rejects.toThrow();
    const operation = f.docs.documents.get(`operations/${operationId}`)!;
    operation.outcome = 'succeeded';
    operation.usage = { fixture: 1 };
    const job = {
      schemaVersion: '1.0',
      operationId,
      requestDigest: prepared.requestDigest,
      provider: 'groq',
      model: groqFixtureConfig.model,
      endpoint: groqFixtureConfig.endpoint,
      configDigest: task.configDigest,
      purpose: 'investigation',
      inputTokenBound: 100,
      outputTokenBound: 50,
      admission: 'request_bytes_screen_not_token_measurement.v1',
      createdAt: now,
    };
    f.docs.documents.set(`modelJobs/${operationId}`, job);
    f.docs.documents.set(`modelReceipts/${operationId}`, {
      schemaVersion: '1.0',
      operationId,
      requestDigest: prepared.requestDigest,
      configDigest: task.configDigest,
      provider: 'groq',
      model: groqFixtureConfig.model,
      endpoint: groqFixtureConfig.endpoint,
      providerId: 'fixture',
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      outcome: 'succeeded',
      failureCode: null,
      receivedAt: now,
    });
    f.docs.documents.get(`modelReceipts/${operationId}`)!.usage = {
      prompt_tokens: 101,
      completion_tokens: 2,
      total_tokens: 103,
    };
    await expect(
      tasks.storeDraft('alice', f.fence, operationId, draft),
    ).rejects.toThrow('not settled');
    f.docs.documents.get(`modelReceipts/${operationId}`)!.usage = {
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    };
    expect(
      await tasks.storeDraft('alice', f.fence, operationId, draft),
    ).toMatchObject({ replayed: false });
    expect(
      await tasks.storeDraft('alice', f.fence, operationId, draft),
    ).toMatchObject({ replayed: true });
    expect(
      f.docs.documents.get(`${f.base}/investigationDrafts/${operationId}`),
    ).toMatchObject({ status: 'awaiting_review' });
    expect(
      f.docs.documents.get(`${f.base}/evidence/${f.operationId}`)?.reportDigest,
    ).toBe(prepared.expected.evidenceDigest);
    await expect(
      tasks.storeDraft('alice', f.fence, operationId, {
        ...draft,
        recommendations: [
          { ...draft.recommendations[0], evidenceIds: [crypto.randomUUID()] },
        ],
      }),
    ).rejects.toThrow();
  });
});
