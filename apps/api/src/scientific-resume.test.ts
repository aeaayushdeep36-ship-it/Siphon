import { describe, expect, it, vi } from 'vitest';
import { RequirementId } from '@siphon/contracts';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { buildScientificPlan } from './scientific-plan.js';
import { ResumeService, type InspectionWorkflowBinding } from './runs.js';
import { canonicalJson, sha256 } from './hashing.js';

describe('scientific workflow trigger', () => {
  it('requires a current plan and heat declarations before scheduling, with a stable retry id', async () => {
    const docs = new TestDocuments();
    docs.documents.set('testers/alice', { active: true });
    docs.documents.set('testers/bob', { active: true });
    const { audit } = await new FirestoreAuditRepository(docs).create(
      'alice',
      {
        schemaVersion: '1.0',
        title: 'Authored heat',
        domain: 'heat_diffusion',
      },
      'create',
    );
    const base = `audits/${audit.id}/revisions/${audit.currentRevisionId}`,
      revision = docs.documents.get(base)!;
    Object.assign(revision, { stage: 'adapting', status: 'running' });
    const input = {
      schemaVersion: '1.0',
      expectedGeneration: revision.generation,
      expectedInputDigest: revision.inputDigest,
    };
    const jobId = await sha256(
      canonicalJson({
        uid: 'alice',
        auditId: audit.id,
        revisionId: audit.currentRevisionId,
        inputDigest: revision.inputDigest,
        stage: 'inspection',
      }),
    );
    const now = audit.createdAt;
    docs.documents.set(`stageJobs/${jobId}`, {
      schemaVersion: '1.0',
      id: jobId,
      ownerUid: 'alice',
      auditId: audit.id,
      revisionId: audit.currentRevisionId,
      inputDigest: revision.inputDigest,
      generation: 0,
      startDigest: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64),
      receipt: {
        schemaVersion: '1.0',
        jobId,
        auditId: audit.id,
        revisionId: audit.currentRevisionId,
        inputDigest: revision.inputDigest,
        generation: 0,
        stage: 'draft',
        status: 'queued',
      },
      operationId: crypto.randomUUID(),
      sandboxRequest: null,
      leaseId: null,
      status: 'inspection_complete',
      resultDigest: 'c'.repeat(64),
      createdAt: now,
      updatedAt: now,
    });
    const eligibilityInput = {
      schemaVersion: '1.0',
      domain: 'heat_diffusion',
      inputDigest: revision.inputDigest,
      contextDigest: 'd'.repeat(64),
      adapterDigest: 'e'.repeat(64),
      assertions: RequirementId.options.map((requirement) => ({
        requirement,
        state: [
          'boundary_flux_observed',
          'heat_sources_observed',
          'time_quadrature_supported',
        ].includes(requirement)
          ? 'violated'
          : 'satisfied',
        evidenceIds: [crypto.randomUUID()],
      })),
    };
    const plan = buildScientificPlan({
      planId: crypto.randomUUID(),
      auditId: audit.id,
      revisionId: audit.currentRevisionId,
      eligibilityInput,
      profile: 'heat_energy_si',
      sourceOperationId: crypto.randomUUID(),
      sourceOutputDigest: 'f'.repeat(64),
      createdAt: '2026-11-10T18:00:00.000Z',
    });
    const planDigest = await sha256(canonicalJson(plan));
    docs.documents.set(`${base}/plans/current`, {
      ownerUid: 'alice',
      auditId: audit.id,
      revisionId: audit.currentRevisionId,
      inputDigest: revision.inputDigest,
      plan,
      planDigest,
    });
    const create = vi.fn<InspectionWorkflowBinding['create']>(async () => ({})),
      binding = {
        create,
        get: vi.fn(async () => ({
          status: async () => ({ status: 'running' }),
        })),
      };
    const service = new ResumeService(docs, binding, true);
    await expect(
      service.resumeScientific(
        'alice',
        audit.id,
        audit.currentRevisionId,
        input,
        'key',
      ),
    ).rejects.toThrow('density');
    expect(create).not.toHaveBeenCalled();
    const parameters = { densityKgM3: 1000, heatCapacityJKgK: 4184 };
    docs.documents.set(`${base}/scientificParameters/current`, {
      ownerUid: 'alice',
      planDigest,
      parameters,
      parametersDigest: await sha256(canonicalJson(parameters)),
    });
    expect(
      await service.resumeScientific(
        'alice',
        audit.id,
        audit.currentRevisionId,
        input,
        'key',
      ),
    ).toMatchObject({ status: 'accepted', jobId });
    await service.resumeScientific(
      'alice',
      audit.id,
      audit.currentRevisionId,
      input,
      'key',
    );
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
    expect(create.mock.calls[0]).toMatchObject([
      {
        params: {
          jobId,
          resumeScientific: true,
          phaseKey: expect.stringMatching(/^[a-f0-9]{64}$/),
          fence: { generation: 0 },
        },
      },
    ]);
    const firstPhaseKey = create.mock.calls[0]![0].params.phaseKey;
    await service.resumeScientific(
      'alice',
      audit.id,
      audit.currentRevisionId,
      input,
      'new-attempt',
    );
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[2]![0].id).not.toBe(create.mock.calls[0]![0].id);
    expect(create.mock.calls[2]![0].params.phaseKey).not.toBe(firstPhaseKey);
    await expect(
      service.resumeScientific(
        'bob',
        audit.id,
        audit.currentRevisionId,
        input,
        'other',
      ),
    ).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(3);
  });
});
