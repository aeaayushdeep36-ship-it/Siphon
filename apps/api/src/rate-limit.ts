import { z } from 'zod';
import { DEFAULT_POLICY, type ResourcePolicy } from '@siphon/contracts';
import { FirestoreFailure, type DocumentStore } from './firestore.js';
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
    let phase = 'hash_user_key';
    try {
      const key = await sha256(uid);
      const now = this.clock();
      phase = 'rate_window_transaction';
      await this.client.transaction(async (tx) => {
        phase = 'read_rate_window';
        const stored = await tx.get(`rateWindows/${key}`);
        phase = 'validate_rate_window';
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
        phase = 'write_rate_window';
        tx.set(`rateWindows/${key}`, {
          schemaVersion: '1.0',
          entries,
          updatedAt: new Date(now),
        });
        phase = 'commit_rate_window';
      });
    } catch (error) {
      if (!(error instanceof ApiError))
        console.error('siphon_user_rate_gate_error', {
          phase,
          firestoreStatus:
            error instanceof FirestoreFailure ? error.status : undefined,
          ambiguousCommit:
            error instanceof FirestoreFailure
              ? error.ambiguousCommit
              : undefined,
          firestoreFailureSource:
            error instanceof FirestoreFailure ? error.source : undefined,
          firestoreFailureReason:
            error instanceof FirestoreFailure ? error.reason : undefined,
          firestoreApiStatus:
            error instanceof FirestoreFailure ? error.apiStatus : undefined,
          errorType:
            error instanceof Error ? error.constructor.name : typeof error,
        });
      throw error;
    }
  }
}
