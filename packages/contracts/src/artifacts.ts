import { z } from 'zod';
import { Count, Digest, Id, SchemaVersion, Timestamp } from './common.js';
import { SafeUploadPath } from './uploads.js';

export const ReserveUpload = z.strictObject({
  schemaVersion: SchemaVersion,
  path: SafeUploadPath,
  bytes: Count,
  sha256: Digest,
  expectedGeneration: Count,
  expectedInputDigest: Digest,
});
export type ReserveUpload = z.infer<typeof ReserveUpload>;
export const UploadReservation = z.strictObject({
  schemaVersion: SchemaVersion,
  auditId: Id,
  revisionId: Id,
  artifactId: Id,
  path: SafeUploadPath,
  bytes: Count,
  sha256: Digest,
  generation: Count,
  inputDigest: Digest,
  lifecycle: z.literal('reserved'),
  uploadExpiresAt: Timestamp,
  expiresAt: Timestamp,
});
export type UploadReservation = z.infer<typeof UploadReservation>;
