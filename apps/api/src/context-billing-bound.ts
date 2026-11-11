import { LEGACY_META_MODEL } from './legacy-meta-profile.js';
import { z } from 'zod';
import {
  Count,
  Digest,
  Id,
  Timestamp,
  DEFAULT_POLICY,
  ResourcePolicy,
} from '@siphon/contracts';
import { type DocumentStore, type DocumentTransaction } from './firestore.js';
import {
  DispatchFence,
  requireActiveRevision,
  nativeTimestamps,
} from './audit-commands.js';
import {
  ContextTokenMeasurement,
  MetaCountingVerification,
} from './context-token-counts.js';
import { canonicalJson, sha256 } from './hashing.js';

/** Operator/provider evidence, never automatically attested from one successful
 * usage sample. Multiplier/additive must upper-bound billed input for this exact
 * stateless text/JSON no-tools profile throughout the verified tokenizer window. */
export const MetaBillingProfileVerification = z.strictObject({
  schemaVersion: z.literal('1.0'),
  model: z.literal(LEGACY_META_MODEL),
  protocol: z.literal('responses.v1'),
  profile: z.literal('stateless_text_json_no_tools.v1'),
  countingVerificationDigest: Digest,
  inputTokenMultiplier: Count.refine((n) => n > 0),
  additionalInputTokens: Count,
  maximumIterations: z.literal(1),
  outputIncludesReasoning: z.literal(true),
  tokenizerVersion: z.string().min(1).max(100),
  evidenceDigest: Digest,
  verifiedAt: Timestamp,
  expiresAt: Timestamp,
});

const Proof = z.strictObject({
  schemaVersion: z.literal('1.0'),
  id: Id,
  countId: Id,
  ownerUid: z.string(),
  auditId: Id,
  revisionId: Id,
  inputDigest: Digest,
  generation: Count,
  requestDigest: Digest,
  profileDigest: Digest,
  measurementDigest: Digest,
  methodEvidenceDigest: Digest,
  inputTokenUpperBound: Count.refine((n) => n > 0),
  createdAt: Timestamp,
});

/** Creates billing evidence only from a real persisted count and externally
 * verified billing rule. It cannot provide the operator verification itself. */
export class ContextBillingBounds {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async produce(
    uid: string,
    expected: unknown,
    countId: string,
    tokenEvidenceId: string,
    requestDigest: string,
  ) {
    const fence = DispatchFence.parse(expected);
    Id.parse(countId);
    Id.parse(tokenEvidenceId);
    Digest.parse(requestDigest);
    return this.store.transaction(async (tx) => {
      await requireActiveRevision(tx, uid, fence);
      const [job, rawProfile, rawCounting, revision, priorProof, priorToken] =
        await tx.getMany([
          `modelTokenCountJobs/${countId}`,
          'configuration/meta_billing_profile',
          'configuration/meta_counting',
          `audits/${fence.auditId}/revisions/${fence.revisionId}`,
          `modelTokenProofs/${tokenEvidenceId}`,
          `modelTokenEvidence/${tokenEvidenceId}`,
        ]);
      const profile = MetaBillingProfileVerification.parse(rawProfile),
        counting = MetaCountingVerification.parse(rawCounting);
      const measurement = ContextTokenMeasurement.parse(job?.result),
        policy = ResourcePolicy.parse(revision?.policy),
        now = this.clock();
      const profileDigest = await sha256(canonicalJson(profile)),
        measurementDigest = await sha256(canonicalJson(measurement));
      if (
        job?.status !== 'measured' ||
        job.id !== countId ||
        job.requestDigest !== requestDigest ||
        measurement.id !== countId ||
        measurement.ownerUid !== uid ||
        measurement.auditId !== fence.auditId ||
        measurement.revisionId !== fence.revisionId ||
        measurement.inputDigest !== fence.inputDigest ||
        measurement.generation !== fence.generation ||
        measurement.requestDigest !== requestDigest ||
        !measurement.withinInputPolicy ||
        measurement.verificationDigest !== profile.countingVerificationDigest ||
        (await sha256(canonicalJson(counting))) !==
          profile.countingVerificationDigest ||
        Date.parse(measurement.measuredAt) > now.getTime() ||
        Date.parse(measurement.expiresAt) <= now.getTime() ||
        Date.parse(profile.verifiedAt) > now.getTime() ||
        Date.parse(profile.expiresAt) <= now.getTime() + 60000
      )
        throw new Error(
          'Verified Meta billing rule/count does not cover this request',
        );
      const bound =
        BigInt(measurement.inputTokens) * BigInt(profile.inputTokenMultiplier) +
        BigInt(profile.additionalInputTokens);
      if (
        bound >
        BigInt(
          Math.min(policy.modelInputTokens, DEFAULT_POLICY.modelInputTokens),
        )
      )
        throw new Error('Billable input bound exceeds model policy');
      const methodEvidenceDigest = await sha256(
        canonicalJson({ profileDigest, measurementDigest, requestDigest }),
      );
      const token = {
        schemaVersion: '1.0',
        id: tokenEvidenceId,
        requestDigest,
        model: profile.model,
        inputTokenUpperBound: Number(bound),
        tokenizerVersion: profile.tokenizerVersion,
        methodEvidenceDigest,
        verifiedAt: now.toISOString(),
        expiresAt: profile.expiresAt,
      };
      const proof = Proof.parse({
        schemaVersion: '1.0',
        id: tokenEvidenceId,
        countId,
        ownerUid: uid,
        ...fence,
        requestDigest,
        profileDigest,
        measurementDigest,
        methodEvidenceDigest,
        inputTokenUpperBound: Number(bound),
        createdAt: now.toISOString(),
      });
      if (priorProof || priorToken) {
        const old = Proof.parse(priorProof);
        if (
          !priorToken ||
          canonicalJson({ ...old, createdAt: null }) !==
            canonicalJson({ ...proof, createdAt: null }) ||
          priorToken.methodEvidenceDigest !== methodEvidenceDigest ||
          priorToken.inputTokenUpperBound !== Number(bound) ||
          priorToken.expiresAt !== profile.expiresAt
        )
          throw new Error('Model billing evidence is immutable');
        return { evidence: priorToken, inputTokenUpperBound: Number(bound) };
      }
      tx.set(`modelTokenEvidence/${tokenEvidenceId}`, nativeTimestamps(token));
      tx.set(`modelTokenProofs/${tokenEvidenceId}`, nativeTimestamps(proof));
      return { evidence: token, inputTokenUpperBound: Number(bound) };
    });
  }
}

