import { z } from 'zod';
import { Count, Digest, Id, SchemaVersion, Timestamp } from './common.js';

export const AiDisclosureConfiguration = z.strictObject({
  provider: z.literal('groq'),
  model: z.string().min(1).max(200),
  endpoint: z.string().url().max(500),
  noticeVersion: z.literal('groq_audit_disclosure.v1'),
  scopes: z.tuple([
    z.literal('source_context'),
    z.literal('source_adapter'),
    z.literal('numeric_investigation'),
  ]),
});

export const AiDisclosureSnapshot = z.strictObject({
  configuration: AiDisclosureConfiguration,
  disclosureDigest: Digest,
  status: z.enum(['required', 'accepted', 'revoked']),
  acceptedAt: Timestamp.nullable(),
});

export const SubmitAiDisclosure = z.strictObject({
  schemaVersion: SchemaVersion,
  expectedGeneration: Count,
  expectedInputDigest: Digest,
  disclosureDigest: Digest,
  decision: z.enum(['accept', 'revoke']),
});

export const AiDisclosureReceipt = z.strictObject({
  schemaVersion: SchemaVersion,
  auditId: Id,
  revisionId: Id,
  disclosureDigest: Digest,
  decision: z.enum(['accept', 'revoke']),
  replayed: z.boolean(),
});

export type AiDisclosureConfiguration = z.infer<
  typeof AiDisclosureConfiguration
>;
export type AiDisclosureSnapshot = z.infer<typeof AiDisclosureSnapshot>;
