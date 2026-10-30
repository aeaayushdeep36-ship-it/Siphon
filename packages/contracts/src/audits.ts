import { z } from 'zod';
import { Domain, Id, SchemaVersion, Timestamp } from './common.js';

export const CreateAudit = z.strictObject({
  schemaVersion: SchemaVersion,
  domain: Domain,
  title: z.string().trim().min(1).max(160),
});
export const Audit = z.strictObject({
  schemaVersion: SchemaVersion,
  id: Id,
  ownerUid: z.string().min(1).max(128),
  title: z.string().min(1).max(160),
  domain: Domain,
  currentRevisionId: Id,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  deletionRequestedAt: Timestamp.nullable(),
});
export type Audit = z.infer<typeof Audit>;
export type CreateAudit = z.infer<typeof CreateAudit>;
