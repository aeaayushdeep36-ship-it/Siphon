import { z } from 'zod';
import {
  AdapterProposal,
  Answer,
  ContextProposal,
  Id,
  QuestionSet,
  ResourcePolicy,
  UploadManifest,
} from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import { type ArtifactDownloadService } from './artifact-download.js';
import { DispatchFence, requireActiveRevision } from './audit-commands.js';
import { ContextTask } from './context-tasks.js';
import { AdapterTasks } from './adapter-tasks.js';
import { ContextTokenCounts } from './context-token-counts.js';
import { ContextBillingBounds } from './context-billing-bound.js';
import { AdapterPipeline } from './adapter-pipeline.js';
import { ModelJob, ModelJobs } from './model-jobs.js';
import { MetaPricing, reserveMetaCost } from './meta-pricing.js';
import { Operation, reserveOperation } from './accounting.js';
import { FirestoreAccountingStore } from './firestore-accounting.js';
import { AdmissionRepository } from './admission.js';
import { canonicalJson, sha256 } from './hashing.js';
import {
  interpretContextAnswers,
  unresolvedContextQuestions,
} from './context-questions.js';
import { persistProgress } from './progress.js';
import { transition } from './lifecycle.js';
import { type AiConfiguration } from './ai-config.js';
import {
  FreeModelJob,
  GroqAdmissionBlocked,
  GroqModelJobs,
} from './groq-model-jobs.js';
import { MetaRequest } from './meta-client.js';

/** One source-bound mapping request following actual resolved declarations.
 * Every model call uses the same provider quota/attempt/privacy gates as context.
 * The resulting proposal never grants source execution or scientific eligibility.
 */
