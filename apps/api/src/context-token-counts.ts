import { LEGACY_META_MODEL } from './legacy-meta-profile.js';
import { z } from 'zod';
import {
  Count,
  DEFAULT_POLICY,
  Digest,
  Id,
  ResourcePolicy,
  Timestamp,
  UploadManifest,
} from '@siphon/contracts';
import { BudgetCounter } from './accounting.js';
import {
  DispatchFence,
  nativeTimestamps,
  requireActiveRevision,
} from './audit-commands.js';
import {
  ContextTask,
  ContextTasks,
  requireContextSourceDisclosure,
} from './context-tasks.js';
import { type DocumentStore, type DocumentTransaction } from './firestore.js';
import { canonicalJson, sha256 } from './hashing.js';
import { MetaTokenClient, MetaTokenFailure } from './meta-token-client.js';
import { AdapterTasks } from './adapter-tasks.js';

/** Operator-verified availability/charging terms, not an invented free-tier claim.
 * No production configuration writer or automatic verification is provided.
 */
export const MetaCountingVerification = z.strictObject({
  schemaVersion: z.literal('1.0'),
  model: z.literal(LEGACY_META_MODEL),
  protocol: z.literal('responses.v1'),
  profile: z.literal('stateless_text_json_no_tools.v1'),
  countingCharge: z.literal('no_charge'),
  evidenceDigest: Digest,
  verifiedAt: Timestamp,
  expiresAt: Timestamp,
});

export const ContextTokenMeasurement = z
  .strictObject({
    schemaVersion: z.literal('1.0'),
    id: Id,
    ownerUid: z.string().min(1).max(128),
    auditId: Id,
    revisionId: Id,
    inputDigest: Digest,
    generation: Count,
    requestDigest: Digest,
    model: z.literal(LEGACY_META_MODEL),
    protocol: z.literal('responses.v1'),
    measurement: z.literal('rendered_context'),
    verificationDigest: Digest,
    inputTokens: Count.refine((n) => n > 0),
    inputTokenLimit: Count.refine((n) => n > 0),
    withinInputPolicy: z.boolean(),
    measuredAt: Timestamp,
    expiresAt: Timestamp,
  })
  .refine(
    (value) =>
      value.withinInputPolicy === value.inputTokens <= value.inputTokenLimit &&
      Date.parse(value.expiresAt) > Date.parse(value.measuredAt),
  );

