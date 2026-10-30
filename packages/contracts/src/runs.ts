import { z } from 'zod';
import { Count, Digest, Id, SchemaVersion } from './common.js';

export const StartAudit = z.strictObject({
  schemaVersion: SchemaVersion,
  expectedGeneration: Count,
  expectedInputDigest: Digest,
});
export const QueuedAuditReceipt = z.strictObject({
  schemaVersion: SchemaVersion,
  jobId: Digest,
  auditId: Id,
  revisionId: Id,
  inputDigest: Digest,
  generation: Count,
  stage: z.literal('draft'),
  status: z.literal('queued'),
});
export type StartAudit = z.infer<typeof StartAudit>;
export type QueuedAuditReceipt = z.infer<typeof QueuedAuditReceipt>;
export const ResumedAuditReceipt = z.strictObject({
  schemaVersion: SchemaVersion,
  jobId: Digest,
  auditId: Id,
  revisionId: Id,
  status: z.literal('accepted'),
});
