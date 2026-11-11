import { vi } from 'vitest';
import { AdapterCoordinator } from '../src/adapter-coordinator.js';
import { ContextTask } from '../src/context-tasks.js';
import { FirestoreAuditRepository } from '../src/audit-repository.js';
import { TestDocuments } from './document-store.js';
import { metaResponse } from './meta-response.js';
import {
  buildContextQuestions,
  interpretContextAnswers,
} from '../src/context-questions.js';
import { canonicalJson, sha256 } from '../src/hashing.js';
import { AdapterProposal, ContextProposal } from '@siphon/contracts';
import { grantGroqFixtureConsent } from './groq-stage-fixture.js';

// Authored prior-stage/provider data only, shared by actual repository integration tests.
export async function adapterStageFixture() {
  const docs = new TestDocuments();
  docs.documents.set('testers/alice', { active: true });
  const { audit } = await new FirestoreAuditRepository(docs).create(
    'alice',
    {
      schemaVersion: '1.0',
      title: 'Authored adapter integration',
      domain: 'heat_diffusion',
    },
    'create',
  );
  const now = new Date('2026-10-30T00:00:00.000Z'),
    clock = () => now,
    expiresAt = '2026-10-31T00:00:00.000Z';
  const text =
    'import numpy as np\nt = np.array([0., 1.])\nT = np.array([[1.], [1.]])\n';
  const artifactId = crypto.randomUUID(),
    reviewId = crypto.randomUUID(),
    contextOperationId = crypto.randomUUID();
  const sourceDigest = await sha256(text),
    file = {
      schemaVersion: '1.0' as const,
      artifactId,
      path: 'authored.py',
      bytes: new TextEncoder().encode(text).length,
      sha256: sourceDigest,
    },
    manifest = [file];
  const basis = buildContextQuestions({
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest: 'a'.repeat(64),
    domain: 'heat_diffusion',
  });
  const answers = basis.questions.map((question) => ({
    schemaVersion: '1.0' as const,
    questionId: question.id,
    selectedOptionId: question.options[0]!.id,
    customText: '',
  }));
  const inputDigest = await sha256(
    canonicalJson({ uploads: manifest, answers }),
  );
  const fence = {
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest,
    generation: 0,
  };
  const base = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
  Object.assign(docs.documents.get(base)!, {
    sourceManifest: manifest,
    answers,
    inputDigest,
    stage: 'clarifying',
    status: 'running',
  });
  await grantGroqFixtureConsent(docs, base, {
    ownerUid: 'alice',
    auditId: fence.auditId,
    revisionId: fence.revisionId,
    inputDigest: fence.inputDigest,
  });
  docs.documents.set(`audits/${audit.id}/artifacts/${artifactId}`, {
    ...file,
    ownerUid: 'alice',
    auditId: audit.id,
    lifecycle: 'ready',
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
  const proposal = ContextProposal.parse({
    schemaVersion: '1.0',
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest,
    domain: 'heat_diffusion',
    summary: 'Authored fixture context only.',
    domainMismatchSuspected: false,
    candidates: [],
  });
  const contextDigest = await sha256(canonicalJson(proposal));
  docs.documents.set(`${base}/context/current`, {
    ownerUid: 'alice',
    operationId: contextOperationId,
    inputDigest,
    proposal,
    proposalDigest: contextDigest,
  });
  const source = { artifactId, sourceDigest, reviewId, text },
    sources = [
      {
        artifactId,
        sourceDigest,
        reviewId,
        lineCount: text.split('\n').length,
      },
    ];
  docs.documents.set(
    `contextTasks/${contextOperationId}`,
    ContextTask.parse({
      schemaVersion: '1.0',
      operationId: contextOperationId,
      ownerUid: 'alice',
      ...fence,
      domain: 'heat_diffusion',
      requestDigest: 'c'.repeat(64),
      promptVersion: 'context.2',
      sources,
      createdAt: now.toISOString(),
    }),
  );
  const resolution = {
    schemaVersion: '1.0',
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    parentRevisionId: crypto.randomUUID(),
    inputDigest,
    sourceManifestDigest: await sha256(canonicalJson(manifest)),
    questionBasis: basis,
    declarations: interpretContextAnswers('heat_diffusion', basis, answers),
    questionDraft: null,
    allUserDeclarationsResolved: true,
  };
  docs.documents.set(`${base}/contextAnswerResolution/current`, {
    ...resolution,
    ownerUid: 'alice',
    resolutionDigest: await sha256(canonicalJson(resolution)),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  const price = {
    schemaVersion: '1.0',
    version: 'authored-only',
    model: 'muse-wonder-1.0',
    mode: 'standard',
    verifiedAt: now.toISOString(),
    effectiveFrom: now.toISOString(),
    effectiveUntil: expiresAt,
    inputMicroUsdPerMillion: 4000000,
    cachedInputMicroUsdPerMillion: 200000,
    outputMicroUsdPerMillion: 20000000,
  };
  // All provider evidence and the completed prior context here are authored data.
  // The tested adapter stage must still use actual accounting/claim/settlement code.
  docs.documents.set(`operations/${contextOperationId}`, {
    schemaVersion: '1.0',
    id: contextOperationId,
    ownerUid: 'alice',
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest,
    requestDigest: 'c'.repeat(64),
    fence: 0,
    outcome: 'succeeded',
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    providerHandle: null,
    charges: [
      {
        counterKey: 'authored',
        amount: 1,
        unit: 'attempts',
        consumeOnDispatch: true,
      },
    ],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  docs.documents.set(`modelJobs/${contextOperationId}`, {
    schemaVersion: '1.0',
    operationId: contextOperationId,
    requestDigest: 'c'.repeat(64),
    pricing: price,
    inputTokenBound: 1000,
    outputTokenBound: 4000,
    tokenizerEvidenceId: crypto.randomUUID(),
    pricingDigest: await sha256(canonicalJson(price)),
    createdAt: now.toISOString(),
  });
  docs.documents.set('configuration/meta_pricing', price);
  const counting = {
    schemaVersion: '1.0',
    model: 'muse-wonder-1.0',
    protocol: 'responses.v1',
    profile: 'stateless_text_json_no_tools.v1',
    countingCharge: 'no_charge',
    evidenceDigest: 'd'.repeat(64),
    verifiedAt: now.toISOString(),
    expiresAt,
  };
  docs.documents.set('configuration/meta_counting', counting);
  docs.documents.set('configuration/meta_billing_profile', {
    schemaVersion: '1.0',
    model: 'muse-wonder-1.0',
    protocol: 'responses.v1',
    profile: 'stateless_text_json_no_tools.v1',
    countingVerificationDigest: await sha256(canonicalJson(counting)),
    inputTokenMultiplier: 1,
    additionalInputTokens: 0,
    maximumIterations: 1,
    outputIncludesReasoning: true,
    tokenizerVersion: 'authored-only',
    evidenceDigest: 'e'.repeat(64),
    verifiedAt: now.toISOString(),
    expiresAt,
  });
  docs.documents.set('configuration/meta_credits', {
    schemaVersion: '1.0',
    evidenceId: crypto.randomUUID(),
    allocationMicroUsd: 150000000,
    availableMicroUsd: 150000000,
    accountedSpentMicroUsd: 0,
    verifiedAt: now.toISOString(),
    expiresAt,
  });
  for (const [key, limit] of [
    ['meta_global_micro_usd', 135000000],
    [`meta_revision_${audit.currentRevisionId}`, 2000000],
    [`model_attempts_${audit.currentRevisionId}`, 8],
  ] as const)
    docs.documents.set(`budgets/${key}`, {
      schemaVersion: '1.0',
      limit,
      reserved: 0,
      spent: 0,
      halted: false,
    });
  const adapter = AdapterProposal.parse({
    schemaVersion: '1.0',
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest,
    contextDigest,
    sourceArtifactId: artifactId,
    sourceDigest,
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
  const readBatch = vi.fn(async () => [
    { artifactId, bytes: new TextEncoder().encode(text), sha256: sourceDigest },
  ]);
  const transport = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith('/input_tokens'))
      return Response.json({
        object: 'response.input_tokens',
        input_tokens: 1000,
      });
    return Response.json(
      metaResponse(JSON.stringify(adapter), {
        prompt_tokens: 1000,
        completion_tokens: 50,
        total_tokens: 1050,
      }),
    );
  });
  const coordinator = new AdapterCoordinator(
    docs,
    { readBatch },
    'authored-no-real-key',
    transport,
    clock,
  );
  return {
    docs,
    audit,
    base,
    fence,
    adapter,
    source,
    coordinator,
    transport,
    readBatch,
    clock,
    contextOperationId,
  };
}
