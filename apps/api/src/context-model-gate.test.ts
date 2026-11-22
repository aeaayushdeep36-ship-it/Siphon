import { describe, expect, it } from 'vitest';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { ContextTasks } from './context-tasks.js';
import { ContextModelGate } from './context-model-gate.js';
import { ModelJobs } from './model-jobs.js';
import { AdmissionRepository } from './admission.js';
import { FirestoreAccountingStore } from './firestore-accounting.js';
import { reserveOperation, Operation } from './accounting.js';
import { sha256, canonicalJson } from './hashing.js';
import { reserveMetaCost } from './meta-pricing.js';
import { MetaClient, MetaRequest } from './meta-client.js';
import { ContextProposal } from '@siphon/contracts';
import { ContextPipeline } from './context-pipeline.js';
import { AuditCommands } from './audit-commands.js';
import { ContextClarification } from './context-clarification.js';
import { RevisionRepository } from './revisions.js';
import { metaResponse } from '../test/meta-response.js';
import { ContextBillingBounds } from './context-billing-bound.js';

async function setup(count = 1) {
  const docs = new TestDocuments();
  docs.documents.set('testers/alice', { active: true });
  const { audit } = await new FirestoreAuditRepository(docs).create(
    'alice',
    {
      schemaVersion: '1.0',
      title: 'Gated context',
      domain: 'heat_diffusion',
    },
    'create',
  );
  const now = new Date('2026-10-29T00:00:00.000Z');
  const expiresAt = '2026-10-30T00:00:00.000Z';
  const sources = [];
  const manifest = [];
  for (let i = 0; i < count; i++) {
    const artifactId = crypto.randomUUID(),
      reviewId = crypto.randomUUID();
    const text = '# No executable content\n';
    const sourceDigest = await sha256(text);
    sources.push({ artifactId, reviewId, sourceDigest, text });
    manifest.push({
      schemaVersion: '1.0',
      artifactId,
      path: `authored${i}.py`,
      bytes: text.length,
      sha256: sourceDigest,
    });
    docs.documents.set(`audits/${audit.id}/artifacts/${artifactId}`, {
      artifactId,
      auditId: audit.id,
      ownerUid: 'alice',
      lifecycle: 'ready',
      sha256: sourceDigest,
      expiresAt,
    });
    docs.documents.set(`sourceContextReviews/${reviewId}`, {
      schemaVersion: '1.0',
      id: reviewId,
      ownerUid: 'alice',
      auditId: audit.id,
      artifactId,
      sourceDigest,
      purpose: 'meta_context',
      approved: true,
      verifiedAt: now.toISOString(),
      expiresAt,
    });
  }
  const revision = docs.documents.get(
    `audits/${audit.id}/revisions/${audit.currentRevisionId}`,
  )!;
  const inputDigest = await sha256(
    canonicalJson({ uploads: manifest, answers: [] }),
  );
  Object.assign(revision, {
    stage: 'inspecting',
    status: 'running',
    sourceManifest: manifest,
    inputDigest,
  });
  const fence = {
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    generation: 0,
    inputDigest,
  };
  const tasks = new ContextTasks(docs, () => now);
  const rawPrepared = await tasks.prepare('alice', fence, sources);
  const prepared = {
    ...rawPrepared,
    request: MetaRequest.parse(rawPrepared.request),
  };
  const price = {
    schemaVersion: '1.0',
    version: 'fixture',
    model: 'muse-wonder-1.0',
    mode: 'standard',
    verifiedAt: now.toISOString(),
    effectiveFrom: now.toISOString(),
    effectiveUntil: expiresAt,
    inputMicroUsdPerMillion: 4000000,
    cachedInputMicroUsdPerMillion: 200000,
    outputMicroUsdPerMillion: 20000000,
  };
  docs.documents.set('configuration/meta_pricing', price);
  const tokenId = crypto.randomUUID();
  const counting = {
    schemaVersion: '1.0',
    model: 'muse-wonder-1.0',
    protocol: 'responses.v1',
    profile: 'stateless_text_json_no_tools.v1',
    countingCharge: 'no_charge',
    evidenceDigest: 'a'.repeat(64),
    verifiedAt: now.toISOString(),
    expiresAt,
  };
  const countingDigest = await sha256(canonicalJson(counting));
  docs.documents.set('configuration/meta_counting', counting);
  docs.documents.set('configuration/meta_billing_profile', {
    schemaVersion: '1.0',
    model: 'muse-wonder-1.0',
    protocol: 'responses.v1',
    profile: 'stateless_text_json_no_tools.v1',
    countingVerificationDigest: countingDigest,
    inputTokenMultiplier: 1,
    additionalInputTokens: 0,
    maximumIterations: 1,
    outputIncludesReasoning: true,
    tokenizerVersion: 'authored-fixture-not-a-real-tokenizer',
    evidenceDigest: 'a'.repeat(64),
    verifiedAt: now.toISOString(),
    expiresAt,
  });
  const countId = crypto.randomUUID();
  docs.documents.set(`modelTokenCountJobs/${countId}`, {
    id: countId,
    status: 'measured',
    requestDigest: prepared.requestDigest,
    result: {
      schemaVersion: '1.0',
      id: countId,
      ownerUid: 'alice',
      ...fence,
      requestDigest: prepared.requestDigest,
      model: 'muse-wonder-1.0',
      protocol: 'responses.v1',
      measurement: 'rendered_context',
      verificationDigest: countingDigest,
      inputTokens: 10000,
      inputTokenLimit: 24000,
      withinInputPolicy: true,
      measuredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60000).toISOString(),
    },
  });
  await new ContextBillingBounds(docs, () => now).produce(
    'alice',
    fence,
    countId,
    tokenId,
    prepared.requestDigest,
  );
  docs.documents.set('configuration/meta_credits', {
    schemaVersion: '1.0',
    evidenceId: crypto.randomUUID(),
    allocationMicroUsd: 150000000,
    availableMicroUsd: 150000000,
    accountedSpentMicroUsd: 0,
    verifiedAt: now.toISOString(),
    expiresAt,
  });
  const amount = reserveMetaCost(price, 10000, 4000, now).microUsd;
  const charges = [
    {
      counterKey: 'meta_global_micro_usd',
      amount,
      unit: 'micro_usd',
      consumeOnDispatch: false,
    },
    {
      counterKey: `meta_revision_${fence.revisionId}`,
      amount,
      unit: 'micro_usd',
      consumeOnDispatch: false,
    },
    {
      counterKey: `model_attempts_${fence.revisionId}`,
      amount: 1,
      unit: 'attempts',
      consumeOnDispatch: true,
    },
  ];
  for (const [index, charge] of charges.entries())
    docs.documents.set(`budgets/${charge.counterKey}`, {
      schemaVersion: '1.0',
      limit: [135000000, 2000000, 8][index],
      reserved: 0,
      spent: 0,
      halted: false,
    });
  const operation = Operation.parse({
    schemaVersion: '1.0',
    id: crypto.randomUUID(),
    auditId: audit.id,
    revisionId: fence.revisionId,
    ownerUid: 'alice',
    inputDigest,
    requestDigest: prepared.requestDigest,
    fence: 0,
    outcome: 'reserved',
    usage: null,
    providerHandle: null,
    charges,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  await reserveOperation(new FirestoreAccountingStore(docs), operation);
  await tasks.bind('alice', fence, operation.id, sources);
  await new ModelJobs(docs, () => now).bind(operation.id, 10000, 4000, tokenId);
  await new AdmissionRepository(docs, () => now).acquire('alice', fence);
  const gate = new ContextModelGate(docs, operation.id, () => now);
  return { docs, operation, prepared, gate, sources, tokenId, fence, now };
}
describe('transactional context model dispatch', () => {
  it('runs the context stage through real dispatch, settlement and immutable publication with an offline response', async () => {
    const f = await setup();
    const proposal = {
      schemaVersion: '1.0',
      auditId: f.fence.auditId,
      revisionId: f.fence.revisionId,
      inputDigest: f.fence.inputDigest,
      domain: 'heat_diffusion',
      summary: 'No physical equations are present.',
      domainMismatchSuspected: true,
      candidates: [],
    };
    let calls = 0;
    const pipeline = new ContextPipeline(
      f.docs,
      'fixture',
      async () => {
        calls++;
        return new Response(
          JSON.stringify(
            metaResponse(JSON.stringify(proposal), {
              prompt_tokens: 100,
              completion_tokens: 50,
              total_tokens: 150,
            }),
          ),
        );
      },
      () => f.now,
    );
    await pipeline.run(f.operation.id, f.prepared.request);
    const path = `audits/${f.fence.auditId}/revisions/${f.fence.revisionId}/context/current`;
    expect(f.docs.documents.get(path)?.proposal).toEqual(proposal);
    expect(f.docs.documents.get(`operations/${f.operation.id}`)?.outcome).toBe(
      'succeeded',
    );
    expect(f.docs.documents.get('budgets/meta_global_micro_usd')).toMatchObject(
      { spent: 1400, reserved: 0 },
    );
    const leaseId = String(
      f.docs.documents.get(
        `audits/${f.fence.auditId}/revisions/${f.fence.revisionId}`,
      )!.slotLeaseId,
    );
    expect(
      f.docs.documents.get(`slotLeases/${leaseId}`)?.pendingOperations,
    ).toBe(0);
    await expect(
      pipeline.run(f.operation.id, f.prepared.request),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    const clarifications = new ContextClarification(f.docs, () => f.now);
    const published = await clarifications.publish(f.operation.id);
    expect(published.receipt.status).toBe('waiting_for_input');
    expect((await clarifications.publish(f.operation.id)).replayed).toBe(true);
    expect(f.docs.documents.get('slots/global')?.leaseIds).toEqual([]);
    const questions = await new RevisionRepository(f.docs).getQuestions(
      'alice',
      f.fence.auditId,
      f.fence.revisionId,
    );
    expect(questions.questionSet.questions).toHaveLength(7);
  });
  it.each(['unknown', 'malformed', 'cancelled'])(
    'preserves usage and blocks publication for %s model completion',
    async (kind) => {
      const f = await setup();
      const pipeline = new ContextPipeline(
        f.docs,
        'fixture',
        async () => {
          if (kind === 'unknown') throw new Error('network timeout');
          if (kind === 'cancelled')
            await new AuditCommands(f.docs).cancel(
              'alice',
              f.fence.auditId,
              f.fence.revisionId,
              'cancel',
            );
          const proposal = {
            schemaVersion: '1.0',
            auditId: f.fence.auditId,
            revisionId: f.fence.revisionId,
            inputDigest: f.fence.inputDigest,
            domain: 'heat_diffusion',
            summary: 'No equations.',
            domainMismatchSuspected: true,
            candidates: [],
          };
          return new Response(
            JSON.stringify(
              metaResponse(
                kind === 'malformed'
                  ? 'invalid-json'
                  : JSON.stringify(proposal),
                {
                  prompt_tokens: 100,
                  completion_tokens: 50,
                  total_tokens: 150,
                },
              ),
            ),
          );
        },
        () => f.now,
      );
      await expect(
        pipeline.run(f.operation.id, f.prepared.request),
      ).rejects.toThrow();
      expect(
        f.docs.documents.has(
          `audits/${f.fence.auditId}/revisions/${f.fence.revisionId}/context/current`,
        ),
      ).toBe(false);
      expect(
        f.docs.documents.get(`operations/${f.operation.id}`)?.outcome,
      ).toBe(
        kind === 'unknown'
          ? 'unknown'
          : kind === 'malformed'
            ? 'failed'
            : 'succeeded',
      );
      expect(f.docs.documents.get('budgets/meta_global_micro_usd')?.spent).toBe(
        kind === 'unknown' ? 0 : 1400,
      );
      expect(
        f.docs.documents.get(`budgets/model_attempts_${f.fence.revisionId}`)
          ?.spent,
      ).toBe(1);
    },
  );
  it('admits one request only and consumes the attempt atomically', async () => {
    const f = await setup();
    expect(
      await f.gate.authorize(f.prepared.request, f.prepared.requestDigest),
    ).toEqual({ inputTokenBound: 10000 });
    expect(f.docs.documents.get(`operations/${f.operation.id}`)?.outcome).toBe(
      'dispatching',
    );
    expect(
      f.docs.documents.get(`budgets/model_attempts_${f.fence.revisionId}`)
        ?.spent,
    ).toBe(1);
    await expect(
      f.gate.authorize(f.prepared.request, f.prepared.requestDigest),
    ).rejects.toThrow();
  });
  it.each(['tokens', 'privacy', 'credit', 'price', 'output', 'cancelled'])(
    'rejects changed %s evidence without consuming admission',
    async (kind) => {
      const f = await setup();
      if (kind === 'tokens')
        f.docs.documents.get(`modelTokenEvidence/${f.tokenId}`)!.requestDigest =
          'c'.repeat(64);
      if (kind === 'privacy')
        f.docs.documents.get(
          `sourceContextReviews/${f.sources[0]!.reviewId}`,
        )!.approved = false;
      if (kind === 'credit')
        f.docs.documents.get('configuration/meta_credits')!.availableMicroUsd =
          15000001;
      if (kind === 'price')
        f.docs.documents.get(
          'configuration/meta_pricing',
        )!.outputMicroUsdPerMillion = 21000000;
      if (kind === 'output') f.prepared.request.max_output_tokens = 3999;
      if (kind === 'cancelled')
        Object.assign(
          f.docs.documents.get(
            `audits/${f.fence.auditId}/revisions/${f.fence.revisionId}`,
          )!,
          {
            stage: 'finished',
            status: 'cancelled',
            cancellationRequestedAt: new Date().toISOString(),
          },
        );
      const before = structuredClone(f.docs.documents);
      await expect(
        f.gate.authorize(f.prepared.request, f.prepared.requestDigest),
      ).rejects.toThrow();
      expect(f.docs.documents).toEqual(before);
    },
  );
  it('checks ten source reviews within the bounded transaction read budget', async () => {
    const f = await setup(10);
    let maximum = 0;
    const real = f.docs.transaction.bind(f.docs);
    f.docs.transaction = (callback) =>
      real(async (tx) => {
        let reads = 0;
        return callback({
          ...tx,
          get: async (path) => {
            maximum = Math.max(maximum, ++reads);
            if (reads > 40) throw new Error('Read limit');
            return tx.get(path);
          },
        });
      });
    await f.gate.authorize(f.prepared.request, f.prepared.requestDigest);
    expect(maximum).toBeLessThanOrEqual(40);
  });
  it('stops the real Meta transport before network I/O when disclosure review is revoked', async () => {
    const f = await setup();
    f.docs.documents.get(
      `sourceContextReviews/${f.sources[0]!.reviewId}`,
    )!.approved = false;
    let contacted = false;
    const client = new MetaClient('fixture-key', f.gate, async () => {
      contacted = true;
      throw new Error('unexpected');
    });
    await expect(
      client.complete(
        f.prepared.request,
        ContextProposal,
        AbortSignal.timeout(10000),
      ),
    ).rejects.toThrow();
    expect(contacted).toBe(false);
  });
});
