import { z } from 'zod';
import { Id, SchemaVersion, Timestamp } from './common.js';

export const CancellationReceipt = z.strictObject({
  schemaVersion: SchemaVersion,
  auditId: Id,
  revisionId: Id,
  requestedAt: Timestamp,
  cleanup: z.enum(['pending', 'confirmed']),
});
export type CancellationReceipt = z.infer<typeof CancellationReceipt>;

export const DeletionReceipt = z.strictObject({
  schemaVersion: SchemaVersion,
  auditId: Id,
  requestedAt: Timestamp,
  cleanup: z.enum(['pending', 'confirmed']),
});
export type DeletionReceipt = z.infer<typeof DeletionReceipt>;
