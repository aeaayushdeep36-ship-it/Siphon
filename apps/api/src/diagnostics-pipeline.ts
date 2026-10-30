import { DiagnosticJobRequest } from '@siphon/contracts';
import { DispatchFence } from './audit-commands.js';
import {
  SandboxRequest,
  SandboxControlFailure,
  type E2bClient,
} from './e2b-client.js';
import { type StoredObservationLoader } from './stored-observations.js';
import { type DiagnosticExecutions } from './diagnostic-executions.js';
import { DiagnosticsRunner } from './diagnostics-runner.js';
import { canonicalJson } from './hashing.js';

/** Internal measurements from an already published structural-validation snapshot. */
export class DiagnosticsPipeline {
  constructor(
    private readonly observations: Pick<StoredObservationLoader, 'load'>,
    private readonly executions: Pick<
      DiagnosticExecutions,
      'bind' | 'claim' | 'authorizeResult' | 'recordCandidate' | 'publish'
    >,
    private readonly sandboxes: Pick<E2bClient, 'createDiagnostics' | 'kill'>,
  ) {}
  async run(
    uid: string,
    sandboxValue: unknown,
    value: unknown,
    expected: unknown,
    signal?: AbortSignal,
  ) {
    const sandbox = SandboxRequest.parse(sandboxValue);
    const request = DiagnosticJobRequest.parse(value);
    const fence = DispatchFence.parse(expected);
    if (
      sandbox.role !== 'evaluation' ||
      sandbox.operationId !== request.operationId ||
      sandbox.auditId !== request.auditId ||
      sandbox.revisionId !== request.revisionId ||
      sandbox.inputDigest !== request.validation.inputDigest ||
      fence.auditId !== request.auditId ||
      fence.revisionId !== request.revisionId ||
      fence.inputDigest !== sandbox.inputDigest
    )
      throw new Error('Diagnostic pipeline snapshot mismatch');
    signal?.throwIfAborted();
    await this.executions.bind(request, uid);
    const loaded = await this.observations.load(
      uid,
      request.validation.sourceOperationId,
      request.operationId,
      fence,
      signal,
    );
    // The loader authorizes the new execution, but the request retains the
    // previous completed validation ID as immutable data provenance.
    if (
      canonicalJson({
        ...loaded.request,
        evaluationOperationId: request.validation.evaluationOperationId,
      }) !== canonicalJson(request.validation)
    )
      throw new Error('Loaded diagnostic observations changed');
    signal?.throwIfAborted();
    let sandboxId: string | null = null;
    let terminated = false;
    let candidate: Awaited<ReturnType<DiagnosticExecutions['recordCandidate']>>;
    try {
      const created = await this.sandboxes.createDiagnostics(sandbox, signal);
      sandboxId = created.sandboxId;
      const result = await new DiagnosticsRunner(
        created.session,
        this.executions,
      ).run(request, loaded.payloads, signal);
      candidate = await this.executions.recordCandidate(
        request.operationId,
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
            request.operationId,
            sandboxId,
            AbortSignal.timeout(30000),
          );
          terminated = true;
        } catch {
          // Unknown termination retains private candidate, handles and reservations.
        }
      }
    }
    if (!terminated)
      return {
        status: 'awaiting_termination' as const,
        reportDigest: candidate.reportDigest,
      };
    return {
      status: 'published' as const,
      ...(await this.executions.publish(request.operationId)),
    };
  }
  async recover(operationId: string) {
    return {
      status: 'published' as const,
      ...(await this.executions.publish(operationId)),
    };
  }
}
