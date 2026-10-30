import { z } from 'zod';
import {
  Count,
  Digest,
  Id,
  ResourcePolicy,
  SchemaVersion,
  Timestamp,
} from '@siphon/contracts';
import { BudgetCounter, Operation } from './accounting.js';
import { type DocumentStore } from './firestore.js';
import { requireActiveRevision } from './audit-commands.js';
import { canonicalJson, sha256 } from './hashing.js';
import { MetaPricing, reserveMetaCost } from './meta-pricing.js';
import { MetaFailure, usageSchema } from './meta-client.js';
import { FirestoreAccountingStore } from './firestore-accounting.js';
import { confirmModelOperationEnded } from './admission.js';
import {
  settleModelCompletion,
  type ModelCompletion,
} from './meta-settlement.js';

export const ModelJob = z.strictObject({
  schemaVersion: SchemaVersion,
  operationId: Id,
  requestDigest: Digest,
  pricing: MetaPricing,
  inputTokenBound: Count,
  outputTokenBound: Count,
  tokenizerEvidenceId: Id,
  pricingDigest: Digest,
  createdAt: Timestamp,
});
export class ModelJobs {
  constructor(
    private readonly documents: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Called by the trusted dispatch gate after reservation and before dispatch.
   * The evidence ID identifies verified full-request token counting; it is not
   * itself proof. The future gate must produce/validate that evidence.
   */
  async bind(
    operationId: string,
    inputTokenBound: number,
    outputTokenBound: number,
    tokenizerEvidenceId: string,
  ) {
    Id.parse(operationId);
    Id.parse(tokenizerEvidenceId);
    return this.documents.transaction(async (tx) => {
      const operation = Operation.parse(
        await tx.get(`operations/${operationId}`),
      );
      await requireActiveRevision(tx, operation.ownerUid, {
        auditId: operation.auditId,
        revisionId: operation.revisionId,
        inputDigest: operation.inputDigest,
        generation: operation.fence,
      });
      const revision = await tx.get(
        `audits/${operation.auditId}/revisions/${operation.revisionId}`,
      );
      const saved = await tx.get(`modelJobs/${operationId}`);
      if (saved) {
        const job = ModelJob.parse(saved);
        if (
          job.requestDigest !== operation.requestDigest ||
          job.inputTokenBound !== inputTokenBound ||
          job.outputTokenBound !== outputTokenBound ||
          job.tokenizerEvidenceId !== tokenizerEvidenceId
        )
          throw new Error('Model job binding conflict');
        return job;
      }
      if (operation.outcome !== 'reserved')
        throw new Error('Cannot bind pricing after dispatch');
      const pricing = MetaPricing.parse(
        await tx.get('configuration/meta_pricing'),
      );
      pricing.verifiedAt = new Date(pricing.verifiedAt).toISOString();
      pricing.effectiveFrom = new Date(pricing.effectiveFrom).toISOString();
      pricing.effectiveUntil = new Date(pricing.effectiveUntil).toISOString();
      const policy = ResourcePolicy.parse(revision?.policy);
      if (
        inputTokenBound > policy.modelInputTokens ||
        outputTokenBound > policy.modelOutputTokens
      )
        throw new Error('Model token policy exceeded');
      const now = this.clock();
      const cost = reserveMetaCost(
        pricing,
        inputTokenBound,
        outputTokenBound,
        now,
      );
      const monetary = operation.charges.filter(
        (charge) => charge.unit === 'micro_usd',
      );
      if (
        monetary.length < 2 ||
        monetary.some(
          (charge) =>
            charge.consumeOnDispatch || charge.amount !== cost.microUsd,
        )
      )
        throw new Error('Reservation does not match model pricing');
      const job = ModelJob.parse({
        schemaVersion: '1.0',
        operationId,
        requestDigest: operation.requestDigest,
        pricing,
        pricingDigest: await sha256(canonicalJson(pricing)),
        inputTokenBound,
        outputTokenBound,
        tokenizerEvidenceId,
        createdAt: now.toISOString(),
      });
      tx.set(`modelJobs/${operationId}`, {
        ...job,
        pricing: {
          ...job.pricing,
          verifiedAt: new Date(job.pricing.verifiedAt),
          effectiveFrom: new Date(job.pricing.effectiveFrom),
          effectiveUntil: new Date(job.pricing.effectiveUntil),
        },
        createdAt: now,
      });
      return job;
    });
  }

  async settle(operationId: string, completion: ModelCompletion) {
    Id.parse(operationId);
    const { operation, job } = await this.documents.transaction(async (tx) => {
      const operation = Operation.parse(
        await tx.get(`operations/${operationId}`),
      );
      const job = ModelJob.parse(await tx.get(`modelJobs/${operationId}`));
      if (
        job.operationId !== operation.id ||
        job.requestDigest !== operation.requestDigest ||
        job.pricingDigest !== (await sha256(canonicalJson(job.pricing)))
      )
        throw new Error('Model job integrity mismatch');
      return { operation, job };
    });
    const usage =
      completion.kind === 'succeeded'
        ? completion.usage
        : completion.failure.usage;
    if (usage) usageSchema.parse(usage);
    if (
      !['dispatching', 'unknown', 'succeeded', 'failed'].includes(
        operation.outcome,
      )
    )
      throw new Error('Model operation was not dispatched');
    if (
      usage &&
      (usage.prompt_tokens > job.inputTokenBound ||
        usage.completion_tokens > job.outputTokenBound)
    ) {
      completion = {
        kind: 'failed',
        failure: new MetaFailure('usage_exceeded', usage),
      };
      // Persist the stop before monetary settlement; a cheap token overrun is
      // still a violated dispatch bound. Counters require explicit reconciliation.
      await this.documents.transaction(async (tx) => {
        const persisted = Operation.parse(
          await tx.get(`operations/${operationId}`),
        );
        if (
          persisted.requestDigest !== operation.requestDigest ||
          JSON.stringify(persisted.charges) !==
            JSON.stringify(operation.charges)
        )
          throw new Error('Operation changed before token-overrun halt');
        const counters = [];
        for (const charge of persisted.charges) {
          if (charge.unit === 'micro_usd')
            counters.push({
              key: charge.counterKey,
              value: BudgetCounter.parse(
                await tx.get(`budgets/${charge.counterKey}`),
              ),
            });
        }
        for (const counter of counters)
          tx.set(`budgets/${counter.key}`, { ...counter.value, halted: true });
        tx.set(`modelIncidents/${operationId}`, {
          schemaVersion: '1.0',
          operationId,
          ownerUid: operation.ownerUid,
          auditId: operation.auditId,
          revisionId: operation.revisionId,
          code: 'token_bound_exceeded',
          inputTokenBound: job.inputTokenBound,
          outputTokenBound: job.outputTokenBound,
          observedInputTokens: usage.prompt_tokens,
          observedOutputTokens: usage.completion_tokens,
          updatedAt: this.clock(),
        });
      });
    }
    await settleModelCompletion(
      new FirestoreAccountingStore(this.documents),
      operation,
      job.pricing,
      completion,
      this.clock().toISOString(),
    );
    if (usage)
      await confirmModelOperationEnded(
        this.documents,
        operationId,
        this.clock(),
      );
  }
}
