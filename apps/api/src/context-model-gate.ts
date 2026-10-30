import { z } from 'zod';
import {
  Count,
  Digest,
  Id,
  Timestamp,
  ResourcePolicy,
  DEFAULT_POLICY,
  metaDispatchAllowance,
} from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import {
  ContextTask,
  requireContextSourceDisclosure,
} from './context-tasks.js';
import { ModelJob } from './model-jobs.js';
import { MetaRequest, type MetaDispatchGate } from './meta-client.js';
import { MetaPricing, reserveMetaCost } from './meta-pricing.js';
import { FirestoreAccountingStore } from './firestore-accounting.js';
import { Operation, BudgetCounter, markDispatching } from './accounting.js';
import { canonicalJson, sha256 } from './hashing.js';
import { requireContextBillingProof } from './context-billing-bound.js';
import { AdapterTask } from './adapter-tasks.js';
import { ContextProposal } from '@siphon/contracts';

/** Trusted full-request billing bound. A provider-rendered context measurement
 * is not this evidence. A verified billing-bound producer is still required;
 * bytes/characters or an unverified count-to-billing assumption cannot grant it.
 */
export const ModelTokenEvidence = z.strictObject({
  schemaVersion: z.literal('1.0'),
  id: Id,
  requestDigest: Digest,
  model: z.literal('muse-wonder-1.0'),
  inputTokenUpperBound: Count.refine((n) => n > 0),
  tokenizerVersion: z.string().min(1).max(100),
  methodEvidenceDigest: Digest,
  verifiedAt: Timestamp,
  expiresAt: Timestamp,
});
export const MetaCreditEvidence = z.strictObject({
  schemaVersion: z.literal('1.0'),
  evidenceId: Id,
  allocationMicroUsd: Count,
  availableMicroUsd: Count,
  accountedSpentMicroUsd: Count,
  verifiedAt: Timestamp,
  expiresAt: Timestamp,
});

