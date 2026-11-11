import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  WorkflowStep,
} from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
export class FreeFeasibility extends WorkflowEntrypoint {
  async run(event: WorkflowEvent<{ mode: string }>, step: WorkflowStep) {
    const mode = event.payload.mode;
    if (!['split', 'single', 'yield'].includes(mode))
      throw new NonRetryableError('Invalid authored probe mode');
    const groups = mode === 'single' ? [51] : [30, 30];
    const results = [];
    for (let stage = 0; stage < groups.length; stage++) {
      if (mode === 'yield' && stage === 1)
        await step.sleep('authored-yield', '1 second');
      results.push(
        await step.do(
          `authored-requests-${stage}`,
          { retries: { limit: 0, delay: '1 second' }, timeout: '2 minutes' },
          async () => {
            let completed = 0;
            const statuses: Record<string, number> = {};
            for (let i = 0; i < groups[stage]!; i++) {
              const response = await fetch('https://example.com/', {
                method: 'HEAD',
                redirect: 'manual',
                signal: AbortSignal.timeout(10000),
              });
              await response.body?.cancel();
              statuses[response.status] = (statuses[response.status] ?? 0) + 1;
              completed++;
            }
            return { completed, statuses };
          },
        ),
      );
    }
    return { authoredProbe: true, mode, results };
  }
}
export default {
  fetch() {
    return new Response('Not found', { status: 404 });
  },
};