const CountJob = z
  .strictObject({
    schemaVersion: z.literal('1.0'),
    id: Id,
    invocationId: Id,
    ownerUid: z.string().min(1).max(128),
    auditId: Id,
    revisionId: Id,
    inputDigest: Digest,
    generation: Count,
    requestDigest: Digest,
    verificationDigest: Digest,
    sources: ContextTask.shape.sources,
    status: z.enum(['dispatching', 'measured', 'unknown']),
    result: ContextTokenMeasurement.nullable(),
    failureCode: z
      .enum([
        'transport_unknown',
        'http_error',
        'invalid_response',
        'publication_denied',
      ])
      .nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .refine((job) =>
    job.status === 'measured'
      ? job.result !== null && job.failureCode === null
      : job.result === null &&
        (job.status === 'unknown'
          ? job.failureCode !== null
          : job.failureCode === null),
  );

type Prepared = Awaited<ReturnType<ContextTasks['prepare']>>;
type Fence = z.infer<typeof DispatchFence>;
type Job = z.infer<typeof CountJob>;

/** Redacted boundary error; raw provider/validation causes may contain source. */
export class ContextCountUnavailable extends Error {
  constructor() {
    super('Context token count unavailable; no generation was authorized');
  }
}

/** Internal one-shot context counter. It never creates ModelTokenEvidence,
 * reserves money, dispatches inference or interprets counts as billable usage.
 */
export class ContextTokenCounts {
  constructor(
    private readonly documents: DocumentStore,
    private readonly apiKey: string,
    private readonly transport: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async verifySnapshot(
    tx: DocumentTransaction,
    uid: string,
    fence: Fence,
    prepared: Prepared,
    purpose: 'context' | 'adapter' = 'context',
  ) {
    const state = await requireActiveRevision(tx, uid, fence);
    const [revision, rawConfig] = await tx.getMany([
      `audits/${fence.auditId}/revisions/${fence.revisionId}`,
      'configuration/meta_counting',
    ]);
    const config = MetaCountingVerification.parse(rawConfig);
    const policy = ResourcePolicy.parse(revision?.policy);
    const now = this.clock();
    const deadline = new Date(now.getTime() + 10_000);
    if (
      !(
        purpose === 'adapter' ? ['adapting'] : ['inspecting', 'clarifying']
      ).includes(state.stage) ||
      Date.parse(config.verifiedAt) > now.getTime() ||
      Date.parse(config.expiresAt) <= deadline.getTime()
    )
      throw new Error('Meta counting verification does not cover this request');
    const manifest = UploadManifest.parse(revision?.sourceManifest).filter(
      (file) => file.path.endsWith('.py'),
    );
    if (
      manifest.length !== prepared.sources.length ||
      prepared.sources.some(
        (source) =>
          !manifest.some(
            (file) =>
              file.artifactId === source.artifactId &&
              file.sha256 === source.sourceDigest,
          ),
      )
    )
      throw new Error('Context count source snapshot changed');
    await requireContextSourceDisclosure(
      tx,
      uid,
      fence.auditId,
      prepared.sources,
      now,
      deadline,
    );
    return {
      policy,
      now,
      verificationDigest: await sha256(
        canonicalJson({
          ...config,
          verifiedAt: new Date(config.verifiedAt).toISOString(),
          expiresAt: new Date(config.expiresAt).toISOString(),
        }),
      ),
      configExpiresAt: config.expiresAt,
    };
  }

  private matchJob(job: Job, uid: string, fence: Fence, prepared: Prepared) {
    if (
      job.ownerUid !== uid ||
      job.auditId !== fence.auditId ||
      job.revisionId !== fence.revisionId ||
      job.inputDigest !== fence.inputDigest ||
      job.generation !== fence.generation ||
      job.requestDigest !== prepared.requestDigest ||
      canonicalJson(job.sources) !== canonicalJson(prepared.sources)
    )
      throw new Error('Context count job binding changed');
  }

  async measure(
    uid: string,
    expected: unknown,
    countId: string,
    sourceValues: unknown,
    signal: AbortSignal,
  ) {
    Id.parse(countId);
    const fence = DispatchFence.parse(expected);
    signal.throwIfAborted();
    const prepared = await new ContextTasks(this.documents, this.clock).prepare(
      uid,
      fence,
      sourceValues,
    );
    return this.measurePrepared(
      uid,
      fence,
      countId,
      prepared,
      signal,
      'context',
    );
  }
  async measureAdapter(
    uid: string,
    expected: unknown,
    countId: string,
    sourceValues: unknown,
    signal: AbortSignal,
  ) {
    Id.parse(countId);
    const fence = DispatchFence.parse(expected);
    signal.throwIfAborted();
    const prepared = await new AdapterTasks(this.documents, this.clock).prepare(
      uid,
      fence,
      sourceValues,
    );
    return this.measurePrepared(
      uid,
      fence,
      countId,
      prepared,
      signal,
      'adapter',
    );
  }
  private async measurePrepared(
    uid: string,
    fence: Fence,
    countId: string,
    prepared: Prepared,
    signal: AbortSignal,
    purpose: 'context' | 'adapter',
  ) {
    const path = `modelTokenCountJobs/${countId}`;
    const cached = await this.documents.get(path);
    if (cached)
      return this.documents.transaction(async (tx) => {
        const verified = await this.verifySnapshot(
          tx,
          uid,
          fence,
          prepared,
          purpose,
        );
        const job = CountJob.parse(await tx.get(path));
        this.matchJob(job, uid, fence, prepared);
        const result = job.result;
        if (
          job.id !== countId ||
          job.status !== 'measured' ||
          !result ||
          job.verificationDigest !== verified.verificationDigest ||
          result.id !== countId ||
          result.ownerUid !== uid ||
          result.auditId !== fence.auditId ||
          result.revisionId !== fence.revisionId ||
          result.generation !== fence.generation ||
          result.inputDigest !== fence.inputDigest ||
          result.requestDigest !== prepared.requestDigest ||
          result.verificationDigest !== verified.verificationDigest ||
          result.inputTokenLimit !==
            Math.min(
              verified.policy.modelInputTokens,
              DEFAULT_POLICY.modelInputTokens,
            ) ||
          Date.parse(result.measuredAt) > verified.now.getTime() ||
          Date.parse(result.expiresAt) <= verified.now.getTime() ||
          Date.parse(result.expiresAt) >
            Math.min(
              Date.parse(job.createdAt) + 60_000,
              Date.parse(verified.configExpiresAt),
            )
        )
          throw new Error(
            'Context count is not a fresh reusable measurement; do not retry its dispatch',
          );
        return { measurement: result, replayed: true };
      });

    const invocationId = crypto.randomUUID();
    let owned = false;
    const client = new MetaTokenClient(
      this.apiKey,
      {
        authorize: async (_request, requestDigest) => {
          if (requestDigest !== prepared.requestDigest)
            throw new Error('Context count request changed');
          await this.documents.transaction(async (tx) => {
            const verified = await this.verifySnapshot(
              tx,
              uid,
              fence,
              prepared,
              purpose,
            );
            const counterPath = `budgets/model_token_counts_${fence.revisionId}`;
            const [prior, rawCounter] = await tx.getMany([path, counterPath]);
            if (prior) throw new Error('Context count dispatch is single-use');
            const limit = Math.min(
              verified.policy.modelAttempts,
              DEFAULT_POLICY.modelAttempts,
            );
            const counter = rawCounter
              ? BudgetCounter.parse(rawCounter)
              : BudgetCounter.parse({
                  schemaVersion: '1.0',
                  limit,
                  reserved: 0,
                  spent: 0,
                  halted: false,
                });
            if (
              counter.limit > limit ||
              counter.halted ||
              counter.reserved !== 0 ||
              counter.spent >= counter.limit
            )
              throw new Error('Context token counting attempt limit reached');
            const job = CountJob.parse({
              schemaVersion: '1.0',
              id: countId,
              invocationId,
              ownerUid: uid,
              ...fence,
              requestDigest,
              verificationDigest: verified.verificationDigest,
              sources: prepared.sources,
              status: 'dispatching',
              result: null,
              failureCode: null,
              createdAt: verified.now.toISOString(),
              updatedAt: verified.now.toISOString(),
            });
            tx.set(counterPath, { ...counter, spent: counter.spent + 1 });
            tx.set(path, nativeTimestamps(job));
          });
          owned = true;
        },
      },
      this.transport,
    );
    try {
      const counted = await client.count(prepared.request, signal);
      return await this.documents.transaction(async (tx) => {
        signal.throwIfAborted();
        const verified = await this.verifySnapshot(
          tx,
          uid,
          fence,
          prepared,
          purpose,
        );
        const job = CountJob.parse(await tx.get(path));
        this.matchJob(job, uid, fence, prepared);
        if (
          job.id !== countId ||
          job.invocationId !== invocationId ||
          job.status !== 'dispatching' ||
          job.verificationDigest !== verified.verificationDigest ||
          counted.requestDigest !== job.requestDigest ||
          verified.now.getTime() >= Date.parse(job.createdAt) + 10_000
        )
          throw new Error(
            'Context token count publication is no longer authorized',
          );
        const limit = Math.min(
          verified.policy.modelInputTokens,
          DEFAULT_POLICY.modelInputTokens,
        );
        const measurement = ContextTokenMeasurement.parse({
          schemaVersion: '1.0',
          id: countId,
          ownerUid: uid,
          ...fence,
          requestDigest: counted.requestDigest,
          model: counted.model,
          protocol: counted.protocol,
          measurement: counted.measurement,
          verificationDigest: verified.verificationDigest,
          inputTokens: counted.inputTokens,
          inputTokenLimit: limit,
          withinInputPolicy: counted.inputTokens <= limit,
          measuredAt: verified.now.toISOString(),
          expiresAt: new Date(
            Math.min(
              Date.parse(job.createdAt) + 60_000,
              Date.parse(verified.configExpiresAt),
            ),
          ).toISOString(),
        });
        tx.set(
          path,
          nativeTimestamps({
            ...job,
            status: 'measured',
            result: nativeTimestamps(measurement),
            updatedAt: verified.now.toISOString(),
          }),
        );
        return { measurement, replayed: false };
      });
    } catch (error) {
      if (owned)
        await this.documents
          .transaction(async (tx) => {
            const job = CountJob.parse(await tx.get(path));
            if (
              job.id !== countId ||
              job.invocationId !== invocationId ||
              job.status !== 'dispatching'
            )
              return;
            tx.set(
              path,
              nativeTimestamps({
                ...job,
                status: 'unknown',
                failureCode:
                  error instanceof MetaTokenFailure
                    ? error.code
                    : 'publication_denied',
                updatedAt: this.clock().toISOString(),
              }),
            );
          })
          .catch(() => undefined); // An uncertain journal stays dispatching; never clear its attempt.
      throw new ContextCountUnavailable();
    }
  }
}
