import { z } from 'zod';
import { DEFAULT_POLICY, type ResourcePolicy } from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import { sha256 } from './hashing.js';
import { ApiError } from './errors.js';

export interface UserRateGate {
  consume(uid: string, mutation: boolean): Promise<void>;
}
const entry = z.strictObject({
  at: z.number().int().nonnegative(),
  mutation: z.boolean(),
});
const windowSchema = z.object({ entries: z.array(entry).max(1000) });

/** Distributed exact rolling window. User limits must never rely on process-local memory. */
export class FirestoreUserRateGate implements UserRateGate {
  constructor(
    private readonly client: DocumentStore,
    private readonly policy: Readonly<ResourcePolicy> = DEFAULT_POLICY,
    private readonly clock: () => number = Date.now,
  ) {}
  async consume(uid: string, mutation: boolean): Promise<void> {
    const key = await sha256(uid);
    const now = this.clock();
    await this.client.transaction(async (tx) => {
      const stored = await tx.get(`rateWindows/${key}`);
      const entries = stored
        ? windowSchema
            .parse(stored)
            .entries.filter((item) => item.at > now - 60_000)
        : [];
      if (
        entries.length >= this.policy.requestsPerMinute ||
        (mutation &&
          entries.filter((item) => item.mutation).length >=
            this.policy.mutationsPerMinute)
      )
        throw new ApiError(
          429,
          'rate_limited',
          'Request limit reached. Try again shortly.',
          true,
        );
      entries.push({ at: now, mutation });
      tx.set(`rateWindows/${key}`, {
        schemaVersion: '1.0',
        entries,
        updatedAt: new Date(now),
      });
    });
  }
}
