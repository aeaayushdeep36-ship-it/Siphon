import { vi } from 'vitest';
import { FirestoreAuditRepository } from '../src/audit-repository.js';
import { TestDocuments } from './document-store.js';
import { ContextProposal, InspectionResult } from '@siphon/contracts';
import { canonicalJson, sha256 } from '../src/hashing.js';
import { GROQ_CHAT_ENDPOINT, type AiConfiguration } from '../src/ai-config.js';
// Explicit fake provider/account limits, never an attestation about a live account.
export const groqFixtureConfig: AiConfiguration = {
  provider: 'groq',
  model: 'authored/scientific-reader',
  endpoint: GROQ_CHAT_ENDPOINT,
  reasoningEffort: 'medium',
  apiKey: 'authored-no-real-key',
  requestTimeoutMs: 1000,
  maxInputTokens: 24000,
  maxInputBytes: 24000,
  maxOutputTokens: 1000,
  maxRequestBytes: 256 * 1024,
  maxResponseBytes: 512 * 1024,
  requestsPerMinute: 30,
  requestsPerDay: 100,
  tokensPerMinute: 25000,
  tokensPerDay: 100000,
};

export async function groqContextFixture(
  text = 'temperature = [300., 300.]\n',
) {
  const docs = new TestDocuments();
  docs.documents.set('testers/alice', { active: true });
  const { audit } = await new FirestoreAuditRepository(docs).create(
    'alice',
    { schemaVersion: '1.0', title: 'Groq fixture', domain: 'heat_diffusion' },
    'create',
  );
  const clock = () => new Date('2026-11-08T00:00:00.000Z');
  const artifactId = crypto.randomUUID(),
    inspectionOperationId = crypto.randomUUID(),
    sourceDigest = await sha256(text),
    bytes = new TextEncoder().encode(text),
    base = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
  const manifest = [
    {
      schemaVersion: '1.0',
      artifactId,
      path: 'simulation.py',
      bytes: bytes.length,
      sha256: sourceDigest,
    },
  ];
  const inputDigest = await sha256(
    canonicalJson({ uploads: manifest, answers: [] }),
  );
  const fence = {
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest,
    generation: 0,
  };
  Object.assign(docs.documents.get(base)!, {
    stage: 'inspecting',
    status: 'running',
    sourceManifest: manifest,
    inputDigest,
  });
  docs.documents.set(`audits/${audit.id}/artifacts/${artifactId}`, {
    ...manifest[0],
    ownerUid: 'alice',
    auditId: audit.id,
    lifecycle: 'ready',
    expiresAt: '2026-11-09T00:00:00.000Z',
  });
  const inspection = InspectionResult.parse({
    schemaVersion: '1.0',
    sourceDigest,
    parsed: true,
    truncated: false,
    dependencies: [],
    definitions: [],
    findings: [],
  });
  const resultDigest = await sha256(
    canonicalJson({
      schemaVersion: '1.0',
      operationId: inspectionOperationId,
      inputDigest,
      sources: [{ artifactId, inspection }],
    }),
  );
  docs.documents.set(`${base}/inspection/current`, {
    ownerUid: 'alice',
    inputDigest,
    operationId: inspectionOperationId,
    resultDigest,
  });
  docs.documents.set(`inspectionExecutions/${inspectionOperationId}`, {
    status: 'published',
    operationId: inspectionOperationId,
    ownerUid: 'alice',
    ...fence,
    resultDigest,
  });
  docs.documents.set(`${base}/inspectionSources/${artifactId}`, {
    ownerUid: 'alice',
    operationId: inspectionOperationId,
    inputDigest,
    artifactId,
    inspection,
  });
  const proposal = ContextProposal.parse({
    schemaVersion: '1.0',
    auditId: fence.auditId,
    revisionId: fence.revisionId,
    inputDigest: fence.inputDigest,
    domain: 'heat_diffusion',
    summary: 'Authored context only.',
    domainMismatchSuspected: false,
    candidates: [],
  });
  const readBatch = vi.fn(async () => [
    { artifactId, bytes, sha256: sourceDigest },
  ]);
  const transport = vi.fn<typeof fetch>(async () =>
    Response.json({
      id: 'authored-groq-response',
      object: 'chat.completion',
      model: groqFixtureConfig.model,
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify(proposal) },
        },
      ],
      usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 },
    }),
  );
  const ids = {
    countId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    tokenEvidenceId: crypto.randomUUID(),
  };
  return { docs, clock, fence, base, proposal, readBatch, transport, ids };
}
