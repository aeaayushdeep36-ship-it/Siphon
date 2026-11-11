import { type InspectionSourceLoader } from './inspection-sources.js';
import { InspectionRunner } from './inspection-runner.js';
import { type InspectionJobs } from './inspection-jobs.js';
import {
  SandboxRequest,
  type E2bClient,
  SandboxControlFailure,
} from './e2b-client.js';
import { DispatchFence } from './audit-commands.js';
import { z } from 'zod';
import { Id, Digest } from '@siphon/contracts';

const SandboxId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const InspectionExecutionReceipt = z.discriminatedUnion('status', [
  z.strictObject({
    schemaVersion: z.literal('1.0'),
    status: z.literal('published'),
    operationId: Id,
    sandboxId: SandboxId,
    resultDigest: Digest,
    replayed: z.boolean(),
  }),
  z.strictObject({
    schemaVersion: z.literal('1.0'),
    status: z.literal('execution_failed'),
    operationId: Id,
    sandboxId: SandboxId.nullable(),
    failureCode: z.enum([
      'create_unknown',
      'handle_unrecorded',
      'inspection_failed',
    ]),
  }),
]);
export type InspectionExecutionReceipt = z.infer<
  typeof InspectionExecutionReceipt
>;

/** Internal inspection stage. Reservations/job binding precede this call.
 * No HTTP/run route exists until orchestration and release gates are verified.
 */
export class InspectionPipeline {
  constructor(
    private readonly sources: Pick<InspectionSourceLoader, 'load'>,
    private readonly sandboxes: Pick<E2bClient, 'createInspection' | 'kill'>,
    private readonly jobs: Pick<
      InspectionJobs,
      'claim' | 'authorizeResult' | 'publish'
    >,
    private readonly traceBoundary?: (name: string) => void,
  ) {}
  private async perform(
    uid: string,
    requestValue: SandboxRequest,
    expected: unknown,
    signal?: AbortSignal,
  ) {
    const request = SandboxRequest.parse(requestValue);
    const fence = DispatchFence.parse(expected);
    if (
      request.role !== 'inspection' ||
      request.auditId !== fence.auditId ||
      request.revisionId !== fence.revisionId ||
      request.inputDigest !== fence.inputDigest
    )
      throw new Error('Inspection pipeline snapshot mismatch');
    let sandboxId: string | null = null;
    try {
      const payload = await this.sources.load(
        uid,
        request.operationId,
        fence,
        signal,
      );
      this.traceBoundary?.('source_loaded');
      const created = await this.sandboxes.createInspection(request, signal);
      sandboxId = created.sandboxId;
      this.traceBoundary?.('sandbox_created');
      const result = await new InspectionRunner(created.session, this.jobs).run(
        payload,
        signal,
      );
      this.traceBoundary?.('inspection_ran');
      const publication = await this.jobs.publish(payload, result);
      this.traceBoundary?.('result_published');
      return {
        status: 'published' as const,
        operationId: request.operationId,
        sandboxId,
        publication,
      };
    } catch (error) {
      if (error instanceof SandboxControlFailure && error.sandboxId)
        sandboxId = error.sandboxId;
      return {
        status: 'execution_failed' as const,
        operationId: request.operationId,
        sandboxId,
        error,
      };
    }
  }

  /** Success/failure receipts contain no source, AST, logs, SDK objects or raw
   * exceptions. The durable caller must follow this phase with cleanup/recovery.
   * A claimed phase is never automatically replayed to obtain a missing receipt.
   */
  async execute(
    uid: string,
    request: SandboxRequest,
    expected: unknown,
    signal?: AbortSignal,
  ): Promise<InspectionExecutionReceipt> {
    const result = await this.perform(uid, request, expected, signal);
    if (result.status === 'published')
      return InspectionExecutionReceipt.parse({
        schemaVersion: '1.0',
        status: result.status,
        operationId: result.operationId,
        sandboxId: result.sandboxId,
        ...result.publication,
      });
    const failureCode =
      result.error instanceof SandboxControlFailure &&
      ['create_unknown', 'handle_unrecorded'].includes(result.error.code)
        ? result.error.code
        : 'inspection_failed';
    return InspectionExecutionReceipt.parse({
      schemaVersion: '1.0',
      status: result.status,
      operationId: result.operationId,
      sandboxId: result.sandboxId,
      failureCode,
    });
  }

  /** Cleanup is independently callable using the durable known handle, including
   * after cancellation. E2bClient/SandboxJobs still authorize the exact linkage.
   */
  async terminate(
    operationId: string,
    sandboxId: string,
  ): Promise<'confirmed' | 'pending'> {
    Id.parse(operationId);
    SandboxId.parse(sandboxId);
    try {
      await this.sandboxes.kill(
        operationId,
        sandboxId,
        AbortSignal.timeout(30000),
      );
      return 'confirmed';
    } catch {
      return 'pending';
    }
  }

  /** Existing local/internal composition retains immediate cleanup and the
   * original exception. Hosted stages use execute/terminate separately.
   */
  async run(
    uid: string,
    request: SandboxRequest,
    expected: unknown,
    signal?: AbortSignal,
  ) {
    const result = await this.perform(uid, request, expected, signal);
    const cleanup = result.sandboxId
      ? await this.terminate(result.operationId, result.sandboxId)
      : 'pending';
    if (result.status === 'execution_failed') throw result.error;
    return { ...result.publication, cleanup };
  }
}
