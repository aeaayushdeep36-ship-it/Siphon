import { z } from 'zod';

export const SchemaVersion = z.literal('1.0');
export const Id = z.string().uuid();
export const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const Timestamp = z.iso.datetime({ offset: false });
export const Finite = z.number().finite();
export const Count = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const Domain = z.enum(['heat_diffusion', 'orbital_dynamics']);
export const AuditStage = z.enum([
  'draft',
  'inspecting',
  'clarifying',
  'adapting',
  'planning',
  'executing',
  'evaluating',
  'investigating',
  'reporting',
  'finished',
]);
export const RunStatus = z.enum([
  'idle',
  'queued',
  'running',
  'waiting_for_input',
  'completed',
  'partial',
  'failed',
  'cancelled',
  'unsupported',
]);
export const ReadinessStatus = z.enum(['ready', 'needs_input', 'unsupported']);
export const EligibilityStatus = z.enum([
  'eligible',
  'unresolved',
  'ineligible',
]);
export const EvidenceStatus = z.enum([
  'passed_within_tolerance',
  'flagged',
  'inconclusive',
  'not_applicable',
]);
export const CheckId = z.enum([
  'H_ENERGY',
  'H_BALANCE',
  'H_TIME_REF',
  'H_GRID_REF',
  'H_REFERENCE',
  'O_ENERGY',
  'O_ANGULAR',
  'O_MOMENTUM',
  'O_REFINE',
  'O_REFERENCE',
]);
export const SourceReference = z.strictObject({
  artifactId: Id,
  sourceDigest: Digest,
  line: z.number().int().positive(),
  description: z.string().min(1).max(500),
});
export const Provenance = z.strictObject({
  kind: z.enum(['code', 'config', 'user', 'inference', 'unknown']),
  verification: z.enum(['unverified', 'confirmed', 'conflicting']),
  references: z.array(SourceReference).max(20),
  explanation: z.string().max(1000),
});
export const Fact = z.strictObject({
  value: z.union([z.string().max(2000), Finite, z.boolean(), z.null()]),
  unit: z.string().min(1).max(80).nullable(),
  provenance: Provenance,
});
export type Domain = z.infer<typeof Domain>;
export type AuditStage = z.infer<typeof AuditStage>;
export type RunStatus = z.infer<typeof RunStatus>;
