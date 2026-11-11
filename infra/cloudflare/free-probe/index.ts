import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  WorkflowStep,
} from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
type ProbeParams = { mode: string };
type Env = { PROBE: Workflow<ProbeParams> };

export class FreeFeasibility extends WorkflowEntrypoint<Env, ProbeParams> {
  async run(event: WorkflowEvent<ProbeParams>, step: WorkflowStep) {
    const mode = event.payload.mode;
    if (
      ![
        'split',
        'single',
        'single-50',
        'separate-instance',
        'yield',
        'binding-parent',
        'binding-child',
      ].includes(mode)
    )
      throw new NonRetryableError('Invalid authored probe mode');
    if (mode === 'binding-child')
      return await step.do(
        'binding-child-noop',
        { retries: { limit: 0, delay: '1 second' }, timeout: '30 seconds' },
        async () => ({ role: 'child', externalFetchCalls: 0 }),
      );
    if (mode === 'binding-parent') {
      const childId = `child-${event.instanceId}`;
      const created = await step.do(
        'create-child-by-binding',
        { retries: { limit: 0, delay: '1 second' }, timeout: '30 seconds' },
        async () => {
          let creation: 'created' | 'create_error_reconciled' = 'created';
          try {
            await this.env.PROBE.create({
              id: childId,
              params: { mode: 'binding-child' },
            });
          } catch {
            // A stable ID turns a lost create response into a reconciliation,
            // never a second child creation attempt.
            creation = 'create_error_reconciled';
          }
          const instance = await this.env.PROBE.get(childId);
          return { childId: instance.id, creation };
        },
      );
      const duplicate = await step.do(
        'reject-duplicate-child-create',
        { retries: { limit: 0, delay: '1 second' }, timeout: '30 seconds' },
        async () => {
          try {
            await this.env.PROBE.create({
              id: created.childId,
              params: { mode: 'binding-child' },
            });
          } catch (error) {
            const record =
              typeof error === 'object' && error !== null
                ? (error as { code?: unknown; message?: unknown })
                : {};
            const code = record.code;
            const message =
              typeof record.message === 'string'
                ? record.message
                : error instanceof Error
                  ? error.message
                  : '';
            return {
              duplicateCreateRejected: true,
              duplicateErrorName:
                error instanceof Error ? error.name.slice(0, 64) : 'unknown',
              duplicateErrorCode:
                typeof code === 'string' || typeof code === 'number'
                  ? String(code).slice(0, 32)
                  : null,
              duplicateErrorShowsConflict:
                code === 10405 || /already.*(exists|used)/i.test(message),
            };
          }
          throw new NonRetryableError('Duplicate child create was accepted');
        },
      );
      if (!duplicate.duplicateCreateRejected)
        throw new NonRetryableError('Duplicate child create was accepted');
      await step.sleep('wait-for-child-completion', '1 second');
      const status = await step.do(
        'read-child-status',
        { retries: { limit: 0, delay: '1 second' }, timeout: '30 seconds' },
        async () => {
          const instance = await this.env.PROBE.get(created.childId);
          const child = await instance.status();
          const output = child.output;
          const childOutputVerified =
            typeof output === 'object' &&
            output !== null &&
            'role' in output &&
            output.role === 'child' &&
            'externalFetchCalls' in output &&
            output.externalFetchCalls === 0;
          return { status: child.status, childOutputVerified };
        },
      );
      return {
        role: 'parent',
        childId: created.childId,
        creation: created.creation,
        ...duplicate,
        createCalls: 2,
        getCalls: 2,
        statusCalls: 1,
        externalFetchCalls: 0,
        childStatus: status.status,
        childOutputVerified: status.childOutputVerified,
      };
    }
    const groups =
      mode === 'single'
        ? [51]
        : mode === 'single-50'
          ? [50]
          : mode === 'separate-instance'
            ? [30]
            : [30, 30];
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