export class AdapterCoordinator {
  constructor(
    private readonly documents: DocumentStore,
    private readonly downloads: Pick<ArtifactDownloadService, 'readBatch'>,
    private readonly apiKey: string,
    private readonly transport: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date(),
    private readonly aiConfig?: AiConfiguration,
  ) {}
  async run(
    uid: string,
    expected: unknown,
    signal: AbortSignal = AbortSignal.timeout(180000),
  ) {
    const initial = DispatchFence.parse(expected);
    if (!this.apiKey.trim())
      return {
        status: 'blocked' as const,
        code: this.aiConfig
          ? 'ai_credentials_required'
          : 'meta_credentials_required',
        fence: initial,
      };
    const stage = await this.documents.transaction(async (tx) => {
      const state = await requireActiveRevision(tx, uid, initial),
        base = `audits/${initial.auditId}/revisions/${initial.revisionId}`;
      const [revision, context, resolution, prior] = await tx.getMany([
        base,
        `${base}/context/current`,
        `${base}/contextAnswerResolution/current`,
        `adapterStages/${initial.revisionId}`,
      ]);
      if (!['inspecting', 'clarifying', 'adapting'].includes(state.stage))
        throw new Error('Adapter stage is not available');
      const proposal = ContextProposal.parse(context?.proposal),
        task = ContextTask.parse(
          await tx.get(`contextTasks/${Id.parse(context?.operationId)}`),
        );
      const manifest = UploadManifest.parse(revision?.sourceManifest),
        policy = ResourcePolicy.parse(revision?.policy);
      const [contextOperationRaw, contextJobRaw] = await tx.getMany([
        `operations/${task.operationId}`,
        `modelJobs/${task.operationId}`,
      ]);
      const contextOperation = Operation.parse(contextOperationRaw),
        contextJob = this.aiConfig
          ? FreeModelJob.parse(contextJobRaw)
          : ModelJob.parse(contextJobRaw);
      if (
        contextOperation.id !== task.operationId ||
        contextOperation.ownerUid !== uid ||
        contextOperation.auditId !== initial.auditId ||
        contextOperation.revisionId !== initial.revisionId ||
        contextOperation.inputDigest !== initial.inputDigest ||
        contextOperation.outcome !== 'succeeded' ||
        !contextOperation.usage ||
        contextOperation.requestDigest !== task.requestDigest ||
        task.generation !== contextOperation.fence ||
        contextJob.operationId !== task.operationId ||
        contextJob.requestDigest !== task.requestDigest
      )
        throw new Error('Adapter context execution is not settled');
      if (
        context?.ownerUid !== uid ||
        context.inputDigest !== initial.inputDigest ||
        proposal.auditId !== initial.auditId ||
        proposal.revisionId !== initial.revisionId ||
        proposal.inputDigest !== initial.inputDigest ||
        proposal.domainMismatchSuspected ||
        context.proposalDigest !== (await sha256(canonicalJson(proposal))) ||
        task.ownerUid !== uid ||
        task.auditId !== initial.auditId ||
        task.revisionId !== initial.revisionId ||
        task.inputDigest !== initial.inputDigest
      )
        throw new Error(
          'Adapter requires current supported context provenance',
        );
      if (
        !resolution ||
        resolution.ownerUid !== uid ||
        resolution.auditId !== initial.auditId ||
        resolution.revisionId !== initial.revisionId ||
        resolution.inputDigest !== initial.inputDigest ||
        resolution.sourceManifestDigest !==
          (await sha256(canonicalJson(manifest))) ||
        resolution.allUserDeclarationsResolved !== true ||
        resolution.questionDraft !== null
      )
        throw new Error('Adapter requires resolved user declarations');
      const basis = QuestionSet.parse(resolution.questionBasis),
        answers = z
          .array(Answer)
          .parse(revision?.answers)
          .filter((answer) =>
            basis.questions.some(
              (question) => question.id === answer.questionId,
            ),
          );
      if (
        unresolvedContextQuestions(proposal.domain, basis, answers) !== null ||
        canonicalJson(
          interpretContextAnswers(proposal.domain, basis, answers),
        ) !== canonicalJson(resolution.declarations)
      )
        throw new Error('Adapter declarations are unresolved or changed');
      const resolutionBody = Object.fromEntries(
        Object.entries(resolution).filter(
          ([key]) =>
            ![
              'ownerUid',
              'resolutionDigest',
              'createdAt',
              'updatedAt',
            ].includes(key),
        ),
      );
      if (
        resolution.resolutionDigest !==
        (await sha256(canonicalJson(resolutionBody)))
      )
        throw new Error('Adapter declaration provenance changed');
      if (prior) {
        const pointers = z
          .object({
            ownerUid: z.string(),
            auditId: Id,
            revisionId: Id,
            inputDigest: z.string(),
            generation: z.number().int(),
            operationId: Id,
            countId: Id,
            tokenEvidenceId: Id,
          })
          .parse(prior);
        if (
          pointers.ownerUid !== uid ||
          pointers.auditId !== initial.auditId ||
          pointers.revisionId !== initial.revisionId ||
          pointers.inputDigest !== initial.inputDigest ||
          pointers.generation !== initial.generation ||
          state.stage !== 'adapting'
        )
          throw new Error('Adapter stage claim changed');
        return { ...pointers, sources: task.sources, policy };
      }
      if (state.stage === 'adapting')
        throw new Error('Adapter stage lacks its durable claim');
      const next = transition(state, state, {
        kind: 'advance',
        stage: 'adapting',
        reason: 'Resolved declarations permit observation mapping.',
      });
      const pointers = {
        ownerUid: uid,
        auditId: initial.auditId,
        revisionId: initial.revisionId,
        inputDigest: initial.inputDigest,
        generation: next.generation,
        operationId: crypto.randomUUID(),
        countId: crypto.randomUUID(),
        tokenEvidenceId: crypto.randomUUID(),
      };
      await persistProgress(
        tx,
        uid,
        initial.auditId,
        initial,
        { activity: 'verifying_adapter', experiments: null },
        this.clock(),
        {
          kind: 'advance',
          stage: 'adapting',
          reason: 'Resolved declarations permit observation mapping.',
        },
      );
      tx.set(`adapterStages/${initial.revisionId}`, {
        schemaVersion: '1.0',
        ...pointers,
        contextDigest: context.proposalDigest,
        createdAt: this.clock(),
      });
      return { ...pointers, sources: task.sources, policy };
    });
    const fence = DispatchFence.parse({
        auditId: stage.auditId,
        revisionId: stage.revisionId,
        inputDigest: stage.inputDigest,
        generation: stage.generation,
      }),
      base = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
    const existing = await this.documents.get(
      `${base}/adapterProposals/current`,
    );
    if (existing) {
      const proposal = AdapterProposal.parse(existing.proposal);
      if (
        existing.ownerUid !== uid ||
        existing.operationId !== stage.operationId ||
        existing.adapterDigest !== (await sha256(canonicalJson(proposal))) ||
        proposal.auditId !== fence.auditId ||
        proposal.revisionId !== fence.revisionId ||
        proposal.inputDigest !== fence.inputDigest
      )
        throw new Error('Saved adapter proposal changed');
      return {
        status: 'proposal_ready' as const,
        fence,
        proposal,
        adapterDigest: String(existing.adapterDigest),
        operationId: stage.operationId,
      };
    }
    const prior = await this.documents.get(`operations/${stage.operationId}`);
    if (prior && prior.outcome !== 'reserved')
      return {
        status: 'blocked' as const,
        code: 'adapter_operation_requires_reconciliation',
        fence,
      };
    const loaded = await this.downloads.readBatch(
      uid,
      fence,
      stage.sources.map((source) => source.artifactId),
      stage.policy.sourceBytes,
      signal,
    );
    const sources = stage.sources.map((source) => {
      const file = loaded.find((item) => item.artifactId === source.artifactId);
      if (!file || file.sha256 !== source.sourceDigest)
        throw new Error('Adapter source loading mismatch');
      return {
        artifactId: source.artifactId,
        sourceDigest: source.sourceDigest,
        reviewId: source.reviewId,
        text: new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: false,
        }).decode(file.bytes),
      };
    });
    const tasks = new AdapterTasks(this.documents, this.clock, this.aiConfig),
      prepared = await tasks.prepare(uid, fence, sources);
    if (this.aiConfig) {
      try {
        await new GroqModelJobs(
          this.documents,
          this.apiKey,
          this.aiConfig,
          this.transport,
          this.clock,
        ).run(uid, fence, stage.operationId, prepared, 'adapter', signal);
      } catch (error) {
        if (!(error instanceof GroqAdmissionBlocked)) throw error;
        return { status: 'blocked' as const, fence, code: error.code };
      }
      const published = await this.documents.get(
        `${base}/adapterProposals/current`,
      );
      const proposal = AdapterProposal.parse(published?.proposal);
      if (
        published?.ownerUid !== uid ||
        published.operationId !== stage.operationId ||
        published.adapterDigest !== (await sha256(canonicalJson(proposal)))
      )
        throw new Error('Groq adapter publication integrity mismatch');
      return {
        status: 'proposal_ready' as const,
        fence,
        proposal,
        adapterDigest: String(published.adapterDigest),
        operationId: stage.operationId,
      };
    }
    const request = MetaRequest.parse(prepared.request);
    await new ContextTokenCounts(
      this.documents,
      this.apiKey,
      this.transport,
      this.clock,
    ).measureAdapter(uid, fence, stage.countId, sources, signal);
    const bound = await new ContextBillingBounds(
      this.documents,
      this.clock,
    ).produce(
      uid,
      fence,
      stage.countId,
      stage.tokenEvidenceId,
      prepared.requestDigest,
    );
    const price = MetaPricing.parse(
      await this.documents.get('configuration/meta_pricing'),
    );
    const cost = reserveMetaCost(
      price,
      bound.inputTokenUpperBound,
      request.max_output_tokens,
      this.clock(),
    ).microUsd;
    await new AdmissionRepository(this.documents, this.clock).acquire(
      uid,
      fence,
    );
    const now = this.clock().toISOString(),
      operation = Operation.parse({
        schemaVersion: '1.0',
        id: stage.operationId,
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
        createdAt: now,
        updatedAt: now,
      });
    await reserveOperation(
      new FirestoreAccountingStore(this.documents),
      operation,
    );
    await tasks.bind(uid, fence, stage.operationId, sources);
    await new ModelJobs(this.documents, this.clock).bind(
      stage.operationId,
      bound.inputTokenUpperBound,
      request.max_output_tokens,
      stage.tokenEvidenceId,
    );
    const result = await new AdapterPipeline(
      this.documents,
      this.apiKey,
      this.transport,
      this.clock,
    ).run(stage.operationId, request, signal);
    const published = await this.documents.get(
      `${base}/adapterProposals/current`,
    );
    return {
      status: 'proposal_ready' as const,
      fence,
      proposal: AdapterProposal.parse(published?.proposal),
      adapterDigest: result.adapterDigest,
      operationId: stage.operationId,
    };
  }
}
