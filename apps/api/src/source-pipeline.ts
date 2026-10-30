import { SourceJobRequest } from '@siphon/contracts';
import {
  SandboxRequest,
  SandboxControlFailure,
  type E2bClient,
} from './e2b-client.js';
import { SourceRunner } from './source-runner.js';
import { type SourceExecutions } from './source-executions.js';

/** Internal baseline stage; supplied operation/sandbox jobs must already be
 * reserved/bound. No experiment-control or public execution endpoint exists.
 */
export class SourcePipeline {
  constructor(
    private readonly executions: Pick<
      SourceExecutions,
      'bind' | 'claim' | 'authorizeCollection'
    >,
    private readonly sandboxes: Pick<E2bClient, 'createSource' | 'kill'>,
  ) {}
  async run(
    sandboxValue: unknown,
    sourceValue: unknown,
    approvalId: string,
    signal?: AbortSignal,
  ) {
    const sandbox = SandboxRequest.parse(sandboxValue);
    const request = SourceJobRequest.parse(sourceValue);
    if (
      sandbox.role !== 'source' ||
      sandbox.operationId !== request.operationId ||
      sandbox.inputDigest !== request.inputDigest
    )
      throw new Error('Source pipeline snapshot mismatch');
    const binding = await this.executions.bind(request, approvalId);
    let sandboxId: string | null = null;
    let output: Awaited<ReturnType<SourceRunner['run']>>;
    let cleanup: 'confirmed' | 'pending' = 'pending';
    try {
      const created = await this.sandboxes.createSource(sandbox, signal);
      sandboxId = created.sandboxId;
      output = await new SourceRunner(created.session, this.executions).run(
        request,
        signal,
        binding.extractionProfile,
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
          cleanup = 'confirmed';
        } catch {
          /* Durable handle/reservations remain for maintenance reconciliation. */
        }
      }
    }
    return { ...output, cleanup };
  }
}
