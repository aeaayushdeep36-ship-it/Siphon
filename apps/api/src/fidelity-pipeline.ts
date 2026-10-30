import { DispatchFence } from './audit-commands.js';
import {
  SandboxControlFailure,
  SandboxRequest,
  type E2bClient,
} from './e2b-client.js';
import { type StoredObservationLoader } from './stored-observations.js';
import { type FidelityExecutions } from './fidelity-executions.js';
import { FidelityRequest, FidelityRunner } from './fidelity-runner.js';
import { Id } from '@siphon/contracts';

/** Internal data-only workflow; the caller reserves and binds the sandbox job. */
export class FidelityPipeline {
  constructor(
    private readonly observations: Pick<StoredObservationLoader, 'load'>,
    private readonly executions: Pick<
      FidelityExecutions,
      'bind' | 'claim' | 'authorizeResult' | 'recordCandidate' | 'publish'
    >,
    private readonly sandboxes: Pick<E2bClient, 'createFidelity' | 'kill'>,
  ) {}
  async run(
    uid: string,
    original: { sourceOperationId: string; validationOperationId: string },
    adapted: { sourceOperationId: string; validationOperationId: string },
    sandboxValue: unknown,
    expected: unknown,
    signal?: AbortSignal,
  ) {
    const fence = DispatchFence.parse(expected),
      sandbox = SandboxRequest.parse(sandboxValue);
    for (const id of [
      original.sourceOperationId,
      original.validationOperationId,
      adapted.sourceOperationId,
      adapted.validationOperationId,
    ])
      Id.parse(id);
    if (
      sandbox.role !== 'evaluation' ||
      sandbox.auditId !== fence.auditId ||
      sandbox.revisionId !== fence.revisionId ||
      sandbox.inputDigest !== fence.inputDigest
    )
      throw new Error('Comparison pipeline snapshot mismatch');
    signal?.throwIfAborted();
    const left = await this.observations.load(
        uid,
        original.sourceOperationId,
        original.validationOperationId,
        fence,
        signal,
      ),
      right = await this.observations.load(
        uid,
        adapted.sourceOperationId,
        adapted.validationOperationId,
        fence,
        signal,
      );
    const request = FidelityRequest.parse({
      schemaVersion: '1.0',
      operationId: sandbox.operationId,
      original: left.request,
      adapted: right.request,
    });
    await this.executions.bind(uid, request);
    signal?.throwIfAborted();
    let sandboxId: string | null = null,
      cleanup: 'confirmed' | 'pending' = 'pending';
    let candidate: Awaited<ReturnType<FidelityExecutions['recordCandidate']>>;
    try {
      const created = await this.sandboxes.createFidelity(sandbox, signal);
      sandboxId = created.sandboxId;
      const result = await new FidelityRunner(
        created.session,
        this.executions,
      ).run(request, left.payloads, right.payloads, signal);
      candidate = await this.executions.recordCandidate(
        sandbox.operationId,
        result,
      );
    } catch (error) {
      if (error instanceof SandboxControlFailure && error.sandboxId)
        sandboxId = error.sandboxId;
      throw error;
    } finally {
      if (sandboxId)
        try {
          await this.sandboxes.kill(
            sandbox.operationId,
            sandboxId,
            AbortSignal.timeout(30000),
          );
          cleanup = 'confirmed';
        } catch {
          /* Keep candidate and reservations for reconciliation. */
        }
    }
    if (cleanup === 'pending')
      return {
        status: 'awaiting_termination' as const,
        resultDigest: candidate.resultDigest,
      };
    return {
      status: 'published' as const,
      ...(await this.executions.publish(sandbox.operationId)),
    };
  }
  async recover(operationId: string) {
    return {
      status: 'published' as const,
      ...(await this.executions.publish(Id.parse(operationId))),
    };
  }
}
