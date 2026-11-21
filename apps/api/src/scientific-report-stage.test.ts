import { afterEach, describe, expect, it, vi } from 'vitest';
import * as contracts from '@siphon/contracts';
import { TestDocuments } from '../test/document-store.js';
import { diagnosticsFixture } from '../test/diagnostics-fixture.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { ScientificReportStage } from './scientific-report-stage.js';
import { ReportPublication } from './report-publication.js';
import { assessEligibility } from './eligibility.js';
import { canonicalJson, sha256 } from './hashing.js';

afterEach(() => vi.restoreAllMocks());
describe('scientific report orchestration', () => {
  it('requires published evidence and termination, advances once per stage and replays its report id', async () => {
    const docs = new TestDocuments();
    docs.documents.set('testers/alice', { active: true });
    const { audit } = await new FirestoreAuditRepository(docs).create(
      'alice',
      {
        schemaVersion: '1.0',
        title: 'Authored orbit',
        domain: 'orbital_dynamics',
      },
      'create',
    );
    const base = `audits/${audit.id}/revisions/${audit.currentRevisionId}`,
      revision = docs.documents.get(base)!;
    Object.assign(revision, {
      stage: 'evaluating',
      status: 'running',
      generation: 3,
    });
    const fence = {
      auditId: audit.id,
      revisionId: audit.currentRevisionId,
      generation: 3,
      inputDigest: String(revision.inputDigest),
    };
    const fixture = await diagnosticsFixture(),
      diagnostic = {
        ...fixture.request,
        auditId: audit.id,
        revisionId: fence.revisionId,
        validation: {
          ...fixture.request.validation,
          inputDigest: fence.inputDigest,
          manifest: {
            ...fixture.request.validation.manifest,
            inputDigest: fence.inputDigest,
          },
        },
      };
    const input = {
      schemaVersion: '1.0',
      domain: 'orbital_dynamics',
      inputDigest: fence.inputDigest,
      contextDigest: diagnostic.contextDigest,
      adapterDigest: diagnostic.validation.adapterDigest,
      assertions: contracts.RequirementId.options.map((requirement) => ({
        requirement,
        state:
          requirement === 'isolated_mutual_gravity' ? 'violated' : 'satisfied',
        evidenceIds: [crypto.randomUUID()],
      })),
    };
    const request = contracts.ConservationJobRequest.parse({
      schemaVersion: '1.0',
      diagnostic,
      eligibility: assessEligibility(input),
      planDigest: 'e'.repeat(64),
      evidenceIds: {
        O_ENERGY: crypto.randomUUID(),
        O_ANGULAR: crypto.randomUUID(),
      },
      policies: {
        O_ENERGY: { scope: 'reported_samples', target: null },
        O_ANGULAR: { scope: 'reported_samples', target: null },
      },
    });
    const operationId = request.diagnostic.operationId,
      now = '2026-11-10T18:00:00.000Z',
      requestDigest = await sha256(canonicalJson(request));
    const common = {
      ownerUid: 'alice',
      auditId: audit.id,
      revisionId: fence.revisionId,
      inputDigest: fence.inputDigest,
    };
    docs.documents.set(`operations/${operationId}`, {
      schemaVersion: '1.0',
      id: operationId,
      ...common,
      requestDigest: 'f'.repeat(64),
      fence: 3,
      outcome: 'dispatching',
      charges: [
        {
          counterKey: 'fixture',
          amount: 1,
          unit: 'seconds',
          consumeOnDispatch: false,
        },
      ],
      usage: null,
      providerHandle: 'sandbox',
      createdAt: now,
      updatedAt: now,
    });
    docs.documents.set(`sandboxTerminations/${operationId}`, {
      schemaVersion: '1.0',
      operationId,
      sandboxId: 'sandbox',
      ...common,
      requestDigest: 'f'.repeat(64),
      outcome: 'killed',
      observedAt: now,
    });
    docs.documents.set(`scientificEvaluationStages/${fence.revisionId}`, {
      ...common,
      generation: 3,
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
    const result = { authored: 'result' };
    docs.documents.set(`${base}/evidence/${operationId}`, {
      ...common,
      operationId,
      report: result,
      reportDigest: await sha256(canonicalJson(result)),
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    vi.spyOn(contracts, 'validateConservationJobResult').mockReturnValue(
      result as never,
    );
    const publication = vi
      .spyOn(ReportPublication.prototype, 'assembleAndPublish')
      .mockResolvedValue({
        reportDigest: 'a'.repeat(64),
        replayed: false,
      } as never);
    const stage = new ScientificReportStage(docs, () => new Date(now));
    const published = await stage.publish('alice', fence, operationId);
    expect(published).toMatchObject({
      status: 'report_published',
      fence: { generation: 5 },
    });
    expect(docs.documents.get(base)).toMatchObject({
      stage: 'reporting',
      generation: 5,
    });
    expect(publication).toHaveBeenCalledOnce();
    const replay = await stage.publish('alice', published.fence, operationId);
    expect(replay.reportId).toBe(published.reportId);
    docs.documents.get(`sandboxTerminations/${operationId}`)!.sandboxId =
      'other';
    await expect(
      stage.publish('alice', published.fence, operationId),
    ).rejects.toThrow('evidence is not available');
  });
});
