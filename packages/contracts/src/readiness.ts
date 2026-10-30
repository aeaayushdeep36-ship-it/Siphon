import { z } from 'zod';
import { Digest, Id, ReadinessStatus, SchemaVersion } from './common.js';
import { InspectionResult } from './inspection.js';

export const InspectedSource = z.strictObject({
  artifactId: Id,
  result: InspectionResult,
});
export const ReadinessFinding = z.strictObject({
  artifactId: Id.nullable(),
  code: z.enum([
    'upload_policy',
    'missing_inspection',
    'inspection_incomplete',
    'parse_failure',
    'dynamic_code_review',
    'dependency_review',
    'numeric_input_review',
    'source_privacy_review',
  ]),
  line: z.number().int().positive().nullable(),
});
export const InspectionGate = z.strictObject({
  schemaVersion: SchemaVersion,
  status: ReadinessStatus,
  sourceDigests: z
    .array(z.strictObject({ artifactId: Id, sha256: Digest }))
    .max(10),
  findings: z.array(ReadinessFinding).max(2000),
  next: z.enum(['resolve_inspection', 'review_requirements', 'unsupported']),
});
export type InspectionGate = z.infer<typeof InspectionGate>;
