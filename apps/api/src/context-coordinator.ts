import { z } from 'zod';
import {
  ContextProposal,
  Id,
  Question,
  QuestionSet,
  ResourcePolicy,
  DEFAULT_POLICY,
  metaDispatchAllowance,
} from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import { type ArtifactDownloadService } from './artifact-download.js';
import {
  DispatchFence,
  authorize,
  requireActiveRevision,
  stateFrom,
} from './audit-commands.js';
import { ContextSourceReviews } from './context-source-reviews.js';
import { ContextTasks, ContextTask } from './context-tasks.js';
import {
  ContextTokenCounts,
  MetaCountingVerification,
} from './context-token-counts.js';
import {
  ContextBillingBounds,
  MetaBillingProfileVerification,
} from './context-billing-bound.js';
import { ContextPipeline } from './context-pipeline.js';
import { ContextClarification } from './context-clarification.js';
import { QuestionPublisher } from './question-publication.js';
import { ModelJobs } from './model-jobs.js';
import { MetaCreditEvidence } from './context-model-gate.js';
import { MetaPricing, reserveMetaCost } from './meta-pricing.js';
import { AdmissionRepository } from './admission.js';
import { BudgetCounter, Operation, reserveOperation } from './accounting.js';
import { FirestoreAccountingStore } from './firestore-accounting.js';
import { canonicalJson, sha256 } from './hashing.js';
import { type AiConfiguration } from './ai-config.js';
import { GroqAdmissionBlocked, GroqModelJobs } from './groq-model-jobs.js';
import { MetaRequest } from './meta-client.js';

type Fence = z.infer<typeof DispatchFence>;
const ContextQuestionDraft = QuestionSet.safeExtend({
  questions: z.array(Question).max(20),
});
type ContextQuestionDraft = z.infer<typeof ContextQuestionDraft>;
export type ContextQuestionHook = (snapshot: {
  proposal: ContextProposal;
  baseQuestions: ContextQuestionDraft;
  fence: Fence;
}) => Promise<z.infer<typeof Question>[]>;

/** Concrete inspection -> disclosed context -> bounded provider operation ->
 * settlement -> immutable context/questions continuation. Configured Groq calls
 * reserve free-tier quotas; the legacy Meta path is retained for existing fixtures.
 * The caller supplies stable IDs; replays cannot issue another provider request. */
export class ContextCoordinator {
  constructor(
    private readonly store: DocumentStore,
    private readonly downloads: Pick<ArtifactDownloadService, 'readBatch'>,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date(),
    private readonly supplementalQuestions?: ContextQuestionHook,
    private readonly aiConfig?: AiConfiguration,
  ) {}

  private async snapshot(uid: string, expected: Fence) {
    return this.store.transaction(async (tx) => {
      await authorize(tx, uid, expected.auditId, false);
      const base = `audits/${expected.auditId}/revisions/${expected.revisionId}`;
      const [revision, context, questions] = await tx.getMany([
        base,
        `${base}/context/current`,
        `${base}/questions/current`,
      ]);
      if (
        revision?.ownerUid !== uid ||
        revision.inputDigest !== expected.inputDigest
      )
        throw new Error('Context coordinator revision mismatch');
      const state = stateFrom(revision);
      const fence = {
        auditId: state.auditId,
        revisionId: state.revisionId,
        generation: state.generation,
        inputDigest: state.inputDigest,
      };
      if (state.status === 'waiting_for_input' && questions)
        return { status: 'waiting_for_input' as const, fence, context };
      await requireActiveRevision(tx, uid, expected);
      if (!['inspecting', 'clarifying'].includes(state.stage))
        throw new Error('Context coordinator requires inspecting stage');
      return { status: 'running' as const, fence, context };
    });
  }

