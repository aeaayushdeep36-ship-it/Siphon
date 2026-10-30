import { describe, expect, it } from 'vitest';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { SourceOutputStore } from './source-output-store.js';
import { sha256 } from './hashing.js';
import { SourceJobRequest } from '@siphon/contracts';
import { AuditCommands } from './audit-commands.js';
import { StoredObservationLoader } from './stored-observations.js';
import { ArtifactDownloadService } from './artifact-download.js';
import { canonicalJson } from './hashing.js';
import { ValidationExecutions } from './validation-executions.js';
import { DiagnosticExecutions } from './diagnostic-executions.js';
import { DiagnosticsPipeline } from './diagnostics-pipeline.js';
import {
  DiagnosticJobRequest,
  type DiagnosticJobResult,
} from '@siphon/contracts';

async function setup() {
  const docs = new TestDocuments();
  docs.documents.set('testers/alice', { active: true });
  const { audit } = await new FirestoreAuditRepository(docs).create(
    'alice',
    {
      schemaVersion: '1.0',
      title: 'Output storage',
      domain: 'heat_diffusion',
    },
    'create',
  );
  const path = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
  const revision = docs.documents.get(path)!;
  Object.assign(revision, { stage: 'adapting', status: 'running' });
  const operationId = crypto.randomUUID(),
    artifactId = crypto.randomUUID();
  const now = new Date('2026-10-29T00:00:00.000Z');
  const request = SourceJobRequest.parse({
    schemaVersion: '1.0',
    operationId,
    inputDigest: revision.inputDigest,
    adapterDigest: 'b'.repeat(64),
    entryArtifactId: artifactId,
    files: [
      {
        schemaVersion: '1.0',
        artifactId,
        path: 'fixture.py',
        bytes: 0,
        sha256: await sha256(''),
        dataBase64: '',
      },
    ],
    mappings: [
      {
        key: 'times',
        root: 't',
        steps: [],
        expectedShape: [2],
        axisOrder: [0],
        declaredUnit: 's',
      },
    ],
    maximumOutputBytes: 1024,
    maximumElements: 100,
  });
  const raw = new TextEncoder().encode('still-unvalidated');
  const dataHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', raw)),
    (n) => n.toString(16).padStart(2, '0'),
  ).join('');
  const manifest = {
    schemaVersion: '1.0',
    operationId,
    inputDigest: request.inputDigest,
    adapterDigest: request.adapterDigest,
    executionProfile: 'runpy_main_root_v1',
    observations: [
      {
        key: 'times',
        filename: 'obs_times.npy',
        bytes: raw.length,
        sha256: dataHash,
        shape: [2],
        dtype: 'float64',
        declaredUnit: 's',
      },
    ],
  };
  const payloadDigest = await sha256(JSON.stringify(request));
  const requestDigest = 'c'.repeat(64);
  docs.documents.set(`operations/${operationId}`, {
    schemaVersion: '1.0',
    id: operationId,
    ownerUid: 'alice',
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest: request.inputDigest,
    requestDigest,
    fence: 0,
    outcome: 'dispatching',
    providerHandle: 'authored-vm',
    usage: null,
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
  const reservedBytes = request.maximumOutputBytes + 32768;
  docs.documents.set(`sourceExecutions/${operationId}`, {
    schemaVersion: '1.0',
    operationId,
    ownerUid: 'alice',
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest: request.inputDigest,
    generation: 0,
    approvalId: crypto.randomUUID(),
    payloadDigest,
    sandboxRequestDigest: requestDigest,
    reservedBytes,
    status: 'claimed',
    sandboxId: 'authored-vm',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  docs.documents.set(`sandboxTerminations/${operationId}`, {
    schemaVersion: '1.0',
    operationId,
    sandboxId: 'authored-vm',
    ownerUid: 'alice',
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    inputDigest: request.inputDigest,
    requestDigest,
    outcome: 'killed',
    observedAt: now.toISOString(),
  });
  const outputKey = `revision_output_bytes_${audit.currentRevisionId}`;
  docs.documents.set(`reservations/source_output_${operationId}`, {
    schemaVersion: '1.0',
    operationId,
    ownerUid: 'alice',
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    amount: reservedBytes,
    payloadDigest,
    outputCounterKey: outputKey,
    resource: 'source_output_bytes',
    status: 'reserved',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  for (const key of ['r2_storage_bytes', outputKey])
    docs.documents.set(`budgets/${key}`, {
      schemaVersion: '1.0',
      limit: 1000000,
      reserved: reservedBytes,
      spent: 0,
      halted: false,
    });
  docs.documents.set('configuration/r2_class_a_period', {
    counterKey: 'class_a',
    startsAt: '2026-10-01T00:00:00Z',
    endsAt: '2026-11-01T00:00:00Z',
  });
  docs.documents.set('budgets/class_a', {
    schemaVersion: '1.0',
    limit: 100,
    reserved: 0,
    spent: 0,
    halted: false,
  });
  const writes: string[] = [];
  const objects = {
    putOnce: async (
      key: string,
      bytes: Uint8Array<ArrayBuffer>,
      hash: string,
    ) => {
      writes.push(key);
      return { size: bytes.length, sha256: hash };
    },
  };
  const service = new SourceOutputStore(docs, objects, () => now);
  return {
    docs,
    audit,
    operationId,
    request,
    manifest,
    payloads: [{ filename: 'obs_times.npy', bytes: raw }],
    writes,
    objects,
    service,
    reservedBytes,
    outputKey,
  };
}
describe('private source output persistence', () => {
  it.each([
    'publish',
    'cancel',
    'expired',
    'corrupt',
    'diag_publish',
    'diag_pending',
    'diag_cancel',
    'diag_context',
    'diag_old_report',
    'diag_duplicate_vm',
    'diag_budget',
    'diag_cross_kind',
    'diag_parameters',
    'diag_foreign_owner',
    'diag_expired_validation',
    'diag_dimension_policy',
  ])(
    'loads private numeric outputs and handles a durable validation candidate: %s',
    async (candidateCase) => {
      const f = await setup();
      f.request.mappings.push({
        key: 'temperature',
        root: 'T',
        steps: [],
        expectedShape: [2, 1],
        axisOrder: [0, 1],
        declaredUnit: 'K',
      });
      f.request.mappings.push({
        key: 'thermal_weights',
        root: 'w',
        steps: [],
        expectedShape: [1],
        axisOrder: [0],
        declaredUnit: 'm^3',
      });
      const proposal = {
        schemaVersion: '1.0',
        auditId: f.audit.id,
        revisionId: f.audit.currentRevisionId,
        inputDigest: f.request.inputDigest,
        domain: 'heat_diffusion',
        summary: 'Authored context fixture',
        domainMismatchSuspected: false,
        candidates: [],
      };
      const contextDigest = await sha256(canonicalJson(proposal));
      const contextPath = `audits/${f.audit.id}/revisions/${f.audit.currentRevisionId}/context/current`;
      f.docs.documents.set(contextPath, {
        ownerUid: 'alice',
        inputDigest: f.request.inputDigest,
        proposalDigest: contextDigest,
        proposal,
      });
      const binding = f.docs.documents.get(
        `sourceExecutions/${f.operationId}`,
      )!;
      const adapter = {
        schemaVersion: '1.0',
        auditId: f.audit.id,
        revisionId: f.audit.currentRevisionId,
        inputDigest: f.request.inputDigest,
        contextDigest,
        sourceArtifactId: f.request.entryArtifactId,
        sourceDigest: f.request.files[0]!.sha256,
        domain: 'heat_diffusion',
        handler: 'script_globals_v1',
        mappings: f.request.mappings,
      };
      f.request.adapterDigest = await sha256(canonicalJson(adapter));
      f.manifest.adapterDigest = f.request.adapterDigest;
      f.manifest.observations.push({
        ...f.manifest.observations[0]!,
        key: 'temperature',
        filename: 'obs_temperature.npy',
        shape: [2, 1],
        declaredUnit: 'K',
      });
      f.payloads.push({
        filename: 'obs_temperature.npy',
        bytes: f.payloads[0]!.bytes,
      });
      f.manifest.observations.push({
        ...f.manifest.observations[0]!,
        key: 'thermal_weights',
        filename: 'obs_thermal_weights.npy',
        shape: [1],
        declaredUnit: 'm^3',
      });
      f.payloads.push({
        filename: 'obs_thermal_weights.npy',
        bytes: f.payloads[0]!.bytes,
      });
      const payloadDigest = await sha256(JSON.stringify(f.request));
      binding.payloadDigest = payloadDigest;
      f.docs.documents.get(
        `reservations/source_output_${f.operationId}`,
      )!.payloadDigest = payloadDigest;
      f.docs.documents.set(
        `sourceExecutionApprovals/${String(binding.approvalId)}`,
        {
          schemaVersion: '1.0',
          id: binding.approvalId,
          ownerUid: 'alice',
          payloadDigest,
          readinessDigest: 'd'.repeat(64),
          adapter,
          purpose: 'baseline_observation',
          executionProfile: 'runpy_main_root_v1',
          verifiedAt: '2026-10-29T00:00:00Z',
          expiresAt: '2026-10-30T00:00:00Z',
        },
      );
      const stored = new Map<
        string,
        { bytes: Uint8Array<ArrayBuffer>; hash: string }
      >();
      f.objects.putOnce = async (key, bytes, hash) => {
        stored.set(key, { bytes: new Uint8Array(bytes), hash });
        return { size: bytes.length, sha256: hash };
      };
      await f.service.persist(f.request, f.manifest, f.payloads);
      const evaluationId = crypto.randomUUID();
      f.docs.documents.set(`operations/${evaluationId}`, {
        ...f.docs.documents.get(`operations/${f.operationId}`)!,
        id: evaluationId,
        outcome: 'reserved',
        providerHandle: null,
        requestDigest: 'e'.repeat(64),
      });
      f.docs.documents.set('configuration/r2_class_b_period', {
        counterKey: 'class_b',
        startsAt: '2026-10-01T00:00:00Z',
        endsAt: '2026-11-01T00:00:00Z',
      });
      f.docs.documents.set('budgets/class_b', {
        schemaVersion: '1.0',
        limit: 100,
        reserved: 0,
        spent: 0,
        halted: false,
      });
      const downloads = new ArtifactDownloadService(
        f.docs,
        {
          get: async (key) => {
            const item = stored.get(key)!;
            return {
              size: item.bytes.length,
              sha256: item.hash,
              body: new Response(item.bytes).body!,
            };
          },
        },
        () => new Date('2026-10-29T00:00:00Z'),
      );
      const loader = new StoredObservationLoader(f.docs, downloads);
      const fence = {
        auditId: f.audit.id,
        revisionId: f.audit.currentRevisionId,
        generation: 0,
        inputDigest: f.request.inputDigest,
      };
      const loaded = await loader.load(
        'alice',
        f.operationId,
        evaluationId,
        fence,
      );
      expect(loaded.request.evaluationOperationId).toBe(evaluationId);
      expect(loaded.payloads).toHaveLength(3);
      expect(JSON.stringify(loaded.request)).not.toContain('dataBase64');
      expect(f.docs.documents.get('budgets/class_b')?.spent).toBe(4);
      const validation = new ValidationExecutions(
        f.docs,
        () => new Date('2026-10-29T00:00:00Z'),
      );
      const evaluationSandbox = {
        operationId: evaluationId,
        auditId: f.audit.id,
        revisionId: f.audit.currentRevisionId,
        inputDigest: f.request.inputDigest,
        role: 'evaluation',
        templateId: 'authored-evaluation',
        templateEvidenceId: crypto.randomUUID(),
        lifetimeSeconds: 60,
      };
      const evaluationDigest = await sha256(canonicalJson(evaluationSandbox));
      const evaluation = f.docs.documents.get(`operations/${evaluationId}`)!;
      evaluation.requestDigest = evaluationDigest;
      const beforeReservation = Number(
        f.docs.documents.get(`budgets/${f.outputKey}`)!.reserved,
      );
      const outputBefore = f.docs.documents.get(`budgets/${f.outputKey}`)!;
      const originalLimit = outputBefore.limit;
      outputBefore.limit = outputBefore.spent;
      await expect(validation.bind(loaded.request)).rejects.toThrow(
        'allowance exhausted',
      );
      expect(f.docs.documents.has(`validationExecutions/${evaluationId}`)).toBe(
        false,
      );
      f.docs.documents.get(`budgets/${f.outputKey}`)!.limit = originalLimit;
      const beforeSpent = Number(
        f.docs.documents.get(`budgets/${f.outputKey}`)!.spent,
      );
      const bound = await validation.bind(loaded.request);
      expect((await validation.bind(loaded.request)).payloadDigest).toBe(
        bound.payloadDigest,
      );
      expect(f.docs.documents.get(`budgets/${f.outputKey}`)?.reserved).toBe(
        beforeReservation + 32768,
      );
      Object.assign(f.docs.documents.get(`operations/${evaluationId}`)!, {
        outcome: 'dispatching',
        providerHandle: 'separate-evaluation-vm',
      });
      f.docs.documents.set(`sandboxJobs/${evaluationId}`, {
        request: evaluationSandbox,
        requestDigest: evaluationDigest,
      });
      f.docs.documents.set('sandboxHandles/separate-evaluation-vm', {
        operationId: evaluationId,
        ownerUid: 'alice',
        auditId: f.audit.id,
        revisionId: f.audit.currentRevisionId,
      });
      await expect(
        validation.claim(loaded.request, bound.payloadDigest, 'authored-vm'),
      ).rejects.toThrow('fresh');
      // Even if a provider handle were incorrectly reused, role separation blocks it.
      f.docs.documents.get(`operations/${evaluationId}`)!.providerHandle =
        'authored-vm';
      f.docs.documents.set('sandboxHandles/authored-vm', {
        operationId: evaluationId,
        ownerUid: 'alice',
        auditId: f.audit.id,
        revisionId: f.audit.currentRevisionId,
      });
      await expect(
        validation.claim(loaded.request, bound.payloadDigest, 'authored-vm'),
      ).rejects.toThrow('fresh');
      f.docs.documents.get(`operations/${evaluationId}`)!.providerHandle =
        'separate-evaluation-vm';
      await validation.claim(
        loaded.request,
        bound.payloadDigest,
        'separate-evaluation-vm',
      );
      await expect(
        validation.claim(
          loaded.request,
          bound.payloadDigest,
          'separate-evaluation-vm',
        ),
      ).rejects.toThrow('fresh');
      await validation.authorizeResult(evaluationId);
      // Offline evaluator report fixture: actual decoding is verified separately in Python/parity tests.
      const report = {
        schemaVersion: '1.0',
        evaluationOperationId: evaluationId,
        sourceOperationId: f.operationId,
        inputDigest: f.request.inputDigest,
        adapterDigest: f.request.adapterDigest,
        validation: 'validated_numeric_structure',
        totalBytes: f.manifest.observations.reduce(
          (sum, item) => sum + item.bytes,
          0,
        ),
        totalElements: 5,
        observations: f.manifest.observations.map((item) => ({
          key: item.key,
          sha256: item.sha256,
          bytes: item.bytes,
          shape: item.shape,
          dtype: 'float64',
          originalDtype: '<f8',
          conversion: 'none',
          declaredUnit: item.declaredUnit,
          elements: item.key === 'thermal_weights' ? 1 : 2,
        })),
      };
      const candidatePath = `validationCandidates/${evaluationId}`;
      const reportPath = `audits/${f.audit.id}/revisions/${f.audit.currentRevisionId}/numericValidations/${evaluationId}`;
      expect(
        (await validation.recordCandidate(evaluationId, report)).replayed,
      ).toBe(false);
      expect(
        (await validation.recordCandidate(evaluationId, report)).replayed,
      ).toBe(true);
      expect(f.docs.documents.has(reportPath)).toBe(false);
      expect(f.docs.documents.get(`budgets/${f.outputKey}`)?.reserved).toBe(
        beforeReservation + 32768,
      );
      await expect(validation.publish(evaluationId)).rejects.toThrow();
      const savedCandidate = structuredClone(
        f.docs.documents.get(candidatePath)!,
      );
      f.docs.documents.set(`sandboxTerminations/${evaluationId}`, {
        schemaVersion: '1.0',
        operationId: evaluationId,
        sandboxId: 'separate-evaluation-vm',
        ownerUid: 'alice',
        auditId: f.audit.id,
        revisionId: f.audit.currentRevisionId,
        inputDigest: f.request.inputDigest,
        requestDigest: evaluationDigest,
        outcome: 'killed',
        observedAt: '2026-10-29T00:00:00Z',
      });
      if (candidateCase === 'cancel') {
        await new AuditCommands(f.docs).cancel(
          'alice',
          f.audit.id,
          f.audit.currentRevisionId,
          'cancel-candidate',
        );
        await expect(validation.publish(evaluationId)).rejects.toMatchObject({
          code: 'stale_revision',
        });
        expect(f.docs.documents.has(candidatePath)).toBe(true);
        expect(f.docs.documents.has(reportPath)).toBe(false);
        return;
      }
      if (candidateCase === 'expired') {
        f.docs.documents.get(candidatePath)!.expiresAt = '2026-10-28T00:00:00Z';
        await expect(validation.publish(evaluationId)).rejects.toThrow(
          'stale or conflicts',
        );
        expect(f.docs.documents.has(reportPath)).toBe(false);
        return;
      }
      if (candidateCase === 'corrupt') {
        // Both representations are individually valid but have different provenance.
        const changed = structuredClone(report);
        changed.observations[0]!.originalDtype = '>f8';
        changed.observations[0]!.conversion = 'exact_to_float64';
        f.docs.documents.get(candidatePath)!.report = changed;
        await expect(
          validation.recordCandidate(evaluationId, report),
        ).rejects.toThrow('content changed');
        await expect(validation.publish(evaluationId)).rejects.toThrow(
          'stale or conflicts',
        );
        expect(f.docs.documents.has(reportPath)).toBe(false);
        return;
      }
      expect((await validation.publish(evaluationId)).replayed).toBe(false);
      expect(f.docs.documents.has(candidatePath)).toBe(false);
      expect(f.docs.documents.get(reportPath)?.expiresAt).toBe(
        savedCandidate.expiresAt,
      );
      expect((await validation.publish(evaluationId)).replayed).toBe(true);
      expect(
        (await validation.recordCandidate(evaluationId, report)).replayed,
      ).toBe(true);
      expect(f.docs.documents.has(candidatePath)).toBe(false);
      expect(f.docs.documents.get(`budgets/${f.outputKey}`)?.reserved).toBe(
        beforeReservation,
      );
      expect(f.docs.documents.get(`budgets/${f.outputKey}`)?.spent).toBe(
        beforeSpent + new TextEncoder().encode(canonicalJson(report)).length,
      );
      if (candidateCase.startsWith('diag_')) {
        const diagnosticId = crypto.randomUUID();
        const diagnosticSandbox = {
          ...evaluationSandbox,
          operationId: diagnosticId,
        };
        const diagnosticDigest = await sha256(canonicalJson(diagnosticSandbox));
        f.docs.documents.set(`operations/${diagnosticId}`, {
          ...f.docs.documents.get(`operations/${evaluationId}`)!,
          id: diagnosticId,
          outcome: 'reserved',
          providerHandle: null,
          requestDigest: diagnosticDigest,
        });
        f.docs.documents.get(
          `audits/${f.audit.id}/revisions/${f.audit.currentRevisionId}`,
        )!.stage = 'evaluating';
        const diagnosticRequest = DiagnosticJobRequest.parse({
          schemaVersion: '1.0',
          operationId: diagnosticId,
          auditId: f.audit.id,
          revisionId: f.audit.currentRevisionId,
          contextDigest,
          validation: loaded.request,
          profile: {
            kind: 'heat_energy_si',
            densityKgM3: 2,
            heatCapacityJKgK: 3,
          },
        });
        const diagnostics = new DiagnosticExecutions(
          f.docs,
          () => new Date('2026-10-29T00:00:00Z'),
        );
        let creates = 0,
          runs = 0,
          kills = 0;
        const vmId =
          candidateCase === 'diag_duplicate_vm'
            ? 'separate-evaluation-vm'
            : 'third-diagnostic-vm';
        // Authored transport report only. Actual NPY-to-metric arithmetic is
        // independently exercised in the Python/parity suites.
        const diagnosticReport: DiagnosticJobResult = {
          schemaVersion: '1.0',
          operationId: diagnosticId,
          auditId: f.audit.id,
          revisionId: f.audit.currentRevisionId,
          validationOperationId: evaluationId,
          sourceOperationId: f.operationId,
          inputDigest: f.request.inputDigest,
          contextDigest,
          adapterDigest: f.request.adapterDigest,
          profile: diagnosticRequest.profile,
          kind: 'numeric_diagnostics',
          methodVersion: '0.1.0',
          sampleCount: 2,
          timeRangeSeconds: [0, 1],
          metrics: [
            {
              name: 'thermal_energy_change',
              unit: 'J',
              value: 6,
              normalization: 'absolute',
              status: 'inconclusive',
              reason: 'measurement_only',
              arithmetic: null,
            },
          ],
          limitations: ['Authored transport fixture; no scientific verdict.'],
        };
        const finish = async () => {
          f.docs.documents.set(`sandboxTerminations/${diagnosticId}`, {
            ...f.docs.documents.get(`sandboxTerminations/${evaluationId}`)!,
            operationId: diagnosticId,
            sandboxId: vmId,
            requestDigest: diagnosticDigest,
          });
        };
        const pipeline = new DiagnosticsPipeline(loader, diagnostics, {
          createDiagnostics: async () => {
            creates++;
            Object.assign(f.docs.documents.get(`operations/${diagnosticId}`)!, {
              outcome: 'dispatching',
              providerHandle: vmId,
            });
            f.docs.documents.set(`sandboxJobs/${diagnosticId}`, {
              request: diagnosticSandbox,
              requestDigest: diagnosticDigest,
            });
            f.docs.documents.set(`sandboxHandles/${vmId}`, {
              operationId: diagnosticId,
              ownerUid: 'alice',
              auditId: f.audit.id,
              revisionId: f.audit.currentRevisionId,
            });
            return {
              sandboxId: vmId,
              session: {
                sandboxId: vmId,
                writeRequest: async () => {},
                writeObservation: async () => {},
                run: async () => {
                  runs++;
                  return 0;
                },
                readResult: async () =>
                  new Response(JSON.stringify(diagnosticReport)).body!,
              },
            };
          },
          kill: async () => {
            kills++;
            if (candidateCase === 'diag_pending')
              throw new Error('kill_unknown');
            await finish();
            if (candidateCase === 'diag_cancel')
              await new AuditCommands(f.docs).cancel(
                'alice',
                f.audit.id,
                f.audit.currentRevisionId,
                'cancel-diagnostic',
              );
            return 'killed';
          },
        });
        if (candidateCase === 'diag_context')
          f.docs.documents.get(contextPath)!.proposalDigest = 'f'.repeat(64);
        if (candidateCase === 'diag_old_report')
          f.docs.documents.get(reportPath)!.reportDigest = 'f'.repeat(64);
        if (candidateCase === 'diag_budget')
          f.docs.documents.get(`budgets/${f.outputKey}`)!.limit =
            f.docs.documents.get(`budgets/${f.outputKey}`)!.spent;
        if (candidateCase === 'diag_cross_kind')
          f.docs.documents.set(`validationExecutions/${diagnosticId}`, {
            reserved: true,
          });
        if (candidateCase === 'diag_expired_validation')
          f.docs.documents.get(reportPath)!.expiresAt = '2026-10-28T00:00:00Z';
        if (candidateCase === 'diag_dimension_policy') {
          const revision = f.docs.documents.get(
            `audits/${f.audit.id}/revisions/${f.audit.currentRevisionId}`,
          )!;
          revision.policy = { ...(revision.policy as object), heatCells: 0 };
        }
        const diagnosticPath = `audits/${f.audit.id}/revisions/${f.audit.currentRevisionId}/numericDiagnostics/${diagnosticId}`;
        if (
          [
            'diag_context',
            'diag_old_report',
            'diag_budget',
            'diag_cross_kind',
            'diag_foreign_owner',
            'diag_expired_validation',
            'diag_dimension_policy',
          ].includes(candidateCase)
        ) {
          await expect(
            pipeline.run(
              candidateCase === 'diag_foreign_owner' ? 'bob' : 'alice',
              diagnosticSandbox,
              diagnosticRequest,
              fence,
            ),
          ).rejects.toThrow();
          expect(creates).toBe(0);
          expect(
            f.docs.documents.has(`diagnosticExecutions/${diagnosticId}`),
          ).toBe(false);
          return;
        }
        if (candidateCase === 'diag_duplicate_vm') {
          await expect(
            pipeline.run('alice', diagnosticSandbox, diagnosticRequest, fence),
          ).rejects.toThrow('fresh');
          expect(runs).toBe(0);
          expect(kills).toBe(1);
          expect(f.docs.documents.has(diagnosticPath)).toBe(false);
          return;
        }
        if (candidateCase === 'diag_cancel') {
          await expect(
            pipeline.run('alice', diagnosticSandbox, diagnosticRequest, fence),
          ).rejects.toMatchObject({ code: 'stale_revision' });
          expect(f.docs.documents.has(diagnosticPath)).toBe(false);
          expect(
            f.docs.documents.has(`diagnosticCandidates/${diagnosticId}`),
          ).toBe(true);
          return;
        }
        const beforeDiagnosticSpent = Number(
          f.docs.documents.get(`budgets/${f.outputKey}`)!.spent,
        );
        const receipt = await pipeline.run(
          'alice',
          diagnosticSandbox,
          diagnosticRequest,
          fence,
        );
        if (candidateCase === 'diag_pending') {
          expect(receipt.status).toBe('awaiting_termination');
          expect(f.docs.documents.has(diagnosticPath)).toBe(false);
          expect(f.docs.documents.get(`budgets/${f.outputKey}`)?.reserved).toBe(
            beforeReservation + 32768,
          );
          await expect(pipeline.recover(diagnosticId)).rejects.toThrow();
          await finish();
          expect((await pipeline.recover(diagnosticId)).status).toBe(
            'published',
          );
        } else expect(receipt.status).toBe('published');
        expect(creates).toBe(1);
        expect(runs).toBe(1);
        expect(kills).toBe(1);
        expect((await pipeline.recover(diagnosticId)).replayed).toBe(true);
        expect(f.docs.documents.get(diagnosticPath)?.report).toEqual(
          diagnosticReport,
        );
        expect(
          f.docs.documents.has(`diagnosticCandidates/${diagnosticId}`),
        ).toBe(false);
        expect(f.docs.documents.get(`budgets/${f.outputKey}`)?.reserved).toBe(
          beforeReservation,
        );
        expect(f.docs.documents.get(`budgets/${f.outputKey}`)?.spent).toBe(
          beforeDiagnosticSpent +
            new TextEncoder().encode(canonicalJson(diagnosticReport)).length,
        );
        if (candidateCase === 'diag_parameters') {
          await expect(
            diagnostics.bind({
              ...diagnosticRequest,
              profile: { ...diagnosticRequest.profile, densityKgM3: 20 },
            }),
          ).rejects.toThrow('conflict');
          await expect(
            diagnostics.recordCandidate(diagnosticId, {
              ...diagnosticReport,
              profile: { ...diagnosticReport.profile, densityKgM3: 20 },
            }),
          ).rejects.toThrow('snapshot');
        }
        return;
      }
      await expect(
        validation.publish(evaluationId, {
          ...report,
          totalElements: report.totalElements + 1,
        }),
      ).rejects.toThrow();
      await expect(
        loader.load('alice', f.operationId, f.operationId, fence),
      ).rejects.toThrow('Separate');
      await new AuditCommands(f.docs).cancel(
        'alice',
        f.audit.id,
        f.audit.currentRevisionId,
        'cancel',
      );
      await expect(
        loader.load('alice', f.operationId, evaluationId, fence),
      ).rejects.toMatchObject({ code: 'stale_revision' });
      await expect(
        validation.publish(evaluationId, report),
      ).rejects.toMatchObject({ code: 'stale_revision' });
    },
  );
  it('writes once, finalizes both byte counters and preserves unvalidated status on replay', async () => {
    const f = await setup();
    const receipt = await f.service.persist(f.request, f.manifest, f.payloads);
    expect(receipt.numericValidation).toBe('unvalidated');
    expect(receipt.artifactIds).toHaveLength(2);
    expect(f.writes).toHaveLength(2);
    for (const key of ['r2_storage_bytes', f.outputKey])
      expect(f.docs.documents.get(`budgets/${key}`)).toMatchObject({
        reserved: 0,
        spent: receipt.storedBytes,
      });
    expect(f.docs.documents.get('budgets/class_a')?.spent).toBe(2);
    for (const id of receipt.artifactIds)
      expect(
        f.docs.documents.get(`audits/${f.audit.id}/artifacts/${id}`),
      ).toMatchObject({ lifecycle: 'ready', numericValidation: 'unvalidated' });
    expect(await f.service.persist(f.request, f.manifest, f.payloads)).toEqual(
      receipt,
    );
    expect(f.writes).toHaveLength(2);
  });
  it('does not retry an ambiguous write or refund its reserved storage', async () => {
    const f = await setup();
    f.objects.putOnce = async (key) => {
      f.writes.push(key);
      throw new Error('ambiguous');
    };
    await expect(
      f.service.persist(f.request, f.manifest, f.payloads),
    ).rejects.toThrow('source_output_write_unknown');
    await expect(
      f.service.persist(f.request, f.manifest, f.payloads),
    ).rejects.toThrow('reconciliation');
    expect(f.writes).toHaveLength(1);
    expect(f.docs.documents.get('budgets/r2_storage_bytes')).toMatchObject({
      reserved: f.reservedBytes,
      spent: 0,
    });
    expect(
      [...f.docs.documents.values()].some(
        (record) =>
          record.kind === 'source_output_put' && record.outcome === 'unknown',
      ),
    ).toBe(true);
  });
  it('keeps a partially written batch unavailable until every write is confirmed', async () => {
    const f = await setup();
    const put = f.objects.putOnce;
    f.objects.putOnce = async (...args) => {
      if (f.writes.length === 1) throw new Error('second write unknown');
      return put(...args);
    };
    await expect(
      f.service.persist(f.request, f.manifest, f.payloads),
    ).rejects.toThrow('unknown');
    const outputs = [...f.docs.documents.values()].filter(
      (record) => record.kind === 'source_output_unvalidated',
    );
    expect(outputs.some((record) => record.lifecycle === 'uploaded')).toBe(
      true,
    );
    expect(outputs.some((record) => record.lifecycle === 'ready')).toBe(false);
    expect(f.docs.documents.get('budgets/r2_storage_bytes')?.reserved).toBe(
      f.reservedBytes,
    );
  });
  it('records a confirmed write after cancellation but blocks subsequent writes/final publication', async () => {
    const f = await setup();
    f.objects.putOnce = async (key, bytes, hash) => {
      f.writes.push(key);
      await new AuditCommands(f.docs).cancel(
        'alice',
        f.audit.id,
        f.audit.currentRevisionId,
        'cancel',
      );
      return { size: bytes.length, sha256: hash };
    };
    await expect(
      f.service.persist(f.request, f.manifest, f.payloads),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    expect(f.writes).toHaveLength(1);
    expect(
      [...f.docs.documents.values()].some(
        (record) =>
          record.kind === 'source_output_unvalidated' &&
          record.lifecycle === 'ready',
      ),
    ).toBe(false);
    expect(f.docs.documents.get('budgets/r2_storage_bytes')?.reserved).toBe(
      f.reservedBytes,
    );
  });
  it.each(['termination', 'class_a', 'hash'])(
    'rejects invalid %s without an R2 write',
    async (kind) => {
      const f = await setup();
      if (kind === 'termination')
        f.docs.documents.delete(`sandboxTerminations/${f.operationId}`);
      if (kind === 'class_a')
        f.docs.documents.get('budgets/class_a')!.limit = 0;
      if (kind === 'hash') f.payloads[0]!.bytes[0] = 1;
      await expect(
        f.service.persist(f.request, f.manifest, f.payloads),
      ).rejects.toThrow();
      expect(f.writes).toHaveLength(0);
      expect(f.docs.documents.get('budgets/r2_storage_bytes')?.reserved).toBe(
        f.reservedBytes,
      );
    },
  );
});
