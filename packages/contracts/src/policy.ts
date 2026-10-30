import { z } from 'zod';
import { Count, SchemaVersion } from './common.js';

const PositiveCount = Count.refine((value) => value > 0);
export const ResourcePolicy = z
  .strictObject({
    schemaVersion: SchemaVersion,
    version: z.string().min(1).max(80),
    uploadFiles: PositiveCount,
    uploadBytes: PositiveCount,
    sourceBytes: PositiveCount,
    userActiveRevisions: PositiveCount,
    globalActiveRevisions: PositiveCount,
    userDailyAdmissions: PositiveCount,
    globalDailyAdmissions: PositiveCount,
    modelAttempts: PositiveCount,
    modelRevisionMicroUsd: PositiveCount,
    modelInputTokens: PositiveCount,
    modelOutputTokens: PositiveCount,
    metaAllocationMicroUsd: PositiveCount,
    metaDispatchCeilingMicroUsd: PositiveCount,
    metaHeadroomMicroUsd: PositiveCount,
    sourceExecutions: PositiveCount,
    sandboxSeconds: PositiveCount,
    sandboxLifetimeSeconds: PositiveCount,
    outputBytes: PositiveCount,
    heatCells: PositiveCount,
    orbitalBodies: PositiveCount,
    storageBytes: PositiveCount,
    monthlyClassA: PositiveCount,
    monthlyClassB: PositiveCount,
    requestsPerMinute: PositiveCount,
    mutationsPerMinute: PositiveCount,
    e2bAllocationBasisPoints: z.number().int().min(1).max(10000),
    progressIntervalSeconds: PositiveCount,
    progressEvents: PositiveCount,
  })
  .superRefine((value, ctx) => {
    const constrain = (condition: boolean, path: string, message: string) => {
      if (!condition) ctx.addIssue({ code: 'custom', path: [path], message });
    };
    constrain(
      value.sourceBytes <= value.uploadBytes,
      'sourceBytes',
      'Must fit upload cap',
    );
    constrain(
      value.userActiveRevisions <= value.globalActiveRevisions,
      'userActiveRevisions',
      'Must fit global slots',
    );
    constrain(
      value.userDailyAdmissions <= value.globalDailyAdmissions,
      'userDailyAdmissions',
      'Must fit global admissions',
    );
    constrain(
      value.metaDispatchCeilingMicroUsd <=
        value.metaAllocationMicroUsd - value.metaHeadroomMicroUsd,
      'metaDispatchCeilingMicroUsd',
      'Must preserve Meta headroom',
    );
    constrain(
      value.sandboxLifetimeSeconds <= value.sandboxSeconds,
      'sandboxLifetimeSeconds',
      'Must fit cumulative time',
    );
    constrain(
      value.mutationsPerMinute <= value.requestsPerMinute,
      'mutationsPerMinute',
      'Mutations also count as requests',
    );
  });
export type ResourcePolicy = z.infer<typeof ResourcePolicy>;

// Canonical Product LIM-01..12 defaults. Scientific tolerances never live here.
export const DEFAULT_POLICY: Readonly<ResourcePolicy> = Object.freeze(
  ResourcePolicy.parse({
    schemaVersion: '1.0',
    version: '2026-10-27.1',
    uploadFiles: 10,
    uploadBytes: 5 * 1024 ** 2,
    sourceBytes: 128 * 1024,
    userActiveRevisions: 1,
    globalActiveRevisions: 3,
    userDailyAdmissions: 3,
    globalDailyAdmissions: 20,
    modelAttempts: 8,
    modelRevisionMicroUsd: 2_000_000,
    modelInputTokens: 24_000,
    modelOutputTokens: 4_000,
    metaAllocationMicroUsd: 150_000_000,
    metaDispatchCeilingMicroUsd: 135_000_000,
    metaHeadroomMicroUsd: 15_000_000,
    sourceExecutions: 8,
    sandboxSeconds: 900,
    sandboxLifetimeSeconds: 180,
    outputBytes: 50 * 1024 ** 2,
    heatCells: 65_536,
    orbitalBodies: 32,
    storageBytes: 2 * 1024 ** 3,
    monthlyClassA: 50_000,
    monthlyClassB: 250_000,
    requestsPerMinute: 60,
    mutationsPerMinute: 10,
    e2bAllocationBasisPoints: 9000,
    progressIntervalSeconds: 5,
    progressEvents: 200,
  }),
);

export function metaDispatchAllowance(
  verifiedAvailableMicroUsd: number,
  policy = DEFAULT_POLICY,
): number {
  Count.parse(verifiedAvailableMicroUsd);
  return Math.max(
    0,
    Math.min(
      policy.metaDispatchCeilingMicroUsd,
      verifiedAvailableMicroUsd - policy.metaHeadroomMicroUsd,
    ),
  );
}

export function e2bDispatchAllowance(
  verifiedAvailableMicroUsd: number,
  policy = DEFAULT_POLICY,
): number {
  Count.parse(verifiedAvailableMicroUsd);
  return Number(
    (BigInt(verifiedAvailableMicroUsd) *
      BigInt(policy.e2bAllocationBasisPoints)) /
      10000n,
  );
}
