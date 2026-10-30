import {
  SandboxRequest,
  SandboxControlFailure,
  type E2bClient,
} from './e2b-client.js';
import { PdfRunner } from './pdf-runner.js';
import { type ReportPdfPublications } from './report-publication.js';

/** Fixed data-only export stage. Store a private candidate before termination;
 * only confirmed termination permits publication. Recovery never reruns a job. */
export class PdfPipeline {
  constructor(
    private readonly publications: Pick<
      ReportPdfPublications,
      'bind' | 'gate' | 'storeCandidate' | 'publish' | 'recordFailure'
    >,
    private readonly sandboxes: Pick<E2bClient, 'createPdf' | 'kill'>,
  ) {}
  async run(sandboxValue: unknown, signal?: AbortSignal) {
    const sandbox = SandboxRequest.parse(sandboxValue);
    if (sandbox.role !== 'pdf')
      throw new Error('PDF pipeline requires PDF role');
    const bound = await this.publications.bind(sandbox.operationId);
    if (JSON.stringify(bound.sandbox) !== JSON.stringify(sandbox))
      throw new Error('PDF sandbox snapshot mismatch');
    signal?.throwIfAborted();
    let sandboxId: string | null = null,
      terminated = false;
    let failed = false;
    try {
      const created = await this.sandboxes.createPdf(sandbox, signal);
      sandboxId = created.sandboxId;
      const result = await new PdfRunner(
        created.session,
        this.publications.gate(sandbox.operationId),
      ).run(bound.document, signal);
      await this.publications.storeCandidate(
        sandbox.operationId,
        result.receipt,
        result.bytes,
        signal,
      );
    } catch (error) {
      if (error instanceof SandboxControlFailure && error.sandboxId)
        sandboxId = error.sandboxId;
      failed = true;
    } finally {
      if (sandboxId) {
        try {
          await this.sandboxes.kill(
            sandbox.operationId,
            sandboxId,
            AbortSignal.timeout(30000),
          );
          terminated = true;
        } catch {
          /* Preserve durable handle, candidate and reservations for recovery. */
        }
      }
    }
    if (failed) {
      if (terminated)
        await this.publications.recordFailure(sandbox.operationId);
      throw new Error('trusted_pdf_render_failed');
    }
    if (!terminated) return { status: 'awaiting_termination' as const };
    return {
      status: 'published' as const,
      ...(await this.publications.publish(sandbox.operationId)),
    };
  }
  async recover(operationId: string) {
    return {
      status: 'published' as const,
      ...(await this.publications.publish(operationId)),
    };
  }
}