/** Called inside model dispatch transaction to reject expired/replaced billing
 * profiles. A proof is a derivation journal; authority stays with real count and
 * required operator/provider profile evidence, never an arbitrary boolean. */
export async function requireContextBillingProof(
  tx: DocumentTransaction,
  tokenEvidenceId: string,
  requestDigest: string,
  uid: string,
  expected: z.infer<typeof DispatchFence>,
  now: Date,
) {
  const [rawProof, rawProfile] = await tx.getMany([
    `modelTokenProofs/${tokenEvidenceId}`,
    'configuration/meta_billing_profile',
  ]);
  const proof = Proof.parse(rawProof),
    profile = MetaBillingProfileVerification.parse(rawProfile);
  const [rawCount, rawCounting] = await tx.getMany([
    `modelTokenCountJobs/${proof.countId}`,
    'configuration/meta_counting',
  ]);
  const counting = MetaCountingVerification.parse(rawCounting),
    measurement = ContextTokenMeasurement.parse(rawCount?.result);
  const profileDigest = await sha256(canonicalJson(profile)),
    measurementDigest = await sha256(canonicalJson(measurement));
  const bound =
    BigInt(measurement.inputTokens) * BigInt(profile.inputTokenMultiplier) +
    BigInt(profile.additionalInputTokens);
  if (
    proof.id !== tokenEvidenceId ||
    proof.ownerUid !== uid ||
    proof.auditId !== expected.auditId ||
    proof.revisionId !== expected.revisionId ||
    proof.inputDigest !== expected.inputDigest ||
    proof.generation !== expected.generation ||
    proof.requestDigest !== requestDigest ||
    proof.profileDigest !== profileDigest ||
    proof.measurementDigest !== measurementDigest ||
    proof.methodEvidenceDigest !==
      (await sha256(
        canonicalJson({ profileDigest, measurementDigest, requestDigest }),
      )) ||
    BigInt(proof.inputTokenUpperBound) !== bound ||
    rawCount?.status !== 'measured' ||
    measurement.id !== proof.countId ||
    measurement.ownerUid !== uid ||
    measurement.auditId !== expected.auditId ||
    measurement.revisionId !== expected.revisionId ||
    measurement.inputDigest !== expected.inputDigest ||
    measurement.generation !== expected.generation ||
    measurement.requestDigest !== requestDigest ||
    measurement.verificationDigest !== profile.countingVerificationDigest ||
    (await sha256(canonicalJson(counting))) !==
      profile.countingVerificationDigest ||
    Date.parse(profile.verifiedAt) > now.getTime() ||
    Date.parse(profile.expiresAt) <= now.getTime() + 60000 ||
    Date.parse(proof.createdAt) >= Date.parse(measurement.expiresAt) ||
    Date.parse(proof.createdAt) < Date.parse(measurement.measuredAt)
  )
    throw new Error('Model billing proof no longer covers dispatch');
  return proof;
}
