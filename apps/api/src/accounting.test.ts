import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  markDispatching,
  markUnknown,
  reserveOperation,
  settleOperation,
  releaseUndispatched,
  type AccountingStore,
  type AccountingTransaction,
  type BudgetCounter,
  type Operation,
} from './accounting.js';

// Test-only serializable transaction simulator; never used by the hosted API.
class TestStore implements AccountingStore {
  operations = new Map<string, Operation>();
  counters = new Map<string, BudgetCounter>();
  private tail = Promise.resolve();
  async transaction<T>(
    callback: (tx: AccountingTransaction) => Promise<T>,
  ): Promise<T> {
    const prior = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    const operations = structuredClone(this.operations);
    const counters = structuredClone(this.counters);
    try {
      const result = await callback({
        authorizeDispatch: async () => {},
        prepareDispatch: async () => () => {},
        getOperation: async (id) => operations.get(id) ?? null,
        getCounters: async (keys) =>
          keys.map((key) => counters.get(key) ?? null),
        putOperation: (operation) => {
          operations.set(operation.id, operation);
        },
        putCounter: (key, counter) => {
          counters.set(key, counter);
        },
      });
      this.operations = operations;
      this.counters = counters;
      return result;
    } finally {
      release();
    }
  }
}
const now = '2026-10-28T09:00:00Z';
function setup() {
  const store = new TestStore();
  store.counters.set('meta', {
    schemaVersion: '1.0',
    limit: 100,
    reserved: 0,
    spent: 0,
    halted: false,
  });
  store.counters.set('attempts', {
    schemaVersion: '1.0',
    limit: 8,
    reserved: 0,
    spent: 0,
    halted: false,
  });
  const operation: Operation = {
    schemaVersion: '1.0',
    id: randomUUID(),
    revisionId: randomUUID(),
    auditId: randomUUID(),
    ownerUid: 'alice',
    inputDigest: 'a'.repeat(64),
    requestDigest: 'c'.repeat(64),
    fence: 0,
    outcome: 'reserved',
    createdAt: now,
    updatedAt: now,
    providerHandle: null,
    usage: null,
    charges: [
      {
        counterKey: 'meta',
        amount: 60,
        unit: 'micro_usd',
        consumeOnDispatch: false,
      },
      {
        counterKey: 'attempts',
        amount: 1,
        unit: 'attempts',
        consumeOnDispatch: true,
      },
    ],
  };
  return { store, operation };
}

describe('provider operation accounting', () => {
  it('refunds only never-dispatched reservations, idempotently', async () => {
    const { store, operation } = setup();
    await reserveOperation(store, operation);
    await releaseUndispatched(store, operation.id, 0, now);
    await releaseUndispatched(store, operation.id, 0, now);
    expect(store.counters.get('meta')).toMatchObject({ spent: 0, reserved: 0 });
    expect(store.counters.get('attempts')).toMatchObject({
      spent: 0,
      reserved: 0,
    });
    await expect(
      markDispatching(store, operation.id, 0, now),
    ).rejects.toThrow();
  });
  it('cannot refund a call with an unknown provider outcome', async () => {
    const { store, operation } = setup();
    await reserveOperation(store, operation);
    await markDispatching(store, operation.id, 0, now);
    await markUnknown(store, operation.id, 0, now, null);
    await expect(
      releaseUndispatched(store, operation.id, 0, now),
    ).rejects.toThrow('cannot be refunded');
    expect(store.counters.get('meta')?.reserved).toBe(60);
  });
  it('admits only one concurrent contender for the last available balance', async () => {
    const { store, operation } = setup();
    const results = await Promise.allSettled([
      reserveOperation(store, operation),
      reserveOperation(store, { ...operation, id: randomUUID() }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(store.counters.get('meta')?.reserved).toBe(60);
    expect(store.counters.get('attempts')?.reserved).toBe(1);
  });
  it('replays a reservation without charging twice, but rejects mismatched payload', async () => {
    const { store, operation } = setup();
    await reserveOperation(store, operation);
    await reserveOperation(store, operation);
    expect(store.counters.get('meta')?.reserved).toBe(60);
    await expect(
      reserveOperation(store, { ...operation, requestDigest: 'd'.repeat(64) }),
    ).rejects.toThrow('mismatch');
  });
  it('keeps ambiguous charges reserved and prevents duplicate paid dispatch', async () => {
    const { store, operation } = setup();
    await reserveOperation(store, operation);
    await markDispatching(store, operation.id, 0, now);
    await markUnknown(store, operation.id, 0, now, null);
    expect(store.counters.get('meta')?.reserved).toBe(60);
    expect(store.counters.get('attempts')?.spent).toBe(1);
    await expect(markDispatching(store, operation.id, 0, now)).rejects.toThrow(
      'not dispatchable',
    );
    await settleOperation(
      store,
      operation.id,
      0,
      { meta: 40, attempts: 1 },
      'succeeded',
      now,
    );
    await settleOperation(
      store,
      operation.id,
      0,
      { attempts: 1, meta: 40 },
      'succeeded',
      now,
    );
    expect(store.counters.get('meta')).toMatchObject({
      reserved: 0,
      spent: 40,
    });
  });
  it('records overruns and halts rather than lying about provider usage', async () => {
    const { store, operation } = setup();
    await reserveOperation(store, operation);
    await markDispatching(store, operation.id, 0, now);
    await settleOperation(
      store,
      operation.id,
      0,
      { meta: 110, attempts: 1 },
      'failed',
      now,
    );
    expect(store.counters.get('meta')).toMatchObject({
      spent: 110,
      reserved: 0,
      halted: true,
    });
    await expect(
      reserveOperation(store, { ...operation, id: randomUUID() }),
    ).rejects.toThrow('budget');
  });
  it('does not refund failed dispatch attempts or accept incomplete usage', async () => {
    const { store, operation } = setup();
    await reserveOperation(store, operation);
    await markDispatching(store, operation.id, 0, now);
    await expect(
      settleOperation(
        store,
        operation.id,
        0,
        { meta: 0, attempts: 0 },
        'failed',
        now,
      ),
    ).rejects.toThrow('refunded');
    await expect(
      settleOperation(store, operation.id, 0, { meta: 0 }, 'failed', now),
    ).rejects.toThrow('coverage');
    expect(store.counters.get('meta')?.reserved).toBe(60);
  });
  it('checks reduced policy again before dispatch and fences stale settlements', async () => {
    const { store, operation } = setup();
    await reserveOperation(store, operation);
    const counter = store.counters.get('meta')!;
    store.counters.set('meta', { ...counter, limit: 50 });
    await expect(markDispatching(store, operation.id, 0, now)).rejects.toThrow(
      'reduced',
    );
    await expect(
      settleOperation(
        store,
        operation.id,
        1,
        { meta: 0, attempts: 1 },
        'failed',
        now,
      ),
    ).rejects.toThrow('Stale');
  });
});
