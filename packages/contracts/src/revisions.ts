import { z } from 'zod';
import { Count, Digest, Id, SchemaVersion } from './common.js';

export const CreateRevision = z
  .strictObject({
    schemaVersion: SchemaVersion,
    parentRevisionId: Id,
    expectedGeneration: Count,
    expectedInputDigest: Digest,
    reuseArtifactIds: z.array(Id).max(10),
  })
  .refine(
    (value) =>
      new Set(value.reuseArtifactIds).size === value.reuseArtifactIds.length,
    {
      message: 'Artifact references must be unique',
      path: ['reuseArtifactIds'],
    },
  );
export type CreateRevision = z.infer<typeof CreateRevision>;

export const RevisionReceipt = z.strictObject({
  schemaVersion: SchemaVersion,
  auditId: Id,
  revisionId: Id,
  parentRevisionId: Id,
  inputDigest: Digest,
  stage: z.literal('draft'),
  status: z.literal('idle'),
});
export type RevisionReceipt = z.infer<typeof RevisionReceipt>;
