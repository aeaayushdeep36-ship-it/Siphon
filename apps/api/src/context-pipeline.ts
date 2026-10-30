import { ContextProposal, Id } from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import { MetaClient, MetaFailure } from './meta-client.js';
import { ContextModelGate } from './context-model-gate.js';
import { ModelJobs } from './model-jobs.js';
import { ContextTasks } from './context-tasks.js';

/** Runs one previously prepared/bound operation. The model gate is always bound
 * to that same operation; no caller-provided permissive gate can replace it.
 * Successful output settles before publication. Ambiguous output never publishes.
 */
export class ContextPipeline {
  constructor(
    private readonly documents: DocumentStore,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async run(operationId: string, request: unknown, signal?: AbortSignal) {
    Id.parse(operationId);
    const client = new MetaClient(
      this.apiKey,
      new ContextModelGate(this.documents, operationId, this.clock),
      this.fetcher,
    );
    const jobs = new ModelJobs(this.documents, this.clock);
    let completed;
    try {
      completed = await client.complete(
        request,
        ContextProposal,
        signal ?? AbortSignal.timeout(60000),
      );
    } catch (error) {
      if (error instanceof MetaFailure) {
        // Invalid/truncated output may still be billable; missing usage remains
        // unknown with reservations intact. Settlement works after cancellation.
        await jobs.settle(operationId, { kind: 'failed', failure: error });
      }
      throw error;
    }
    await jobs.settle(operationId, {
      kind: 'succeeded',
      usage: completed.usage,
    });
    const receipt = await new ContextTasks(this.documents, this.clock).publish(
      operationId,
      completed.output,
    );
    return { ...receipt, providerId: completed.providerId };
  }
}
