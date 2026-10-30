import { z } from 'zod';
import { Count, Digest, Id, SchemaVersion, Timestamp } from '@siphon/contracts';

export const BudgetCounter = z.strictObject({
  schemaVersion: SchemaVersion,
  limit: Count,
  reserved: Count,
  spent: Count,
  halted: z.boolean(),
});
export type BudgetCounter = z.infer<typeof BudgetCounter>;

export const Charge = z.strictObject({
  counterKey: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  amount: Count,
  unit: z.enum(['micro_usd', 'seconds', 'bytes', 'attempts', 'operations']),
  // Attempts/requests are consumed on dispatch, even if a provider returns an error.
  consumeOnDispatch: z.boolean(),
});
export const Operation = z.strictObject({
  schemaVersion: SchemaVersion,
  id: Id,
  revisionId: Id,
  auditId: Id,
  ownerUid: z.string().min(1).max(128),
  inputDigest: Digest,
  requestDigest: Digest,
  fence: Count,
  outcome: z.enum([
    'reserved',
    'dispatching',
    'succeeded',
    'failed',
    'unknown',
  ]),
  charges: z.array(Charge).min(1).max(24),
  usage: z.record(z.string(), Count).nullable(),
  providerHandle: z.string().min(1).max(300).nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Operation = z.infer<typeof Operation>;

export class AccountingConflict extends Error {
  constructor(
    public readonly code:
      'budget_exhausted' | 'operation_conflict' | 'invalid_accounting',
    message: string,
  ) {
    super(message);
  }
}

// A production implementation MUST run this callback in a Firestore transaction.
// It must not retry callbacks containing provider I/O; external dispatch follows commit.
export interface AccountingTransaction {
  authorizeDispatch(operation: Operation): Promise<void>;
  prepareDispatch(operation: Operation, now: string): Promise<() => void>;
  getOperation(id: string): Promise<Operation | null>;
  getCounters(keys: readonly string[]): Promise<Array<BudgetCounter | null>>;
  putOperation(operation: Operation): void;
  putCounter(key: string, counter: BudgetCounter): void;
}
export interface AccountingStore {
  transaction<T>(
    callback: (tx: AccountingTransaction) => Promise<T>,
  ): Promise<T>;
}

function checkedSum(a: number, b: number): number {
  const result = BigInt(a) + BigInt(b);
  if (result > BigInt(Number.MAX_SAFE_INTEGER))
    throw new AccountingConflict('invalid_accounting', 'Counter overflow');
  return Number(result);
}

async function loadCounters(
  tx: AccountingTransaction,
  operation: Operation,
): Promise<Map<string, BudgetCounter>> {
  const result = new Map<string, BudgetCounter>();
  const keys = operation.charges.map((charge) => charge.counterKey);
  if (new Set(keys).size !== keys.length)
    throw new AccountingConflict(
      'invalid_accounting',
      'Duplicate charge counter',
    );
  const counters = await tx.getCounters(keys);
  if (counters.length !== keys.length)
    throw new AccountingConflict(
      'invalid_accounting',
      'Incomplete charge counters',
    );
  for (const [index, charge] of operation.charges.entries()) {
    const counter = counters[index];
    if (!counter)
      throw new AccountingConflict(
        'budget_exhausted',
        'Budget has not been verified/configured',
      );
    result.set(charge.counterKey, BudgetCounter.parse(counter));
  }
  return result;
}

function counterAt(
  counters: Map<string, BudgetCounter>,
  key: string,
): BudgetCounter {
  const counter = counters.get(key);
  if (!counter)
    throw new AccountingConflict('invalid_accounting', 'Missing counter');
  return counter;
}

export async function reserveOperation(
  store: AccountingStore,
  value: Operation,
): Promise<Operation> {
  const requested = Operation.parse(value);
  if (
    requested.outcome !== 'reserved' ||
    requested.usage !== null ||
    requested.providerHandle !== null
  )
    throw new AccountingConflict(
      'invalid_accounting',
      'Invalid initial operation',
    );
  return store.transaction(async (tx) => {
    const previous = await tx.getOperation(requested.id);
    if (previous) {
      if (
        previous.requestDigest !== requested.requestDigest ||
        previous.revisionId !== requested.revisionId ||
        previous.auditId !== requested.auditId ||
        previous.ownerUid !== requested.ownerUid ||
        previous.inputDigest !== requested.inputDigest ||
        previous.fence !== requested.fence ||
        JSON.stringify(previous.charges) !== JSON.stringify(requested.charges)
      )
        throw new AccountingConflict(
          'operation_conflict',
          'Idempotency payload mismatch',
        );
      return previous;
    }
    await tx.authorizeDispatch(requested);
    const counters = await loadCounters(tx, requested);
    for (const charge of requested.charges) {
      const counter = counterAt(counters, charge.counterKey);
      const reserved = checkedSum(counter.reserved, charge.amount);
      if (counter.halted || checkedSum(counter.spent, reserved) > counter.limit)
        throw new AccountingConflict(
          'budget_exhausted',
          'Insufficient unreserved budget',
        );
      counters.set(charge.counterKey, { ...counter, reserved });
    }
    for (const [key, counter] of counters) tx.putCounter(key, counter);
    tx.putOperation(requested);
    return requested;
  });
}

export async function markDispatching(
  store: AccountingStore,
  id: string,
  fence: number,
  now: string,
): Promise<Operation> {
  Timestamp.parse(now);
  return store.transaction(async (tx) => {
    const stored = await tx.getOperation(id);
    if (!stored || stored.fence !== fence || stored.outcome !== 'reserved')
      throw new AccountingConflict(
        'operation_conflict',
        'Operation is not dispatchable',
      );
    const operation = Operation.parse(stored);
    await tx.authorizeDispatch(operation);
    const counters = await loadCounters(tx, operation);
    for (const charge of operation.charges) {
      const counter = counterAt(counters, charge.counterKey);
      if (
        counter.halted ||
        checkedSum(counter.spent, counter.reserved) > counter.limit
      )
        throw new AccountingConflict(
          'budget_exhausted',
          'Dispatch disabled or policy reduced',
        );
      if (charge.consumeOnDispatch) {
        if (counter.reserved < charge.amount)
          throw new AccountingConflict(
            'invalid_accounting',
            'Reservation missing',
          );
        counters.set(charge.counterKey, {
          ...counter,
          reserved: counter.reserved - charge.amount,
          spent: checkedSum(counter.spent, charge.amount),
        });
      }
    }
    const next: Operation = {
      ...operation,
      outcome: 'dispatching',
      updatedAt: now,
    };
    const commitAdmission = await tx.prepareDispatch(operation, now);
    commitAdmission();
    for (const [key, counter] of counters) tx.putCounter(key, counter);
    tx.putOperation(next);
    return next;
  });
}

export async function markUnknown(
  store: AccountingStore,
  id: string,
  fence: number,
  now: string,
  providerHandle: string | null,
): Promise<void> {
  Timestamp.parse(now);
  await store.transaction(async (tx) => {
    const operation = await tx.getOperation(id);
    if (
      !operation ||
      operation.fence !== fence ||
      !['dispatching', 'unknown'].includes(operation.outcome)
    )
      throw new AccountingConflict('operation_conflict', 'Cannot mark unknown');
    // Deliberately do not release reservations on a timeout or expired scheduling lease.
    tx.putOperation(
      Operation.parse({
        ...operation,
        outcome: 'unknown',
        updatedAt: now,
        providerHandle,
      }),
    );
  });
}

export async function settleOperation(
  store: AccountingStore,
  id: string,
  fence: number,
  actualUsage: Record<string, number>,
  outcome: 'succeeded' | 'failed',
  now: string,
): Promise<Operation> {
  Timestamp.parse(now);
  const usage = z.record(z.string(), Count).parse(actualUsage);
  return store.transaction(async (tx) => {
    const stored = await tx.getOperation(id);
    if (!stored || stored.fence !== fence)
      throw new AccountingConflict('operation_conflict', 'Stale settlement');
    const operation = Operation.parse(stored);
    if (operation.outcome === 'succeeded' || operation.outcome === 'failed') {
      if (
        operation.outcome !== outcome ||
        Object.keys(usage).length !== operation.charges.length ||
        operation.charges.some(
          (charge) =>
            operation.usage?.[charge.counterKey] !== usage[charge.counterKey],
        )
      )
        throw new AccountingConflict(
          'operation_conflict',
          'Settlement replay differs',
        );
      return operation;
    }
    if (!['dispatching', 'unknown'].includes(operation.outcome))
      throw new AccountingConflict(
        'operation_conflict',
        'Operation was not dispatched',
      );
    if (Object.keys(usage).length !== operation.charges.length)
      throw new AccountingConflict(
        'invalid_accounting',
        'Exact usage coverage is required',
      );
    const counters = await loadCounters(tx, operation);
    for (const charge of operation.charges) {
      const actual = usage[charge.counterKey];
      if (actual === undefined)
        throw new AccountingConflict(
          'invalid_accounting',
          'Missing actual usage',
        );
      if (charge.consumeOnDispatch && actual !== charge.amount)
        throw new AccountingConflict(
          'invalid_accounting',
          'Dispatched attempt cannot be refunded',
        );
      if (!charge.consumeOnDispatch) {
        const counter = counterAt(counters, charge.counterKey);
        if (counter.reserved < charge.amount)
          throw new AccountingConflict(
            'invalid_accounting',
            'Reservation missing',
          );
        const spent = checkedSum(counter.spent, actual);
        const reserved = counter.reserved - charge.amount;
        // Record real overruns instead of hiding usage. Halt subsequent dispatch for reconciliation.
        counters.set(charge.counterKey, {
          ...counter,
          reserved,
          spent,
          halted:
            counter.halted ||
            actual > charge.amount ||
            checkedSum(spent, reserved) > counter.limit,
        });
      }
    }
    const next: Operation = { ...operation, outcome, usage, updatedAt: now };
    for (const [key, counter] of counters) tx.putCounter(key, counter);
    tx.putOperation(next);
    return next;
  });
}

/** Only a never-dispatched reservation is safely refundable during cancellation/deletion. */
export async function releaseUndispatched(
  store: AccountingStore,
  id: string,
  fence: number,
  now: string,
): Promise<Operation> {
  Timestamp.parse(now);
  return store.transaction(async (tx) => {
    const stored = await tx.getOperation(id);
    if (!stored || stored.fence !== fence)
      throw new AccountingConflict('operation_conflict', 'Stale release');
    const operation = Operation.parse(stored);
    if (
      operation.outcome === 'failed' &&
      operation.providerHandle === null &&
      operation.usage !== null &&
      operation.charges.every(
        (charge) => operation.usage?.[charge.counterKey] === 0,
      )
    )
      return operation;
    if (operation.outcome !== 'reserved')
      throw new AccountingConflict(
        'operation_conflict',
        'Dispatched or uncertain work cannot be refunded',
      );
    const counters = await loadCounters(tx, operation);
    for (const charge of operation.charges) {
      const counter = counterAt(counters, charge.counterKey);
      if (counter.reserved < charge.amount)
        throw new AccountingConflict(
          'invalid_accounting',
          'Reservation missing',
        );
      counters.set(charge.counterKey, {
        ...counter,
        reserved: counter.reserved - charge.amount,
      });
    }
    const next: Operation = {
      ...operation,
      outcome: 'failed',
      updatedAt: now,
      usage: Object.fromEntries(
        operation.charges.map((charge) => [charge.counterKey, 0]),
      ),
    };
    for (const [key, counter] of counters) tx.putCounter(key, counter);
    tx.putOperation(next);
    return next;
  });
}
