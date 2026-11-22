import { z } from 'zod';
import {
  AiDisclosureConfiguration,
  AiDisclosureReceipt,
  AiDisclosureSnapshot,
  Digest,
  Id,
  SubmitAiDisclosure,
  Timestamp,
} from '@siphon/contracts';
import type { DocumentStore, DocumentTransaction } from './firestore.js';
import {
  authorize,
  nativeTimestamps,
  receiptKey,
  stateFrom,
} from './audit-commands.js';
import type { AiConfiguration } from './ai-config.js';
import { ApiError } from './errors.js';
import { canonicalJson, sha256 } from './hashing.js';

const AiDisclosureRecord = z.strictObject({
  schemaVersion: z.literal('1.0'),
  ownerUid: z.string().min(1).max(128),
  auditId: Id,
  revisionId: Id,
  inputDigest: Digest,
  disclosureDigest: Digest,
  decision: z.enum(['accepted', 'revoked']),
  acceptedAt: Timestamp.nullable(),
  updatedAt: Timestamp,
});

export type AiDisclosureOptions = z.infer<typeof AiDisclosureConfiguration>;

export function aiDisclosureOptions(
  config: Pick<AiConfiguration, 'provider' | 'model' | 'endpoint'>,
): AiDisclosureOptions {
  return AiDisclosureConfiguration.parse({
    provider: config.provider,
    model: config.model,
    endpoint: config.endpoint,
    noticeVersion: 'groq_audit_disclosure.v1',
    scopes: ['source_context', 'source_adapter', 'numeric_investigation'],
  });
}

export async function aiDisclosureDigest(
  configuration: AiDisclosureOptions,
): Promise<string> {
  return sha256(canonicalJson(AiDisclosureConfiguration.parse(configuration)));
}

export async function readAiDisclosureSnapshot(
  tx: DocumentTransaction | DocumentStore,
  uid: string,
  auditId: string,
  revisionId: string,
  inputDigest: string,
  configuration: AiDisclosureOptions | null,
) {
  if (!configuration) return null;
  const disclosureHash = await aiDisclosureDigest(configuration);
  const record = await tx.get(
    `audits/${auditId}/revisions/${revisionId}/aiDisclosure/current`,
  );
  let status: 'required' | 'accepted' | 'revoked' = 'required';
  let acceptedAt: string | null = null;
  if (record) {
    const saved = AiDisclosureRecord.parse(record);
    if (
      saved.ownerUid !== uid ||
      saved.auditId !== auditId ||
      saved.revisionId !== revisionId
    )
      throw new Error('AI disclosure ownership mismatch');
    if (
      saved.inputDigest === inputDigest &&
      saved.disclosureDigest === disclosureHash
    ) {
      status = saved.decision;
      acceptedAt = saved.acceptedAt;
    }
  }
  return AiDisclosureSnapshot.parse({
    configuration,
    disclosureDigest: disclosureHash,
    status,
    acceptedAt,
  });
}

/** Called inside the same transaction that authorizes the provider dispatch. */
export async function hasCurrentAiDisclosure(
  tx: DocumentTransaction,
  uid: string,
  auditId: string,
  revisionId: string,
  inputDigest: string,
  configuration: AiDisclosureOptions,
) {
  const snapshot = await readAiDisclosureSnapshot(
    tx,
    uid,
    auditId,
    revisionId,
    inputDigest,
    configuration,
  );
  return snapshot?.status === 'accepted';
}

export class AiDisclosureConsents {
  constructor(
    private readonly documents: DocumentStore,
    private readonly configuration: AiDisclosureOptions,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async submit(
    uid: string,
    auditId: string,
    revisionId: string,
    value: unknown,
    key: string,
  ) {
    Id.parse(auditId);
    Id.parse(revisionId);
    const input = SubmitAiDisclosure.parse(value),
      disclosureHash = await aiDisclosureDigest(this.configuration);
    if (input.disclosureDigest !== disclosureHash)
      throw new ApiError(
        409,
        'ai_disclosure_changed',
        'AI disclosure settings changed. Review the current notice and retry.',
      );
    const requestId = await receiptKey(
      uid,
      `POST /audits/${auditId}/revisions/${revisionId}/ai-disclosure`,
      key,
    );
    const now = this.clock(),
      base = `audits/${auditId}/revisions/${revisionId}`;
    return this.documents.transaction(async (tx) => {
      const audit = await authorize(tx, uid, auditId, false);
      const [revision, previous, saved] = await tx.getMany([
        base,
        `requests/${requestId}`,
        `${base}/aiDisclosure/current`,
      ]);
      if (!revision || revision.ownerUid !== uid)
        throw new ApiError(404, 'not_found', 'Revision was not found.');
      const state = stateFrom(revision);
      if (
        audit.currentRevisionId !== revisionId ||
        state.auditId !== auditId ||
        state.revisionId !== revisionId ||
        state.generation !== input.expectedGeneration ||
        state.inputDigest !== input.expectedInputDigest ||
        state.cancellationRequestedAt !== null ||
        ['completed', 'partial', 'failed', 'cancelled', 'unsupported'].includes(
          state.status,
        )
      )
        throw new ApiError(
          409,
          'stale_revision',
          'Only the current active revision can change AI disclosure consent.',
        );
      if (previous) {
        const receipt = AiDisclosureReceipt.parse(previous.result);
        if (
          receipt.auditId !== auditId ||
          receipt.revisionId !== revisionId ||
          receipt.disclosureDigest !== disclosureHash ||
          receipt.decision !== input.decision
        )
          throw new Error('AI disclosure idempotency receipt mismatch');
        return AiDisclosureReceipt.parse({ ...receipt, replayed: true });
      }
      const prior = saved ? AiDisclosureRecord.parse(saved) : null;
      if (
        prior &&
        (prior.ownerUid !== uid ||
          prior.auditId !== auditId ||
          prior.revisionId !== revisionId)
      )
        throw new Error('AI disclosure ownership mismatch');
      const decision = input.decision === 'accept' ? 'accepted' : 'revoked';
      const acceptedAt =
        decision === 'accepted'
          ? now.toISOString()
          : prior?.inputDigest === input.expectedInputDigest &&
              prior.disclosureDigest === disclosureHash
            ? prior.acceptedAt
            : null;
      const record = AiDisclosureRecord.parse({
        schemaVersion: '1.0',
        ownerUid: uid,
        auditId,
        revisionId,
        inputDigest: input.expectedInputDigest,
        disclosureDigest: disclosureHash,
        decision,
        acceptedAt,
        updatedAt: now.toISOString(),
      });
      const receipt = AiDisclosureReceipt.parse({
        schemaVersion: '1.0',
        auditId,
        revisionId,
        disclosureDigest: disclosureHash,
        decision: input.decision,
        replayed: false,
      });
      tx.set(`${base}/aiDisclosure/current`, nativeTimestamps(record));
      tx.set(`requests/${requestId}`, {
        schemaVersion: '1.0',
        ownerUid: uid,
        auditId,
        result: receipt,
        createdAt: now,
        updatedAt: now,
      });
      return receipt;
    });
  }
}
