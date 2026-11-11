import { vi } from 'vitest';
import { SourceJobRequest } from '@siphon/contracts';
import { baselineStageFixture } from './baseline-stage-fixture.js';
import { BaselineSourceStage } from '../src/baseline-source-stage.js';
import { SandboxJobs } from '../src/sandbox-jobs.js';
import { E2bClient } from '../src/e2b-client.js';
import { SourceExecutions } from '../src/source-executions.js';
import { SourcePipeline } from '../src/source-pipeline.js';
import { SourceOutputStore } from '../src/source-output-store.js';
import { sha256 } from '../src/hashing.js';

export async function baselineExecutionFixture(dependency = 'numpy') {
  const f = await baselineStageFixture(dependency),
    templateId = crypto.randomUUID(),
    now = f.clock().toISOString(),
    expiresAt = '2026-10-31T00:00:00.000Z';
  f.docs.documents.set('configuration/source_dispatch', {
    templateEvidenceId: templateId,
    lifetimeSeconds: 60,
    maximumOutputBytes: 4096,
    maximumElements: 100,
  });
  f.docs.documents.set(`sandboxTemplates/${templateId}`, {
    schemaVersion: '1.0',
    id: templateId,
    templateId: 'authored-source',
    role: 'source',
    imageDigest: 'c'.repeat(64),
    runtimeDigest: 'd'.repeat(64),
    verifiedAt: now,
    expiresAt,
    networkIsolationVerified: true,
    privateAccessVerified: true,
    resourceLimitsVerified: true,
    singlePrivateBuildVerified: true,
    microUsdPerSecondCeiling: 10,
  });
  f.docs.documents.set('configuration/e2b_credits', {
    schemaVersion: '1.0',
    evidenceId: crypto.randomUUID(),
    allocationMicroUsd: 20000,
    availableMicroUsd: 20000,
    accountedSpentMicroUsd: 0,
    verifiedAt: now,
    expiresAt,
  });
  for (const [key, limit] of [
    ['e2b_global_micro_usd', 10000],
    [`e2b_seconds_${f.fence.revisionId}`, 900],
    [`source_executions_${f.fence.revisionId}`, 8],
    ['class_a', 100],
  ] as const)
    f.docs.documents.set(`budgets/${key}`, {
      schemaVersion: '1.0',
      limit,
      reserved: 0,
      spent: 0,
      halted: false,
    });
  f.docs.documents.set('configuration/r2_class_a_period', {
    counterKey: 'class_a',
    startsAt: '2026-10-01T00:00:00Z',
    endsAt: '2026-11-01T00:00:00Z',
  });
  const profiles: string[] = [];
  const payload = 'authored unvalidated numeric transport',
    creates = vi.fn(async () => {
      const sandboxId = `authored-source-${crypto.randomUUID()}`;
      let request: ReturnType<typeof SourceJobRequest.parse>;
      return {
        sandboxId,
        sourceSession: {
          sandboxId,
          writeRequest: async (bytes: Uint8Array) => {
            request = SourceJobRequest.parse(
              JSON.parse(new TextDecoder().decode(bytes)),
            );
          },
          run: async (
            _signal: AbortSignal,
            profile: 'adapter_v1' | 'reference_v1',
          ) => {
            profiles.push(profile);
            return 0;
          },
          readManifest: async () =>
            new Response(
              JSON.stringify({
                schemaVersion: '1.0',
                operationId: request.operationId,
                inputDigest: request.inputDigest,
                adapterDigest: request.adapterDigest,
                executionProfile: 'runpy_main_root_v1',
                observations: await Promise.all(
                  request.mappings.map(async (mapping) => ({
                    key: mapping.key,
                    filename: `obs_${mapping.key}.npy`,
                    sha256: await sha256(payload),
                    bytes: payload.length,
                    shape: mapping.expectedShape,
                    dtype: 'float64',
                    declaredUnit: mapping.declaredUnit,
                  })),
                ),
              }),
            ).body!,
          readObservation: async () => new Response(payload).body!,
        },
      };
    }),
    kill = vi.fn(async () => true),
    jobs = new SandboxJobs(f.docs, f.clock),
    client = new E2bClient('authored-no-real-key', jobs, {
      create: creates,
      kill,
      verifyTemplate: vi.fn(async () => ({
        buildId: 'fixture-build',
        tagBuildId: 'fixture-build',
        buildCount: 1,
        isPrivate: true,
      })),
    });
  const putOnce = vi.fn(
    async (_key: string, bytes: Uint8Array, hash: string) => ({
      size: bytes.length,
      sha256: hash,
    }),
  );
  const pipeline = new SourcePipeline(
      new SourceExecutions(f.docs, f.clock),
      client,
    ),
    stage = new BaselineSourceStage(
      f.docs,
      { readBatch: f.readBatch },
      jobs,
      pipeline,
      new SourceOutputStore(f.docs, { putOnce }, f.clock),
      f.clock,
    );
  return { ...f, stage, creates, kill, putOnce, jobs, profiles };
}
