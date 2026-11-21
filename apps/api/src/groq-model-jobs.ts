import { z } from 'zod';
import {
  AdapterProposal,
  ContextProposal,
  Count,
  Id,
  ResourcePolicy,
  Timestamp,
} from '@siphon/contracts';
import { type AiConfiguration } from './ai-config.js';
import {
  GroqClient,
  GroqFailure,
  GroqRequest,
  type GroqUsage,
} from './groq-client.js';
import { FreeModelJob, FreeModelReceipt } from './groq-model-contracts.js';
export { FreeModelJob, FreeModelReceipt } from './groq-model-contracts.js';
import { type DocumentStore } from './firestore.js';
import {
  DispatchFence,
  nativeTimestamps,
  requireActiveRevision,
} from './audit-commands.js';
import {
  AdmissionRepository,
  confirmModelOperationEnded,
} from './admission.js';
import {
  BudgetCounter,
  AccountingConflict,
  Operation,
  markDispatching,
  markUnknown,
  releaseUndispatched,
  reserveOperation,
  settleOperation,
} from './accounting.js';
import { FirestoreAccountingStore } from './firestore-accounting.js';
import { AdapterTask, AdapterTasks } from './adapter-tasks.js';
import {
  ContextTask,
  ContextTasks,
  requireContextSourceDisclosure,
} from './context-tasks.js';
import { canonicalJson, sha256 } from './hashing.js';
import { groqConfigurationDigest } from './groq-configuration-digest.js';
import { InvestigationDraft } from './investigation-draft.js';
import { prepareOwnedInvestigation } from './investigation-evidence.js';
import {
  InvestigationTask,
  InvestigationTasks,
  requireInvestigationTask,
} from './investigation-tasks.js';
export { groqConfigurationDigest } from './groq-configuration-digest.js';

const QuotaWindow = z.strictObject({
  entries: z.array(
    z.strictObject({ operationId: Id, dispatchedAt: Timestamp, tokens: Count }),
  ),
  blockedUntil: Timestamp.nullable(),
  halted: z.boolean(),
});
type SourcePrepared = Awaited<ReturnType<ContextTasks['prepare']>> & {
  contextDigest?: string;
};
type Prepared =
  SourcePrepared | Awaited<ReturnType<typeof prepareOwnedInvestigation>>;
type Purpose = 'context' | 'adapter' | 'investigation';
const WINDOW_MS = 60_000; // Rolling quota-window protocol; not a model setting.
const QUOTA_PATH = 'aiQuotaWindows/groq';

export class GroqAdmissionBlocked extends Error {
  constructor(
    public readonly code:
      | 'ai_request_too_large'
      | 'ai_quota_unavailable'
      | 'ai_operation_requires_reconciliation',
    public readonly retryAt: string | null = null,
  ) {
    super(code);
  }
}

/** Dedicated free-tier runner. Request bytes are an intentionally restrictive
 * admission screen, NOT a tokenizer or verified rendered-token measurement.
 * Reserve the complete configured input/output budget; provider-enforced limits
 * remain authoritative. Any observed overrun halts this provider for review.
 * Unknown outcomes retain reservations and cannot be automatically repeated. */