  private async configuration(uid: string, fence: Fence) {
    return this.store.transaction(async (tx) => {
      await requireActiveRevision(tx, uid, fence);
      const [rawCounting, rawBilling, rawPricing, rawCredits] =
        await tx.getMany([
          'configuration/meta_counting',
          'configuration/meta_billing_profile',
          'configuration/meta_pricing',
          'configuration/meta_credits',
        ]);
      const missing = [
        ['meta_counting', rawCounting],
        ['meta_billing_profile', rawBilling],
        ['meta_pricing', rawPricing],
        ['meta_credits', rawCredits],
      ]
        .filter(([, value]) => !value)
        .map(([name]) => name);
      if (missing.length)
        return {
          status: 'blocked' as const,
          code: 'meta_verification_required',
          required: missing,
        };
      const counting = MetaCountingVerification.parse(rawCounting),
        billing = MetaBillingProfileVerification.parse(rawBilling),
        pricing = MetaPricing.parse(rawPricing),
        credits = MetaCreditEvidence.parse(rawCredits),
        now = this.clock().getTime();
      if (
        billing.countingVerificationDigest !==
          (await sha256(canonicalJson(counting))) ||
        Math.max(
          Date.parse(counting.verifiedAt),
          Date.parse(billing.verifiedAt),
          Date.parse(pricing.verifiedAt),
          Date.parse(credits.verifiedAt),
        ) > now ||
        Math.min(
          Date.parse(counting.expiresAt),
          Date.parse(billing.expiresAt),
          Date.parse(pricing.effectiveUntil),
          Date.parse(credits.expiresAt),
        ) <=
          now + 70000
      )
        return {
          status: 'blocked' as const,
          code: 'meta_verification_expired',
          required: [
            'current provider counting, billing profile, pricing and credit evidence',
          ],
        };
      return { status: 'ready' as const, pricing, credits };
    });
  }

