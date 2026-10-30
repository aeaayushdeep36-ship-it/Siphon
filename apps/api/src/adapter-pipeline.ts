import { AdapterProposal, Id } from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import { MetaClient, MetaFailure } from './meta-client.js';
import { ContextModelGate } from './context-model-gate.js';
import { ModelJobs } from './model-jobs.js';
import { AdapterTasks } from './adapter-tasks.js';

/** One real gated model call. It produces a proposed mapping, never fidelity or
 * scientific approval; trustworthy baseline execution is a separate stage.
 */
export class AdapterPipeline {
  constructor(
    private readonly documents: DocumentStore,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async run(operationId: string, request: unknown, signal?: AbortSignal) {
    Id.parse(operationId);
    const jobs = new ModelJobs(this.documents, this.clock);
    const client = new MetaClient(
      this.apiKey,
      new ContextModelGate(this.documents, operationId, this.clock, 'adapter'),
      this.fetcher,
    );
    let completed;
    try {
      completed = await client.complete(
        request,
        AdapterProposal,
        signal ?? AbortSignal.timeout(60000),
      );
    } catch (error) {
      if (error instanceof MetaFailure)
        await jobs.settle(operationId, { kind: 'failed', failure: error });
      throw error;
    }
    await jobs.settle(operationId, {
      kind: 'succeeded',
      usage: completed.usage,
    });
    return {
      ...(await new AdapterTasks(this.documents, this.clock).publish(
        operationId,
        completed.output,
      )),
      providerId: completed.providerId,
    };
  }
}
