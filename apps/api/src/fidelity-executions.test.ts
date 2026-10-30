import { describe, expect, it } from 'vitest';
import { FidelityExecutions } from './fidelity-executions.js';
import { canonicalJson, sha256 } from './hashing.js';
import { firestoreTransport } from '../test/firestore-transport.js';
import { fidelityExecutionFixture as fixture } from '../test/fidelity-execution-fixture.js';

describe('durable comparison lifecycle with authored prior evidence', () => {
  it('binds through the actual Firestore codec with bounded reads for the two-observation fixture', async () => {
    const f = await fixture();
    const port = firestoreTransport(f.docs);
    await new FidelityExecutions(port.client, f.clock).bind('alice', f.request);
    const distinct = new Set(port.batches.flat());
    expect(distinct.size).toBeLessThanOrEqual(40);
    expect(
      f.docs.documents.has(`fidelityExecutions/${f.request.operationId}`),
    ).toBe(true);
  });
  it('requires termination before publication and replays without double charging', async () => {
    const f = await fixture();
    await f.executions.bind('alice', f.request);
    f.dispatch();
    await f.executions.claim(
      f.request,
      await sha256(canonicalJson(f.request)),
      'authored-comparison',
    );
    await f.executions.recordCandidate(f.request.operationId, f.result);
    await expect(f.executions.publish(f.request.operationId)).rejects.toThrow();
    f.terminate();
    const result = await f.executions.publish(f.request.operationId);
    const spent = f.docs.documents.get(
      `budgets/revision_output_bytes_${f.fence.revisionId}`,
    )!.spent;
    expect(result).toMatchObject({ replayed: false });
    expect(await f.executions.publish(f.request.operationId)).toMatchObject({
      replayed: true,
      resultDigest: result.resultDigest,
    });
    expect(
      f.docs.documents.get(
        `budgets/revision_output_bytes_${f.fence.revisionId}`,
      )!.spent,
    ).toBe(spent);
    expect(f.docs.documents.has(`${f.base}/adapters/current`)).toBe(false);
  });
  it('refuses binding when either validation receipt belongs to another owner', async () => {
    const f = await fixture();
    f.docs.documents.get(
      `${f.base}/numericValidations/${f.request.adapted.evaluationOperationId}`,
    )!.ownerUid = 'bob';
    await expect(f.executions.bind('alice', f.request)).rejects.toThrow(
      'numeric validations',
    );
    expect(
      f.docs.documents.has(`fidelityExecutions/${f.request.operationId}`),
    ).toBe(false);
  });
});