export class GroqModelJobs {
  constructor(
    private readonly documents: DocumentStore,
    private readonly apiKey: string,
    private readonly config: AiConfiguration,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async run(
    uid: string,
    expected: unknown,
    operationId: string,
    prepared: Prepared,
    purpose: Purpose,
    signal?: AbortSignal,
  ) {
    const fence = DispatchFence.parse(expected);
    try {
      return await this.runOnce(
        uid,
        fence,
        operationId,
        prepared,
        purpose,
        signal,
      );
    } catch (error) {
      if (error instanceof GroqAdmissionBlocked) {
        const revision = await this.documents.get(
          `audits/${fence.auditId}/revisions/${fence.revisionId}`,
        );
        if (
          revision?.slotLeaseId != null &&
          revision.activeOperationId == null
        ) {
          // This method rechecks the complete operation inventory atomically.
          // A racing/uncertain dispatch keeps its lease; a cooldown needs none.
          try {
            await new AdmissionRepository(
              this.documents,
              this.clock,
            ).releaseReconciled(uid, fence, Id.parse(revision.slotLeaseId));
          } catch {
            // No force release. A changed fence or pending operation retains capacity.
          }
        }
      }
      throw error;
    }
  }

  private async runOnce(
    uid: string,
    expected: unknown,
    operationId: string,
    prepared: Prepared,
    purpose: Purpose,
    signal?: AbortSignal,
  ) {
    const fence = DispatchFence.parse(expected);
    Id.parse(operationId);
    const request = GroqRequest.parse(prepared.request);
    const body = canonicalJson(request);
    const requestDigest = await sha256(body);
    if (
      requestDigest !== prepared.requestDigest ||
      request.model !== this.config.model ||
      new TextEncoder().encode(body).length >
        Math.min(this.config.maxRequestBytes, this.config.maxInputBytes)
    )
      throw new GroqAdmissionBlocked('ai_request_too_large');
    const configDigest = await groqConfigurationDigest(this.config);
    const sourceValues =
      'sourceValues' in prepared ? prepared.sourceValues : null;
    const evaluationId =
      'evaluationId' in prepared ? prepared.evaluationId : null;
    if (purpose !== 'investigation' && !sourceValues)
      throw new Error('Reviewed AI source bytes are required for binding');
    if (purpose === 'investigation' && !evaluationId)
      throw new Error(
        'Published investigation evidence is required for binding',
      );
    const now = this.clock();
    const revision = await this.documents.get(
      `audits/${fence.auditId}/revisions/${fence.revisionId}`,
    );
    const policy = ResourcePolicy.parse(revision?.policy);
    if (
      this.config.maxInputTokens > policy.modelInputTokens ||
      request.max_completion_tokens >
        Math.min(policy.modelOutputTokens, this.config.maxOutputTokens)
    )
      throw new Error('AI request exceeds revision policy');
    const inputTokenBound = this.config.maxInputTokens;
    const outputTokenBound = request.max_completion_tokens;
    const tokenReservation = inputTokenBound + outputTokenBound;
    if (
      !Number.isSafeInteger(tokenReservation) ||
      tokenReservation > this.config.tokensPerMinute
    )
      throw new Error('AI request exceeds configured token allowance');
    const day = now.toISOString().slice(0, 10).replaceAll('-', '');
    const charges = [
      {
        counterKey: `groq_requests_day_${day}`,
        amount: 1,
        unit: 'attempts' as const,
        consumeOnDispatch: true,
      },
      {
        counterKey: `groq_tokens_day_${day}`,
        amount: tokenReservation,
        unit: 'tokens' as const,
        consumeOnDispatch: false,
      },
      {
        counterKey: `model_attempts_${fence.revisionId}`,
        amount: 1,
        unit: 'attempts' as const,
        consumeOnDispatch: true,
      },
    ];
    const limits = [
      this.config.requestsPerDay,
      this.config.tokensPerDay,
      policy.modelAttempts,
    ];
    // Configure only these provider counters; never create fake monetary balances.
    await this.documents.transaction(async (tx) => {
      await requireActiveRevision(tx, uid, fence);
      const priorJob = await tx.get(`modelJobs/${operationId}`);
      const priorOperation = await tx.get(`operations/${operationId}`);
      const counters = await tx.getMany(
        charges.map((charge) => `budgets/${charge.counterKey}`),
      );
      if (priorOperation && priorOperation.outcome !== 'reserved')
        throw new GroqAdmissionBlocked('ai_operation_requires_reconciliation');
      if (priorJob) {
        const job = FreeModelJob.parse(priorJob);
        if (
          job.operationId !== operationId ||
          job.requestDigest !== requestDigest ||
          job.configDigest !== configDigest ||
          job.purpose !== purpose
        )
          throw new Error('AI configuration or request changed during replay');
      }
      for (const [index, raw] of counters.entries()) {
        const limit = limits[index]!;
        if (raw) {
          const value = BudgetCounter.parse(raw);
          if (value.limit > limit)
            throw new Error(
              'AI quota configuration reduced; reconcile existing counters',
            );
        } else
          tx.set(
            `budgets/${charges[index]!.counterKey}`,
            BudgetCounter.parse({
              schemaVersion: '1.0',
              limit,
              spent: 0,
              reserved: 0,
              halted: false,
            }),
          );
      }
    });
    await new AdmissionRepository(this.documents, this.clock).acquire(
      uid,
      fence,
    );
    const operation = Operation.parse({
      schemaVersion: '1.0',
      id: operationId,
      ownerUid: uid,
      auditId: fence.auditId,
      revisionId: fence.revisionId,
      inputDigest: fence.inputDigest,
      requestDigest,
      fence: fence.generation,
      outcome: 'reserved',
      usage: null,
      providerHandle: null,
      charges,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    const store = new FirestoreAccountingStore(this.documents, policy);
    try {
      await reserveOperation(store, operation);
    } catch (error) {
      if (
        error instanceof AccountingConflict &&
        error.code === 'budget_exhausted'
      )
        throw new GroqAdmissionBlocked('ai_quota_unavailable');
      if (
        error instanceof AccountingConflict &&
        error.code === 'operation_conflict'
      )
        throw new GroqAdmissionBlocked('ai_operation_requires_reconciliation');
      throw error;
    }
    // Rebuild and bind the request from its reviewed source or published evidence.
    try {
      if (purpose === 'investigation')
        await new InvestigationTasks(
          this.documents,
          this.config,
          this.clock,
        ).bind(uid, fence, operationId, evaluationId);
      else if (purpose === 'context')
        await new ContextTasks(
          this.documents,
          this.clock,
          undefined,
          this.config,
        ).bind(uid, fence, operationId, sourceValues);
      else
        await new AdapterTasks(this.documents, this.clock, this.config).bind(
          uid,
          fence,
          operationId,
          sourceValues,
        );
    } catch (error) {
      // Only an operation proven never dispatched may release its reservation.
      // A concurrent/unknown dispatch must remain reserved for reconciliation.
      try {
        await releaseUndispatched(
          store,
          operationId,
          fence.generation,
          this.clock().toISOString(),
        );
        const current = await this.documents.get(
          `audits/${fence.auditId}/revisions/${fence.revisionId}`,
        );
        if (current?.slotLeaseId != null && current.activeOperationId == null)
          await new AdmissionRepository(
            this.documents,
            this.clock,
          ).releaseReconciled(uid, fence, Id.parse(current.slotLeaseId));
      } catch {
        // Preserve any reservation or lease that cannot be safely released.
      }
      throw error;
    }
    const job = FreeModelJob.parse({
      schemaVersion: '1.0',
      operationId,
      requestDigest,
      provider: this.config.provider,
      model: this.config.model,
      endpoint: this.config.endpoint,
      configDigest,
      purpose,
      inputTokenBound,
      outputTokenBound,
      admission: 'request_bytes_screen_not_token_measurement.v1',
      createdAt: now.toISOString(),
    });
    await this.documents.transaction(async (tx) => {
      await requireActiveRevision(tx, uid, fence);
      const existing = await tx.get(`modelJobs/${operationId}`);
      if (
        existing &&
        canonicalJson({ ...FreeModelJob.parse(existing), createdAt: null }) !==
          canonicalJson({ ...job, createdAt: null })
      )
        throw new Error('AI job is immutable');
      if (!existing) tx.set(`modelJobs/${operationId}`, nativeTimestamps(job));
    });
    const gate = {
      authorize: async (value: GroqRequest, digest: string) => {
        if (digest !== requestDigest || canonicalJson(value) !== body)
          throw new Error('AI request changed');
        const accounting = new FirestoreAccountingStore(
          this.documents,
          policy,
          async (tx, actual) => {
            const time = this.clock();
            await requireActiveRevision(tx, uid, fence);
            const [rawTask, rawJob, rawWindow] = await tx.getMany([
              `${purpose === 'context' ? 'contextTasks' : purpose === 'adapter' ? 'adapterTasks' : 'investigationTasks'}/${operationId}`,
              `modelJobs/${operationId}`,
              QUOTA_PATH,
            ]);
            const task =
              purpose === 'context'
                ? ContextTask.parse(rawTask)
                : purpose === 'adapter'
                  ? AdapterTask.parse(rawTask)
                  : InvestigationTask.parse(rawTask);
            const savedJob = FreeModelJob.parse(rawJob);
            const quota = rawWindow
              ? QuotaWindow.parse(rawWindow)
              : { entries: [], blockedUntil: null, halted: false };
            if (
              actual.requestDigest !== digest ||
              actual.ownerUid !== uid ||
              actual.auditId !== fence.auditId ||
              actual.revisionId !== fence.revisionId ||
              actual.inputDigest !== fence.inputDigest ||
              actual.fence !== fence.generation ||
              task.operationId !== operationId ||
              task.ownerUid !== uid ||
              task.auditId !== fence.auditId ||
              task.revisionId !== fence.revisionId ||
              task.inputDigest !== fence.inputDigest ||
              task.generation !== fence.generation ||
              task.requestDigest !== digest ||
              canonicalJson(actual.charges) !== canonicalJson(charges) ||
              savedJob.configDigest !== configDigest ||
              savedJob.requestDigest !== digest ||
              savedJob.operationId !== operationId ||
              savedJob.model !== request.model ||
              savedJob.endpoint !== this.config.endpoint ||
              savedJob.purpose !== purpose ||
              savedJob.inputTokenBound !== inputTokenBound ||
              savedJob.outputTokenBound !== outputTokenBound
            )
              throw new Error('AI dispatch binding changed');
            if (time.toISOString().slice(0, 10).replaceAll('-', '') !== day)
              throw new GroqAdmissionBlocked(
                'ai_operation_requires_reconciliation',
              );
            if ('contextDigest' in task) {
              const currentContext = await tx.get(
                `audits/${fence.auditId}/revisions/${fence.revisionId}/context/current`,
              );
              if (
                currentContext?.ownerUid !== uid ||
                currentContext.inputDigest !== fence.inputDigest ||
                currentContext.proposalDigest !== task.contextDigest ||
                (await sha256(
                  canonicalJson(ContextProposal.parse(currentContext.proposal)),
                )) !== task.contextDigest
              )
                throw new Error('AI adapter context changed');
            }
            if ('sources' in task) {
              await requireContextSourceDisclosure(
                tx,
                uid,
                fence.auditId,
                task.sources,
                time,
                new Date(time.getTime() + this.config.requestTimeoutMs),
                this.config,
              );
            } else {
              const verified = await requireInvestigationTask(
                tx,
                uid,
                fence,
                operationId,
                this.config,
                ['reserved'],
                this.clock,
              );
              if (
                verified.prepared.requestDigest !== digest ||
                canonicalJson(verified.prepared.request) !== body
              )
                throw new Error('Investigation evidence disclosure changed');
            }
            const entries = quota.entries.filter(
              (entry) =>
                Date.parse(entry.dispatchedAt) > time.getTime() - WINDOW_MS,
            );
            if (
              quota.halted ||
              (quota.blockedUntil &&
                Date.parse(quota.blockedUntil) > time.getTime()) ||
              entries.some(
                (entry) => Date.parse(entry.dispatchedAt) > time.getTime(),
              ) ||
              entries.length >= this.config.requestsPerMinute ||
              entries.reduce((sum, entry) => sum + entry.tokens, 0) +
                tokenReservation >
                this.config.tokensPerMinute
            ) {
              const retryTime = quota.halted
                ? null
                : new Date(
                    Math.max(
                      time.getTime(),
                      quota.blockedUntil ? Date.parse(quota.blockedUntil) : 0,
                      ...entries.map(
                        (entry) => Date.parse(entry.dispatchedAt) + WINDOW_MS,
                      ),
                    ),
                  ).toISOString();
              throw new GroqAdmissionBlocked('ai_quota_unavailable', retryTime);
            }
            // prepareAdmissionDispatch still has reads to perform. Defer this write
            // until after every authorization read in its enclosing transaction.
            return () =>
              tx.set(QUOTA_PATH, {
                entries: [
                  ...entries,
                  {
                    operationId,
                    dispatchedAt: time.toISOString(),
                    tokens: tokenReservation,
                  },
                ],
                blockedUntil: quota.blockedUntil,
                halted: false,
              });
          },
        );
        await markDispatching(
          accounting,
          operationId,
          fence.generation,
          this.clock().toISOString(),
        );
        return { inputTokenBound };
      },
    };
    const client = new GroqClient(this.apiKey, this.config, gate, this.fetcher);
    let completed;
    try {
      completed =
        purpose === 'context'
          ? await client.complete(
              request,
              ContextProposal,
              signal ?? AbortSignal.timeout(this.config.requestTimeoutMs),
            )
          : purpose === 'adapter'
            ? await client.complete(
                request,
                AdapterProposal,
                signal ?? AbortSignal.timeout(this.config.requestTimeoutMs),
              )
            : await client.complete(
                request,
                InvestigationDraft,
                signal ?? AbortSignal.timeout(this.config.requestTimeoutMs),
              );
    } catch (error) {
      if (error instanceof GroqFailure)
        await this.settle(operation, error.usage, false, error);
      throw error;
    }
    await this.settle(
      operation,
      completed.usage,
      true,
      undefined,
      completed.providerId,
    );
    if (purpose === 'investigation')
      await new InvestigationTasks(
        this.documents,
        this.config,
        this.clock,
      ).storeDraft(uid, fence, operationId, completed.output);
    else if (purpose === 'context')
      await new ContextTasks(
        this.documents,
        this.clock,
        undefined,
        this.config,
      ).publish(operationId, completed.output);
    else
      await new AdapterTasks(this.documents, this.clock, this.config).publish(
        operationId,
        completed.output,
      );
    return { providerId: completed.providerId };
  }

  private async settle(
    operation: Operation,
    usage: GroqUsage | null,
    succeeded: boolean,
    failure?: GroqFailure,
    providerId: string | null = null,
  ) {
    const accounting = new FirestoreAccountingStore(this.documents);
    const now = this.clock();
    // Persist only sanitized provider provenance before settlement/publication.
    // The halt/cooldown shares this commit, so a crash cannot lose an overrun stop.
    await this.documents.transaction(async (tx) => {
      const [rawOperation, rawJob, priorReceipt, rawWindow] = await tx.getMany([
        `operations/${operation.id}`,
        `modelJobs/${operation.id}`,
        `modelReceipts/${operation.id}`,
        QUOTA_PATH,
      ]);
      const saved = Operation.parse(rawOperation);
      const job = FreeModelJob.parse(rawJob);
      if (
        saved.requestDigest !== operation.requestDigest ||
        saved.ownerUid !== operation.ownerUid ||
        saved.auditId !== operation.auditId ||
        saved.revisionId !== operation.revisionId ||
        saved.inputDigest !== operation.inputDigest ||
        saved.fence !== operation.fence ||
        !['dispatching', 'unknown', 'succeeded', 'failed'].includes(
          saved.outcome,
        ) ||
        job.operationId !== operation.id ||
        job.requestDigest !== operation.requestDigest
      )
        throw new Error('AI completion binding changed');
      const receipt = FreeModelReceipt.parse({
        schemaVersion: '1.0',
        operationId: operation.id,
        requestDigest: operation.requestDigest,
        configDigest: job.configDigest,
        provider: job.provider,
        model: job.model,
        endpoint: job.endpoint,
        providerId,
        usage,
        outcome: usage ? (succeeded ? 'succeeded' : 'failed') : 'unknown',
        failureCode: failure?.code ?? null,
        receivedAt: now.toISOString(),
      });
      if (
        priorReceipt &&
        canonicalJson({
          ...FreeModelReceipt.parse(priorReceipt),
          receivedAt: null,
        }) !== canonicalJson({ ...receipt, receivedAt: null })
      )
        throw new Error('AI completion receipt is immutable');
      if (!priorReceipt)
        tx.set(`modelReceipts/${operation.id}`, nativeTimestamps(receipt));
      if (failure?.retryAfterMs || failure?.code === 'usage_exceeded') {
        const quota = rawWindow
          ? QuotaWindow.parse(rawWindow)
          : { entries: [], blockedUntil: null, halted: false };
        tx.set(QUOTA_PATH, {
          ...quota,
          blockedUntil: failure.retryAfterMs
            ? new Date(
                Math.max(
                  quota.blockedUntil ? Date.parse(quota.blockedUntil) : 0,
                  now.getTime() + failure.retryAfterMs,
                ),
              ).toISOString()
            : quota.blockedUntil,
          halted: quota.halted || failure.code === 'usage_exceeded',
        });
      }
    });
    if (!usage) {
      await markUnknown(
        accounting,
        operation.id,
        operation.fence,
        now.toISOString(),
        null,
      );
    } else {
      await settleOperation(
        accounting,
        operation.id,
        operation.fence,
        Object.fromEntries(
          operation.charges.map((charge) => [
            charge.counterKey,
            charge.consumeOnDispatch ? charge.amount : usage.total_tokens,
          ]),
        ),
        succeeded ? 'succeeded' : 'failed',
        now.toISOString(),
      );
      await confirmModelOperationEnded(this.documents, operation.id, now);
    }
  }
}
