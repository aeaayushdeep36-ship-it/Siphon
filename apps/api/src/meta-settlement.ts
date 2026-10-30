import {
  type AccountingStore,
  Operation,
  markUnknown,
  settleOperation,
} from './accounting.js';
import { MetaFailure, type MetaUsage } from './meta-client.js';
import { MetaPricing, settleMetaCost } from './meta-pricing.js';

export type ModelCompletion =
  | { kind: 'succeeded'; usage: MetaUsage }
  | { kind: 'failed'; failure: MetaFailure };

/** Internal settlement for a persisted dispatched model operation. The pricing
 * snapshot must come from its immutable job record, never a client request.
 * This does not reserve/dispatch or publish model output as trusted evidence.
 */
export async function settleModelCompletion(
  store: AccountingStore,
  operationValue: Operation,
  pricingValue: unknown,
  completion: ModelCompletion,
  now: string,
): Promise<void> {
  const operation = Operation.parse(operationValue);
  const pricing = MetaPricing.parse(pricingValue);
  const money = operation.charges.filter(
    (charge) => charge.unit === 'micro_usd' && !charge.consumeOnDispatch,
  );
  const attempts = operation.charges.filter(
    (charge) =>
      charge.unit === 'attempts' &&
      charge.consumeOnDispatch &&
      charge.amount === 1,
  );
  if (
    money.length < 2 ||
    attempts.length < 1 ||
    money.length + attempts.length !== operation.charges.length ||
    money.some((charge) => charge.amount !== money[0]!.amount)
  )
    throw new Error('Invalid model operation charge mapping');
  // Reject a forged/stale snapshot before using its charge keys to settle.
  await store.transaction(async (tx) => {
    const persisted = await tx.getOperation(operation.id);
    if (
      !persisted ||
      persisted.requestDigest !== operation.requestDigest ||
      persisted.ownerUid !== operation.ownerUid ||
      persisted.auditId !== operation.auditId ||
      persisted.revisionId !== operation.revisionId ||
      persisted.inputDigest !== operation.inputDigest ||
      persisted.fence !== operation.fence ||
      JSON.stringify(persisted.charges) !== JSON.stringify(operation.charges)
    )
      throw new Error('Model operation snapshot mismatch');
  });
  const usage =
    completion.kind === 'succeeded'
      ? completion.usage
      : completion.failure.usage;
  if (!usage) {
    await markUnknown(
      store,
      operation.id,
      operation.fence,
      now,
      operation.providerHandle,
    );
    return;
  }
  const microUsd = settleMetaCost(pricing, usage);
  const actual = Object.fromEntries(
    operation.charges.map((charge) => [
      charge.counterKey,
      charge.unit === 'micro_usd' ? microUsd : 1,
    ]),
  );
  await settleOperation(
    store,
    operation.id,
    operation.fence,
    actual,
    completion.kind === 'succeeded' ? 'succeeded' : 'failed',
    now,
  );
}
