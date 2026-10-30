import { describe, expect, it } from 'vitest';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAccountingStore } from './firestore-accounting.js';
import { Operation } from './accounting.js';
import { MetaFailure } from './meta-client.js';
import { settleModelCompletion } from './meta-settlement.js';

const now = '2026-10-28T00:00:00Z';
const pricing = {
  schemaVersion: '1.0',
  version: 'fixture',
  model: 'muse-wonder-1.0',
  mode: 'standard',
  verifiedAt: now,
  effectiveFrom: now,
  effectiveUntil: '2026-10-29T00:00:00Z',
  inputMicroUsdPerMillion: 4000000,
  cachedInputMicroUsdPerMillion: 200000,
  outputMicroUsdPerMillion: 20000000,
};
function setup() {
  const docs = new TestDocuments();
  const operation = Operation.parse({
    schemaVersion: '1.0',
    id: crypto.randomUUID(),
    auditId: crypto.randomUUID(),
    revisionId: crypto.randomUUID(),
    ownerUid: 'alice',
    inputDigest: 'a'.repeat(64),
    requestDigest: 'b'.repeat(64),
    fence: 1,
    outcome: 'dispatching',
    usage: null,
    providerHandle: null,
    createdAt: now,
    updatedAt: now,
    charges: [
      {
        counterKey: 'meta_global',
        amount: 1000,
        unit: 'micro_usd',
        consumeOnDispatch: false,
      },
      {
        counterKey: 'meta_revision',
        amount: 1000,
        unit: 'micro_usd',
        consumeOnDispatch: false,
      },
      {
        counterKey: 'meta_attempts',
        amount: 1,
        unit: 'attempts',
        consumeOnDispatch: true,
      },
    ],
  });
  docs.documents.set(`operations/${operation.id}`, structuredClone(operation));
  for (const key of ['meta_global', 'meta_revision'])
    docs.documents.set(`budgets/${key}`, {
      schemaVersion: '1.0',
      reserved: 1000,
      spent: 0,
      limit: 10000,
      halted: false,
    });
  docs.documents.set('budgets/meta_attempts', {
    schemaVersion: '1.0',
    reserved: 0,
    spent: 1,
    limit: 8,
    halted: false,
  });
  return { docs, operation, store: new FirestoreAccountingStore(docs) };
}
describe('model completion settlement', () => {
  it('settles valid usage exactly once against global and revision budgets', async () => {
    const f = setup();
    const completion = {
      kind: 'succeeded' as const,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    await settleModelCompletion(f.store, f.operation, pricing, completion, now);
    await settleModelCompletion(f.store, f.operation, pricing, completion, now);
    for (const key of ['meta_global', 'meta_revision'])
      expect(f.docs.documents.get(`budgets/${key}`)).toMatchObject({
        spent: 140,
        reserved: 0,
      });
    expect(f.docs.documents.get('budgets/meta_attempts')?.spent).toBe(1);
  });
  it('charges invalid structured output when provider usage is available', async () => {
    const f = setup();
    await settleModelCompletion(
      f.store,
      f.operation,
      pricing,
      {
        kind: 'failed',
        failure: new MetaFailure('invalid_response', {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        }),
      },
      now,
    );
    expect(f.docs.documents.get(`operations/${f.operation.id}`)?.outcome).toBe(
      'failed',
    );
    expect(f.docs.documents.get('budgets/meta_global')?.spent).toBe(140);
  });
  it('retains reservations on unknown outcomes and does not need an active audit to settle', async () => {
    const f = setup(); // No audit document: cancelled/deleted audits must not block accounting.
    await settleModelCompletion(
      f.store,
      f.operation,
      pricing,
      { kind: 'failed', failure: new MetaFailure('transport_unknown') },
      now,
    );
    expect(f.docs.documents.get(`operations/${f.operation.id}`)?.outcome).toBe(
      'unknown',
    );
    expect(f.docs.documents.get('budgets/meta_global')).toMatchObject({
      reserved: 1000,
      spent: 0,
    });
  });
  it('records actual overruns and halts affected monetary counters', async () => {
    const f = setup();
    await settleModelCompletion(
      f.store,
      f.operation,
      pricing,
      {
        kind: 'failed',
        failure: new MetaFailure('usage_exceeded', {
          prompt_tokens: 1000,
          completion_tokens: 0,
          total_tokens: 1000,
        }),
      },
      now,
    );
    expect(f.docs.documents.get('budgets/meta_global')).toMatchObject({
      spent: 4000,
      reserved: 0,
      halted: true,
    });
    expect(f.docs.documents.get('budgets/meta_revision')?.halted).toBe(true);
  });
  it('rejects charge substitutions without releasing reservations', async () => {
    const f = setup();
    f.operation.charges[0]!.counterKey = 'wrong_counter';
    await expect(
      settleModelCompletion(
        f.store,
        f.operation,
        pricing,
        {
          kind: 'succeeded',
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        },
        now,
      ),
    ).rejects.toThrow();
    expect(f.docs.documents.get('budgets/meta_global')?.reserved).toBe(1000);
  });
});