/** One context operation only. Validation executes within accounting dispatch. */
export class ContextModelGate implements MetaDispatchGate {
  constructor(
    private readonly documents: DocumentStore,
    private readonly operationId: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly purpose: 'context' | 'adapter' = 'context',
  ) {
    Id.parse(operationId);
  }
  async authorize(value: MetaRequest, claimedDigest: string) {
    const request = MetaRequest.parse(value);
    const digest = await sha256(canonicalJson(request));
    if (digest !== Digest.parse(claimedDigest))
      throw new Error('Model request digest mismatch');
    const original = Operation.parse(
      await this.documents.get(`operations/${this.operationId}`),
    );
    let inputTokenBound = 0;
    const accounting = new FirestoreAccountingStore(
      this.documents,
      DEFAULT_POLICY,
      async (tx, operation) => {
        const now = this.clock();
        const deadline = now.getTime() + 60000;
        const rawTask = await tx.get(
          `${this.purpose === 'adapter' ? 'adapterTasks' : 'contextTasks'}/${operation.id}`,
        );
        const task =
          this.purpose === 'adapter'
            ? AdapterTask.parse(rawTask)
            : ContextTask.parse(rawTask);
        if ('contextDigest' in task) {
          const context = await tx.get(
            `audits/${operation.auditId}/revisions/${operation.revisionId}/context/current`,
          );
          const proposal = ContextProposal.parse(context?.proposal);
          if (
            context?.ownerUid !== operation.ownerUid ||
            context.inputDigest !== operation.inputDigest ||
            context.proposalDigest !== task.contextDigest ||
            (await sha256(canonicalJson(proposal))) !== task.contextDigest
          )
            throw new Error('Adapter request context changed');
        }
        const job = ModelJob.parse(await tx.get(`modelJobs/${operation.id}`));
        const tokens = ModelTokenEvidence.parse(
          await tx.get(`modelTokenEvidence/${job.tokenizerEvidenceId}`),
        );
        const credits = MetaCreditEvidence.parse(
          await tx.get('configuration/meta_credits'),
        );
        const price = MetaPricing.parse(
          await tx.get('configuration/meta_pricing'),
        );
        const revision = await tx.get(
          `audits/${operation.auditId}/revisions/${operation.revisionId}`,
        );
        const policy = ResourcePolicy.parse(revision?.policy);
        const proof = await requireContextBillingProof(
          tx,
          job.tokenizerEvidenceId,
          digest,
          operation.ownerUid,
          {
            auditId: operation.auditId,
            revisionId: operation.revisionId,
            generation: operation.fence,
            inputDigest: operation.inputDigest,
          },
          now,
        );
        price.verifiedAt = new Date(price.verifiedAt).toISOString();
        price.effectiveFrom = new Date(price.effectiveFrom).toISOString();
        price.effectiveUntil = new Date(price.effectiveUntil).toISOString();
        if (
          task.operationId !== operation.id ||
          task.ownerUid !== operation.ownerUid ||
          task.auditId !== operation.auditId ||
          task.revisionId !== operation.revisionId ||
          task.inputDigest !== operation.inputDigest ||
          task.generation !== operation.fence ||
          task.requestDigest !== digest ||
          operation.requestDigest !== digest ||
          job.operationId !== operation.id ||
          job.requestDigest !== digest ||
          tokens.id !== job.tokenizerEvidenceId ||
          tokens.methodEvidenceDigest !== proof.methodEvidenceDigest ||
          tokens.inputTokenUpperBound !== proof.inputTokenUpperBound ||
          tokens.requestDigest !== digest ||
          tokens.inputTokenUpperBound !== job.inputTokenBound ||
          job.outputTokenBound !== request.max_output_tokens ||
          job.pricingDigest !== (await sha256(canonicalJson(job.pricing))) ||
          job.pricingDigest !== (await sha256(canonicalJson(price)))
        )
          throw new Error(
            'Context model request, token evidence or pricing binding changed',
          );
        if (
          Date.parse(tokens.verifiedAt) > now.getTime() ||
          Date.parse(credits.verifiedAt) > now.getTime() ||
          Math.min(
            Date.parse(tokens.expiresAt),
            Date.parse(credits.expiresAt),
            Date.parse(price.effectiveUntil),
          ) <= deadline ||
          job.inputTokenBound >
            Math.min(
              policy.modelInputTokens,
              DEFAULT_POLICY.modelInputTokens,
            ) ||
          job.outputTokenBound >
            Math.min(
              policy.modelOutputTokens,
              DEFAULT_POLICY.modelOutputTokens,
            ) ||
          !(
            this.purpose === 'adapter'
              ? ['adapting']
              : ['inspecting', 'clarifying']
          ).includes(String(revision?.stage))
        )
          throw new Error('Model verification does not cover this dispatch');
        await requireContextSourceDisclosure(
          tx,
          operation.ownerUid,
          operation.auditId,
          task.sources,
          now,
          new Date(deadline),
        );
        const cost = reserveMetaCost(
          price,
          job.inputTokenBound,
          job.outputTokenBound,
          now,
        ).microUsd;
        const charges = [
          {
            counterKey: 'meta_global_micro_usd',
            amount: cost,
            unit: 'micro_usd',
            consumeOnDispatch: false,
          },
          {
            counterKey: `meta_revision_${operation.revisionId}`,
            amount: cost,
            unit: 'micro_usd',
            consumeOnDispatch: false,
          },
          {
            counterKey: `model_attempts_${operation.revisionId}`,
            amount: 1,
            unit: 'attempts',
            consumeOnDispatch: true,
          },
        ];
        if (
          operation.charges.length !== charges.length ||
          charges.some(
            (charge) =>
              !operation.charges.some(
                (actual) => canonicalJson(actual) === canonicalJson(charge),
              ),
          )
        )
          throw new Error('Context model charge mapping is invalid');
        const global = BudgetCounter.parse(
          await tx.get('budgets/meta_global_micro_usd'),
        );
        const local = BudgetCounter.parse(
          await tx.get(`budgets/meta_revision_${operation.revisionId}`),
        );
        const attempts = BudgetCounter.parse(
          await tx.get(`budgets/model_attempts_${operation.revisionId}`),
        );
        if (
          global.limit >
            Math.min(
              metaDispatchAllowance(credits.allocationMicroUsd, policy),
              metaDispatchAllowance(credits.allocationMicroUsd),
            ) ||
          global.spent < credits.accountedSpentMicroUsd ||
          BigInt(global.spent - credits.accountedSpentMicroUsd) +
            BigInt(global.reserved) >
            BigInt(
              Math.min(
                metaDispatchAllowance(credits.availableMicroUsd, policy),
                metaDispatchAllowance(credits.availableMicroUsd),
              ),
            ) ||
          local.limit >
            Math.min(
              policy.modelRevisionMicroUsd,
              DEFAULT_POLICY.modelRevisionMicroUsd,
            ) ||
          attempts.limit >
            Math.min(policy.modelAttempts, DEFAULT_POLICY.modelAttempts)
        )
          throw new Error(
            'Verified Meta allowance does not cover this dispatch',
          );
        inputTokenBound = job.inputTokenBound;
      },
    );
    await markDispatching(
      accounting,
      this.operationId,
      original.fence,
      this.clock().toISOString(),
    );
    return { inputTokenBound };
  }
}
