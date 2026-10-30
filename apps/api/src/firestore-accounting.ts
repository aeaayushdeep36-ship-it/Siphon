import {
  BudgetCounter,
  Operation,
  type AccountingStore,
  type AccountingTransaction,
} from './accounting.js';
import { type DocumentStore, type DocumentTransaction } from './firestore.js';
import { requireActiveRevision } from './audit-commands.js';
import { DEFAULT_POLICY, Id, ResourcePolicy } from '@siphon/contracts';
import { prepareAdmissionDispatch } from './admission.js';
import { ApiError } from './errors.js';

export class FirestoreAccountingStore implements AccountingStore {
  private readonly policy: ResourcePolicy;
  constructor(
    private readonly client: DocumentStore,
    policy: ResourcePolicy = DEFAULT_POLICY,
    private readonly validateProviderDispatch?: (
      tx: DocumentTransaction,
      operation: Operation,
    ) => Promise<void>,
  ) {
    this.policy = ResourcePolicy.parse(policy);
  }
  transaction<T>(
    callback: (tx: AccountingTransaction) => Promise<T>,
  ): Promise<T> {
    return this.client.transaction((raw) => {
      const pending = new Map<
        string,
        Promise<Record<string, unknown> | null>
      >();
      let writing = false;
      const tx: DocumentTransaction = {
        get: async (path) => {
          if (writing)
            throw new Error('All transaction reads must precede writes');
          let read = pending.get(path);
          if (!read) {
            read = raw.get(path);
            pending.set(path, read);
          }
          return structuredClone(await read);
        },
        getMany: async (paths) => {
          if (writing)
            throw new Error('All transaction reads must precede writes');
          const missing = [...new Set(paths)].filter(
            (path) => !pending.has(path),
          );
          if (missing.length) {
            const batch = raw.getMany(missing);
            for (const [index, path] of missing.entries()) {
              const read = batch.then((values) => values[index]!);
              pending.set(path, read);
              void read.catch(() => undefined);
            }
          }
          return Promise.all(
            paths.map(async (path) =>
              structuredClone(await pending.get(path)!),
            ),
          );
        },
        set: (path, value) => {
          writing = true;
          raw.set(path, value);
        },
        delete: (path) => {
          writing = true;
          raw.delete(path);
        },
      };
      return callback({
        prepareDispatch: async (operation, now) => {
          await this.validateProviderDispatch?.(tx, operation);
          const revision = await tx.get(
            `audits/${operation.auditId}/revisions/${operation.revisionId}`,
          );
          if (revision?.slotLeaseId == null)
            throw new ApiError(
              409,
              'capacity_required',
              'Reserve execution capacity before dispatch.',
            );
          return prepareAdmissionDispatch(
            tx,
            operation.ownerUid,
            {
              auditId: operation.auditId,
              revisionId: operation.revisionId,
              generation: operation.fence,
              inputDigest: operation.inputDigest,
            },
            Id.parse(revision.slotLeaseId),
            new Date(now),
            this.policy,
            operation,
          );
        },
        authorizeDispatch: async (operation) => {
          await requireActiveRevision(tx, operation.ownerUid, {
            auditId: operation.auditId,
            revisionId: operation.revisionId,
            generation: operation.fence,
            inputDigest: operation.inputDigest,
          });
        },
        getOperation: async (id) => {
          const document = await tx.get(`operations/${id}`);
          return document ? Operation.parse(document) : null;
        },
        getCounters: async (keys) => {
          const documents = await tx.getMany(
            keys.map((key) => `budgets/${key}`),
          );
          return documents.map((document) =>
            document ? BudgetCounter.parse(document) : null,
          );
        },
        putOperation: (operation) =>
          tx.set(`operations/${operation.id}`, {
            ...operation,
            createdAt: new Date(operation.createdAt),
            updatedAt: new Date(operation.updatedAt),
          }),
        putCounter: (key, counter) => tx.set(`budgets/${key}`, counter),
      });
    });
  }
}
