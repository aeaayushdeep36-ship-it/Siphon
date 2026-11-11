import { z } from 'zod';
import { Count, Digest, Id, Timestamp } from '@siphon/contracts';
import { groqUsageSchema } from './groq-client.js';

/** Persisted Groq operation identity. Keep independent of stage runners so
 * downstream stage repositories can validate it without an import cycle. */
export const FreeModelJob = z.strictObject({
  schemaVersion: z.literal('1.0'),
  operationId: Id,
  requestDigest: Digest,
  provider: z.literal('groq'),
  model: z.string().min(1).max(200),
  endpoint: z.string().url(),
  configDigest: Digest,
  purpose: z.enum(['context', 'adapter', 'investigation']),
  inputTokenBound: Count,
  outputTokenBound: Count,
  admission: z.literal('request_bytes_screen_not_token_measurement.v1'),
  createdAt: Timestamp,
});

/** Sanitized provider outcome; credentials and provider response bodies never
 * belong in this receipt. */
export const FreeModelReceipt = z.strictObject({
  schemaVersion: z.literal('1.0'),
  operationId: Id,
  requestDigest: Digest,
  configDigest: Digest,
  provider: z.literal('groq'),
  model: z.string().min(1),
  endpoint: z.string().url(),
  providerId: z.string().min(1).max(300).nullable(),
  usage: groqUsageSchema.nullable(),
  outcome: z.enum(['succeeded', 'failed', 'unknown']),
  failureCode: z.string().min(1).max(80).nullable(),
  receivedAt: Timestamp,
});
