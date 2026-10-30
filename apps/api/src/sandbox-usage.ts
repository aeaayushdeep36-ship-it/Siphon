import { z } from 'zod';
import { Count, Digest, Id, Timestamp } from '@siphon/contracts';

/** Written only by a trusted provider reconciler; never accepted from an audit user.
 * Shape validation does not establish provider authenticity or finality.
 */
export const SandboxUsageEvidence = z.strictObject({
  schemaVersion: z.literal('1.0'),
  id: Id,
  operationId: Id,
  sandboxId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  requestDigest: Digest,
  sourceEvidenceDigest: Digest,
  billableSeconds: Count,
  chargedMicroUsd: Count,
  finalizedAt: Timestamp,
});
