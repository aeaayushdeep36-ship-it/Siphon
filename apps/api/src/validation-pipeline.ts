import { DispatchFence } from './audit-commands.js';
import {
  SandboxRequest,
  SandboxControlFailure,
  type E2bClient,
} from './e2b-client.js';
import { type StoredObservationLoader } from './stored-observations.js';
import { type ValidationExecutions } from './validation-executions.js';
import { ValidationRunner } from './validation-runner.js';

/** Internal data-only stage. Compute jobs must already be reserved/bound.
 * Ambiguous termination retains a private candidate; recovery never reruns it.
 */
export class ValidationPipeline {
  constructor(
    private readonly observations: Pick<StoredObservationLoader, 'load'>,
    private readonly executions: Pick<
      ValidationExecutions,
      'claim' | 'authorizeResult' | 'recordCandidate' | 'publish'
    > & { bind(request: unknown): Promise<unknown> },
    private readonly sandboxes: Pick<E2bClient, 'createValidation' | 'kill'>,
  ) {}

  async run(
    uid: string,
    sourceOperationId: string,
    sandboxValue: unknown,
    expected: unknown,
    signal?: AbortSignal,
  ) {
    const sandbox = SandboxRequest.parse(sandboxValue);
    const fence = DispatchFence.parse(expected);
    if (
      sandbox.role !== 'evaluation' ||
      sandbox.auditId !== fence.auditId ||
      sandbox.revisionId !== fence.revisionId ||
      sandbox.inputDigest !== fence.inputDigest
    )
      throw new Error('Validation pipeline snapshot mismatch');
    signal?.throwIfAborted();
    const loaded = await this.observations.load(
      uid,
      sourceOperationId,
      sandbox.operationId,
      fence,
      signal,
    );
    if (
      loaded.request.evaluationOperationId !== sandbox.operationId ||
      loaded.request.sourceOperationId !== sourceOperationId ||
      loaded.request.inputDigest !== sandbox.inputDigest
    )
      throw new Error('Loaded validation snapshot mismatch');
    await this.executions.bind(loaded.request);
    signal?.throwIfAborted();
    let sandboxId: string | null = null;
    let cleanup: 'confirmed' | 'pending' = 'pending';
    let candidate: Awaited<ReturnType<ValidationExecutions['recordCandidate']>>;
    try {
      const created = await this.sandboxes.createValidation(sandbox, signal);
      sandboxId = created.sandboxId;
      const result = await new ValidationRunner(
        created.session,
        this.executions,
      ).run(loaded.request, loaded.payloads, signal);
      candidate = await this.executions.recordCandidate(
        sandbox.operationId,
        result,
      );
    } catch (error) {
      if (error instanceof SandboxControlFailure && error.sandboxId)
        sandboxId = error.sandboxId;
      throw error;
    } finally {
      if (sandboxId) {
        try {
          await this.sandboxes.kill(
            sandbox.operationId,
            sandboxId,
            AbortSignal.timeout(30000),
          );
          cleanup = 'confirmed';
        } catch {
          // Persisted handles and reservations remain for reconciliation.
        }
      }
    }
    if (cleanup === 'pending')
      return {
        status: 'awaiting_termination' as const,
        reportDigest: candidate.reportDigest,
      };
    return {
      status: 'published' as const,
      ...(await this.executions.publish(sandbox.operationId)),
    };
  }

  /** Uses the durable candidate and rechecks current access/termination proof. */
  async recover(evaluationOperationId: string) {
    return {
      status: 'published' as const,
      ...(await this.executions.publish(evaluationOperationId)),
    };
  }
}
