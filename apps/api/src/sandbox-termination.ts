import { z } from 'zod';
import { Digest, Id, Timestamp } from '@siphon/contracts';
/** Server observation of a control-plane response, never a user assertion. */
export const SandboxTermination = z.strictObject({
  schemaVersion: z.literal('1.0'),
  operationId: Id,
  sandboxId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  ownerUid: z.string(),
  auditId: Id,
  revisionId: Id,
  inputDigest: Digest,
  requestDigest: Digest,
  outcome: z.enum(['killed', 'not_found']),
  observedAt: Timestamp,
});