  async run(
    uid: string,
    expected: unknown,
    ids: { countId: string; operationId: string; tokenEvidenceId: string },
    signal?: AbortSignal,
  ) {
    const fence = DispatchFence.parse(expected);
    Object.values(ids).forEach((value) => Id.parse(value));
    const current = await this.snapshot(uid, fence);
    if (current.status === 'waiting_for_input')
      return { status: current.status, fence: current.fence };
    if (current.context)
      return this.continue(uid, fence, Id.parse(current.context.operationId));
    const savedOperation = await this.store.get(
      `operations/${ids.operationId}`,
    );
    if (savedOperation && savedOperation.outcome !== 'reserved')
      return {
        status: 'blocked' as const,
        fence,
        code: 'context_operation_requires_reconciliation',
        required: ['reconcile existing model operation; do not redispatch'],
      };
    if (!this.apiKey.trim())
      return {
        status: 'blocked' as const,
        fence,
        code: this.aiConfig
          ? 'ai_credentials_required'
          : 'meta_credentials_required',
        required: [this.aiConfig ? 'Groq API key' : 'Meta API key'],
      };
    if (this.aiConfig) {
      const reviewed = await new ContextSourceReviews(
        this.store,
        this.downloads,
        this.clock,
        this.aiConfig,
      ).loadAndReview(uid, fence, signal);
      if (reviewed.status === 'blocked')
        return {
          status: 'blocked' as const,
          fence,
          code: 'source_disclosure_blocked',
          findings: reviewed.findings,
        };
      const prepared = await new ContextTasks(
        this.store,
        this.clock,
        undefined,
        this.aiConfig,
      ).prepare(uid, fence, reviewed.sources);
      try {
        await new GroqModelJobs(
          this.store,
          this.apiKey,
          this.aiConfig,
          this.fetcher,
          this.clock,
        ).run(uid, fence, ids.operationId, prepared, 'context', signal);
      } catch (error) {
        if (!(error instanceof GroqAdmissionBlocked)) throw error;
        return {
          status: 'blocked' as const,
          fence,
          code: error.code,
          required: [
            'Review the configured AI allowance or existing operation before resuming.',
          ],
        };
      }
      return this.continue(uid, fence, ids.operationId);
    }
    const configuration = await this.configuration(uid, fence);
    if (configuration.status === 'blocked') return { ...configuration, fence };
    const reviewed = await new ContextSourceReviews(
      this.store,
      this.downloads,
      this.clock,
    ).loadAndReview(uid, fence, signal);
    if (reviewed.status === 'blocked')
      return {
        status: 'blocked' as const,
        fence,
        code: 'source_disclosure_blocked',
        findings: reviewed.findings,
      };
    const tasks = new ContextTasks(this.store, this.clock),
      prepared = await tasks.prepare(uid, fence, reviewed.sources),
      request = MetaRequest.parse(prepared.request);
    const deadline = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(180000)])
      : AbortSignal.timeout(180000);
    await new ContextTokenCounts(
      this.store,
      this.apiKey,
      this.fetcher,
      this.clock,
    ).measure(uid, fence, ids.countId, reviewed.sources, deadline);
    const bound = await new ContextBillingBounds(
      this.store,
      this.clock,
    ).produce(
      uid,
      fence,
      ids.countId,
      ids.tokenEvidenceId,
      prepared.requestDigest,
    );
    const revision = await this.store.get(
        `audits/${fence.auditId}/revisions/${fence.revisionId}`,
      ),
      policy = ResourcePolicy.parse(revision?.policy);
    const outputTokens = request.max_output_tokens;
    const cost = reserveMetaCost(
      configuration.pricing,
      bound.inputTokenUpperBound,
      outputTokens,
      this.clock(),
    ).microUsd;
    await this.initializeCounters(uid, fence, policy, configuration.credits);
    await new AdmissionRepository(this.store, this.clock).acquire(uid, fence);
    const operation = Operation.parse({
      schemaVersion: '1.0',
      id: ids.operationId,
      ownerUid: uid,
      auditId: fence.auditId,
      revisionId: fence.revisionId,
      inputDigest: fence.inputDigest,
      requestDigest: prepared.requestDigest,
      fence: fence.generation,
      outcome: 'reserved',
      usage: null,
      providerHandle: null,
      charges: [
        {
          counterKey: 'meta_global_micro_usd',
          amount: cost,
          unit: 'micro_usd',
          consumeOnDispatch: false,
        },
        {
          counterKey: `meta_revision_${fence.revisionId}`,
          amount: cost,
          unit: 'micro_usd',
          consumeOnDispatch: false,
        },
        {
          counterKey: `model_attempts_${fence.revisionId}`,
          amount: 1,
          unit: 'attempts',
          consumeOnDispatch: true,
        },
      ],
      createdAt: this.clock().toISOString(),
      updatedAt: this.clock().toISOString(),
    });
    await reserveOperation(new FirestoreAccountingStore(this.store), operation);
    await tasks.bind(uid, fence, ids.operationId, reviewed.sources);
    await new ModelJobs(this.store, this.clock).bind(
      ids.operationId,
      bound.inputTokenUpperBound,
      outputTokens,
      ids.tokenEvidenceId,
    );
    await new ContextPipeline(
      this.store,
      this.apiKey,
      this.fetcher,
      this.clock,
    ).run(ids.operationId, request, deadline);
    return this.continue(uid, fence, ids.operationId);
  }

  private async initializeCounters(
    uid: string,
    fence: Fence,
    policy: ResourcePolicy,
    credits: z.infer<typeof MetaCreditEvidence>,
  ) {
    await this.store.transaction(async (tx) => {
      await requireActiveRevision(tx, uid, fence);
      const keys = [
        'meta_global_micro_usd',
        `meta_revision_${fence.revisionId}`,
        `model_attempts_${fence.revisionId}`,
      ];
      const counters = await tx.getMany(keys.map((key) => `budgets/${key}`));
      const globalLimit = Math.min(
        metaDispatchAllowance(credits.allocationMicroUsd, policy),
        metaDispatchAllowance(credits.allocationMicroUsd),
        credits.accountedSpentMicroUsd +
          Math.min(
            metaDispatchAllowance(credits.availableMicroUsd, policy),
            metaDispatchAllowance(credits.availableMicroUsd),
          ),
      );
      const limits = [
        globalLimit,
        Math.min(
          policy.modelRevisionMicroUsd,
          DEFAULT_POLICY.modelRevisionMicroUsd,
        ),
        Math.min(policy.modelAttempts, DEFAULT_POLICY.modelAttempts),
      ];
      const values = counters.map((value, index) =>
        value
          ? BudgetCounter.parse(value)
          : BudgetCounter.parse({
              schemaVersion: '1.0',
              limit: limits[index],
              spent: index === 0 ? credits.accountedSpentMicroUsd : 0,
              reserved: 0,
              halted: false,
            }),
      );
      for (const [index, value] of values.entries())
        if (!counters[index]) tx.set(`budgets/${keys[index]}`, value);
    });
  }

  private async continue(uid: string, fence: Fence, operationId: string) {
    const base = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
    const prepared = await this.store.transaction(async (tx) => {
      await requireActiveRevision(tx, uid, fence);
      const [
        context,
        resolution,
        continuation,
        revision,
        rawOperation,
        rawTask,
      ] = await tx.getMany([
        `${base}/context/current`,
        `${base}/contextAnswerResolution/current`,
        `contextContinuations/${operationId}`,
        base,
        `operations/${operationId}`,
        `contextTasks/${operationId}`,
      ]);
      const operation = Operation.parse(rawOperation),
        task = ContextTask.parse(rawTask);
      const proposal = ContextProposal.parse(context?.proposal);
      if (
        context?.ownerUid !== uid ||
        context.operationId !== operationId ||
        context.inputDigest !== fence.inputDigest ||
        context.proposalDigest !== (await sha256(canonicalJson(proposal)))
      )
        throw new Error('Context continuation integrity failure');
      if (
        operation.id !== operationId ||
        operation.ownerUid !== uid ||
        operation.auditId !== fence.auditId ||
        operation.revisionId !== fence.revisionId ||
        operation.inputDigest !== fence.inputDigest ||
        operation.fence !== fence.generation ||
        operation.outcome !== 'succeeded' ||
        !operation.usage ||
        task.operationId !== operationId ||
        task.requestDigest !== operation.requestDigest ||
        task.ownerUid !== uid ||
        task.auditId !== fence.auditId ||
        task.revisionId !== fence.revisionId ||
        task.inputDigest !== fence.inputDigest ||
        task.generation !== fence.generation ||
        revision?.activeOperationId != null
      )
        throw new Error(
          'Context continuation lacks settled exact model operation',
        );
      const baseQuestions = resolution
        ? resolution.questionDraft === null
          ? ContextQuestionDraft.parse({
              schemaVersion: '1.0',
              auditId: fence.auditId,
              revisionId: fence.revisionId,
              inputDigest: fence.inputDigest,
              questions: [],
            })
          : QuestionSet.parse(resolution.questionDraft)
        : QuestionSet.parse(context.questionDraft);
      if (
        resolution &&
        (resolution.ownerUid !== uid ||
          resolution.inputDigest !== fence.inputDigest ||
          resolution.auditId !== fence.auditId ||
          resolution.revisionId !== fence.revisionId)
      )
        throw new Error('Answer resolution snapshot mismatch');
      if (
        resolution &&
        (resolution.resolutionDigest !==
          (await sha256(
            canonicalJson(
              Object.fromEntries(
                Object.entries(resolution).filter(
                  ([key]) =>
                    ![
                      'ownerUid',
                      'resolutionDigest',
                      'createdAt',
                      'updatedAt',
                    ].includes(key),
                ),
              ),
            ),
          )) ||
          resolution.sourceManifestDigest !==
            (await sha256(canonicalJson(revision?.sourceManifest))) ||
          resolution.allUserDeclarationsResolved !==
            (resolution.questionDraft === null))
      )
        throw new Error('Answer resolution integrity failure');
      return {
        proposal,
        baseQuestions,
        continuation,
        defaultOnly: !resolution && !this.supplementalQuestions,
        leaseId: revision?.slotLeaseId,
      };
    });
    if (prepared.defaultOnly) {
      const result = await new ContextClarification(
        this.store,
        this.clock,
      ).publish(operationId);
      return {
        status: 'waiting_for_input' as const,
        fence: { ...fence, generation: result.receipt.generation },
        questionSetDigest: result.receipt.questionSetDigest,
      };
    }
    let questions: ContextQuestionDraft;
    if (prepared.continuation)
      questions = ContextQuestionDraft.parse(prepared.continuation.questions);
    else {
      const supplemental = this.supplementalQuestions
        ? await this.supplementalQuestions({
            proposal: prepared.proposal,
            baseQuestions: prepared.baseQuestions,
            fence,
          })
        : [];
      questions = ContextQuestionDraft.parse({
        ...prepared.baseQuestions,
        questions: [...prepared.baseQuestions.questions, ...supplemental],
      });
      if (
        new Set(questions.questions.map((question) => question.key)).size !==
        questions.questions.length
      )
        throw new Error('Duplicate supplemental question keys');
      await this.store.transaction(async (tx) => {
        await requireActiveRevision(tx, uid, fence);
        const previous = await tx.get(`contextContinuations/${operationId}`);
        if (
          previous &&
          canonicalJson(previous.questions) !== canonicalJson(questions)
        )
          throw new Error('Context question continuation is immutable');
        if (!previous)
          tx.set(`contextContinuations/${operationId}`, {
            schemaVersion: '1.0',
            operationId,
            ownerUid: uid,
            ...fence,
            questions,
            questionsDigest: await sha256(canonicalJson(questions)),
            createdAt: this.clock(),
          });
      });
    }
    if (!questions.questions.length)
      return {
        status: 'continue' as const,
        fence,
        contextDigest: await sha256(canonicalJson(prepared.proposal)),
      };
    if (prepared.leaseId != null)
      await new AdmissionRepository(this.store, this.clock).releaseReconciled(
        uid,
        fence,
        String(prepared.leaseId),
      );
    const result = await new QuestionPublisher(this.store, this.clock).publish(
      uid,
      fence,
      questions,
      `context_extended_${operationId}`,
    );
    return {
      status: 'waiting_for_input' as const,
      fence: { ...fence, generation: result.receipt.generation },
      questionSetDigest: result.receipt.questionSetDigest,
    };
  }
}
