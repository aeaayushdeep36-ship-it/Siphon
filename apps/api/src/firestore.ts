import { z } from 'zod';
import { Timestamp } from '@siphon/contracts';
import { readJsonBounded } from './http.js';
import {
  DEFAULT_FIRESTORE_DATABASE_ID,
  FirestoreDatabaseId,
} from './firebase-config.js';

export type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { timestampValue: string }
  | { arrayValue: { values?: FirestoreValue[] | undefined } }
  | { mapValue: { fields?: Record<string, FirestoreValue> | undefined } };

const valueSchema: z.ZodType<FirestoreValue> = z.lazy(() =>
  z.union([
    z.strictObject({ nullValue: z.null() }),
    z.strictObject({ booleanValue: z.boolean() }),
    z.strictObject({ integerValue: z.string().regex(/^-?\d+$/) }),
    z.strictObject({ doubleValue: z.number().finite() }),
    z.strictObject({ stringValue: z.string() }),
    z.strictObject({ timestampValue: Timestamp }),
    z.strictObject({
      arrayValue: z.strictObject({ values: z.array(valueSchema).optional() }),
    }),
    z.strictObject({
      mapValue: z.strictObject({
        fields: z.record(z.string(), valueSchema).optional(),
      }),
    }),
  ]),
);

export function encodeValue(value: unknown, depth = 0): FirestoreValue {
  if (depth > 20) throw new Error('Firestore nesting limit');
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value))
        throw new Error('Unsafe Firestore integer');
      return { integerValue: String(value) };
    }
    return { doubleValue: value };
  }
  if (value instanceof Date)
    return { timestampValue: Timestamp.parse(value.toISOString()) };
  if (Array.isArray(value)) {
    if (value.some(Array.isArray))
      throw new Error('Firestore does not support nested arrays');
    return {
      arrayValue: { values: value.map((item) => encodeValue(item, depth + 1)) },
    };
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            encodeValue(item, depth + 1),
          ]),
        ),
      },
    };
  throw new Error('Unsupported Firestore value');
}

export function decodeValue(input: unknown): unknown {
  return decodeValidated(valueSchema.parse(input));
}
function decodeValidated(value: FirestoreValue): unknown {
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('stringValue' in value) return value.stringValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('doubleValue' in value) return value.doubleValue;
  if ('integerValue' in value) {
    const number = Number(value.integerValue);
    if (!Number.isSafeInteger(number))
      throw new Error('Unsafe Firestore integer');
    return number;
  }
  if ('arrayValue' in value)
    return (value.arrayValue.values ?? []).map(decodeValidated);
  return Object.fromEntries(
    Object.entries(value.mapValue.fields ?? {}).map(([key, item]) => [
      key,
      decodeValidated(item),
    ]),
  );
}

export interface DocumentTransaction {
  get(path: string): Promise<Record<string, unknown> | null>;
  /** Same transaction snapshot, caller order preserved; duplicate paths are read once. */
  getMany(
    paths: readonly string[],
  ): Promise<Array<Record<string, unknown> | null>>;
  set(path: string, value: Record<string, unknown>): void;
  delete(path: string): void;
}

export interface DocumentStore {
  get(path: string): Promise<Record<string, unknown> | null>;
  getMany(
    paths: readonly string[],
  ): Promise<Array<Record<string, unknown> | null>>;
  transaction<T>(callback: (tx: DocumentTransaction) => Promise<T>): Promise<T>;
}

export class FirestoreFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly ambiguousCommit: boolean,
    public readonly source: 'http' | 'transport' | 'response' = 'response',
    public readonly reason:
      | 'missing_index'
      | 'invalid_query'
      | 'permission_denied'
      | 'api_disabled'
      | 'other' = 'other',
    public readonly apiStatus:
      | 'INVALID_ARGUMENT'
      | 'FAILED_PRECONDITION'
      | 'PERMISSION_DENIED'
      | 'UNAUTHENTICATED'
      | 'NOT_FOUND'
      | 'SERVICE_DISABLED'
      | 'RESOURCE_EXHAUSTED'
      | 'UNAVAILABLE'
      | 'other' = 'other',
  ) {
    super(
      ambiguousCommit
        ? 'Firestore commit outcome unknown'
        : 'Firestore request failed',
    );
  }
}

function safePath(path: string): string {
  const parts = path.split('/');
  if (
    parts.length % 2 !== 0 ||
    parts.some((part) => !/^[a-zA-Z0-9_-]{1,200}$/.test(part))
  )
    throw new Error('Invalid document path');
  return path;
}

export class FirestoreClient {
  readonly database: string;
  constructor(
    projectId: string,
    private readonly accessToken: () => Promise<string>,
    private readonly transport: typeof fetch = fetch,
    databaseId = DEFAULT_FIRESTORE_DATABASE_ID,
  ) {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId))
      throw new Error('Invalid Firebase project ID');
    const parsedDatabase = FirestoreDatabaseId.safeParse(databaseId);
    if (!parsedDatabase.success)
      throw new Error('Invalid Firestore database ID');
    this.database = `projects/${projectId}/databases/${parsedDatabase.data}`;
  }

  private async request(
    suffix: string,
    method: 'GET' | 'POST',
    body?: unknown,
    commit = false,
  ): Promise<unknown> {
    const token = await this.accessToken();
    if (!token || /[\r\n]/.test(token))
      throw new Error('Invalid OAuth credential');
    let response: Response;
    try {
      const transport = this.transport;
      response = await transport(
        `https://firestore.googleapis.com/v1/${this.database}/documents${suffix}`,
        {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(10_000),
          redirect: 'manual',
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      const errorCode =
        error instanceof TypeError && message.includes('fetch failed')
          ? 'network_fetch_type_error'
          : error instanceof TypeError &&
              (message.includes('url') || message.includes('request'))
            ? 'request_url_type_error'
            : error instanceof TypeError && message.includes('redirect')
              ? 'redirect_mode_type_error'
              : error instanceof TypeError && message.includes('signal')
                ? 'request_signal_type_error'
                : error instanceof TypeError && message.includes('body')
                  ? 'request_body_type_error'
                  : error instanceof TypeError && message.includes('header')
                    ? 'request_header_type_error'
                    : error instanceof TypeError && message.includes('network')
                      ? 'network_fetch_type_error'
                      : error instanceof Error &&
                          ['TimeoutError', 'AbortError'].includes(error.name)
                        ? 'request_cancelled'
                        : 'other_transport_error';
      console.error('firestore_transport_failed', {
        errorCode,
        errorType:
          error instanceof Error ? error.constructor.name : typeof error,
        causeType:
          error instanceof Error && error.cause instanceof Error
            ? error.cause.constructor.name
            : undefined,
      });
      throw new FirestoreFailure(503, commit, 'transport');
    }
    if (!response.ok) {
      let reason: FirestoreFailure['reason'] = 'other';
      let apiStatus: FirestoreFailure['apiStatus'] = 'other';
      try {
        const payload = await readJsonBounded(response, 16 * 1024);
        const payloadEntry = Array.isArray(payload) ? payload[0] : payload;
        const payloadRecord =
          typeof payloadEntry === 'object' &&
          payloadEntry !== null &&
          !Array.isArray(payloadEntry)
            ? payloadEntry
            : null;
        const nestedError =
          payloadRecord &&
          'error' in payloadRecord &&
          typeof payloadRecord.error === 'object' &&
          payloadRecord.error !== null
            ? payloadRecord.error
            : null;
        const errorRecord = nestedError ?? payloadRecord;
        const remoteMessage =
          payloadRecord &&
          'error' in payloadRecord &&
          typeof payloadRecord.error === 'string'
            ? payloadRecord.error
            : errorRecord &&
                'message' in errorRecord &&
                typeof errorRecord.message === 'string'
              ? errorRecord.message
              : typeof payload === 'string'
                ? payload
                : '';
        const message = remoteMessage.toLowerCase();
        const status =
          errorRecord &&
          'status' in errorRecord &&
          typeof errorRecord.status === 'string'
            ? errorRecord.status
            : payloadRecord &&
                'status' in payloadRecord &&
                typeof payloadRecord.status === 'string'
              ? payloadRecord.status
              : undefined;
        apiStatus =
          status &&
          [
            'INVALID_ARGUMENT',
            'FAILED_PRECONDITION',
            'PERMISSION_DENIED',
            'UNAUTHENTICATED',
            'NOT_FOUND',
            'SERVICE_DISABLED',
            'RESOURCE_EXHAUSTED',
            'UNAVAILABLE',
          ].includes(status)
            ? (status as Exclude<FirestoreFailure['apiStatus'], 'other'>)
            : 'other';
        reason = message.includes('index')
          ? 'missing_index'
          : message.includes('invalid argument') ||
              message.includes('invalid query')
            ? 'invalid_query'
            : message.includes('permission') || message.includes('denied')
              ? 'permission_denied'
              : message.includes('not enabled')
                ? 'api_disabled'
                : apiStatus === 'FAILED_PRECONDITION'
                  ? 'missing_index'
                  : apiStatus === 'INVALID_ARGUMENT'
                    ? 'invalid_query'
                    : apiStatus === 'PERMISSION_DENIED' ||
                        apiStatus === 'UNAUTHENTICATED'
                      ? 'permission_denied'
                      : apiStatus === 'SERVICE_DISABLED'
                        ? 'api_disabled'
                        : 'other';
      } catch {
        await response.body?.cancel().catch(() => undefined);
      }
      throw new FirestoreFailure(
        response.status,
        commit && response.status !== 409,
        'http',
        reason,
        apiStatus,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new FirestoreFailure(503, commit, 'response');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 1_048_576) {
          await reader.cancel();
          throw new Error('Oversized response');
        }
        chunks.push(chunk.value);
      }
      const buffer = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
          buffer,
        ),
      ) as unknown;
    } catch {
      throw new FirestoreFailure(503, commit);
    } finally {
      reader.releaseLock();
    }
  }

  async get(
    path: string,
    transaction?: string,
  ): Promise<Record<string, unknown> | null> {
    if (transaction !== undefined)
      return (await this.getMany([path], transaction))[0]!;
    const suffix = `/${safePath(path)}`;
    try {
      const result = z
        .object({ fields: z.record(z.string(), valueSchema).optional() })
        .parse(await this.request(suffix, 'GET'));
      return Object.fromEntries(
        Object.entries(result.fields ?? {}).map(([key, value]) => [
          key,
          decodeValidated(value),
        ]),
      );
    } catch (error) {
      if (error instanceof FirestoreFailure && error.status === 404)
        return null;
      throw error;
    }
  }

  async listCollection(
    collection: string,
    pageSize = 100,
  ): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(collection))
      throw new Error('Invalid Firestore collection name');
    const clampedSize = Math.max(1, Math.min(300, Math.floor(pageSize)));
    const result = z
      .object({
        documents: z
          .array(
            z.object({
              name: z.string(),
              fields: z.record(z.string(), valueSchema).optional(),
            }),
          )
          .optional(),
      })
      .parse(
        await this.request(
          `/${collection}?pageSize=${clampedSize}`,
          'GET',
        ),
      );
    return (result.documents ?? []).map((doc) => {
      const id = doc.name.split('/').pop() ?? '';
      const data = Object.fromEntries(
        Object.entries(doc.fields ?? {}).map(([key, value]) => [
          key,
          decodeValidated(value),
        ]),
      );
      return { id, data };
    });
  }

  /** Owner-constrained paginated UI history, never a caller-supplied query. */
  async history(
    uid: string,
    auditId: string | null,
    limit: number,
    cursor: { createdAt: string; id: string } | null,
  ) {
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(uid) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 20
    )
      throw new Error('Invalid history request');
    if (auditId !== null && !z.string().uuid().safeParse(auditId).success)
      throw new Error('Invalid history scope');
    const collection = auditId === null ? 'audits' : 'revisions';
    const prefix = auditId === null ? '' : `/audits/${auditId}`;
    const filters: unknown[] = [
      {
        fieldFilter: {
          field: { fieldPath: 'ownerUid' },
          op: 'EQUAL',
          value: { stringValue: uid },
        },
      },
    ];
    if (auditId === null)
      filters.push({
        unaryFilter: {
          field: { fieldPath: 'deletionRequestedAt' },
          op: 'IS_NULL',
        },
      });
    const startAfter =
      cursor === null
        ? {}
        : {
            startAt: {
              before: false,
              values: [
                { timestampValue: Timestamp.parse(cursor.createdAt) },
                {
                  referenceValue: `${this.database}/documents${prefix}/${collection}/${z.string().uuid().parse(cursor.id)}`,
                },
              ],
            },
          };
    const result = z
      .array(
        z.object({
          document: z
            .object({
              name: z.string(),
              fields: z.record(z.string(), valueSchema).optional(),
            })
            .optional(),
        }),
      )
      .max(21)
      .parse(
        await this.request(`${prefix}:runQuery`, 'POST', {
          structuredQuery: {
            from: [{ collectionId: collection }],
            where:
              filters.length === 1
                ? filters[0]
                : { compositeFilter: { op: 'AND', filters } },
            orderBy: [
              { field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' },
              { field: { fieldPath: '__name__' }, direction: 'DESCENDING' },
            ],
            limit: limit + 1,
            ...startAfter,
          },
        }),
      );
    const expectedPrefix = `${this.database}/documents${prefix}/${collection}/`;
    const seen = new Set<string>();
    return result.flatMap((row) => {
      if (!row.document) return [];
      const id = row.document.name.slice(expectedPrefix.length);
      if (
        !row.document.name.startsWith(expectedPrefix) ||
        !z.string().uuid().safeParse(id).success ||
        seen.has(id)
      )
        throw new Error('History document identity mismatch');
      seen.add(id);
      const record = Object.fromEntries(
        Object.entries(row.document.fields ?? {}).map(([key, value]) => [
          key,
          decodeValidated(value),
        ]),
      );
      if (
        record.ownerUid !== uid ||
        (auditId === null
          ? record.id !== id || record.deletionRequestedAt !== null
          : record.revisionId !== id || record.auditId !== auditId)
      )
        throw new Error('History owner/scope mismatch');
      return [record];
    });
  }

  /** Firestore batchGet may return found/missing rows in any order. Never
   * associate a result by its position or treat an incomplete response as missing.
   */
  async getMany(
    paths: readonly string[],
    transaction?: string,
  ): Promise<Array<Record<string, unknown> | null>> {
    if (paths.length > 40) throw new Error('Batch read bound exceeded');
    const checked = paths.map(safePath);
    if (!checked.length) return [];
    const prefix = `${this.database}/documents/`;
    const names = [...new Set(checked.map((path) => prefix + path))];
    const rows = z
      .array(
        z
          .object({
            found: z
              .object({
                name: z.string(),
                fields: z.record(z.string(), valueSchema).optional(),
              })
              .optional(),
            missing: z.string().optional(),
            transaction: z.string().optional(),
          })
          .refine(
            (row) => (row.found !== undefined) !== (row.missing !== undefined),
          ),
      )
      .max(40)
      .parse(
        await this.request(':batchGet', 'POST', {
          documents: names,
          ...(transaction === undefined ? {} : { transaction }),
        }),
      );
    const expected = new Set(names);
    const values = new Map<string, Record<string, unknown> | null>();
    for (const row of rows) {
      const name = row.found?.name ?? row.missing!;
      if (
        !expected.has(name) ||
        values.has(name) ||
        (row.transaction !== undefined && row.transaction !== transaction)
      )
        throw new Error('Batch read response identity mismatch');
      values.set(
        name,
        row.found
          ? Object.fromEntries(
              Object.entries(row.found.fields ?? {}).map(([key, value]) => [
                key,
                decodeValidated(value),
              ]),
            )
          : null,
      );
    }
    if (values.size !== expected.size)
      throw new Error('Batch read response is incomplete');
    return checked.map((path) => structuredClone(values.get(prefix + path)!));
  }

  /** No retries: an ambiguous commit must be reconciled by stable operation identity. */
  async transaction<T>(
    callback: (tx: DocumentTransaction) => Promise<T>,
  ): Promise<T> {
    const { transaction } = z
      .object({ transaction: z.string().min(1) })
      .parse(await this.request(':beginTransaction', 'POST', {}));
    const writes = new Map<string, unknown>();
    let writing = false;
    const reads = new Map<string, Promise<Record<string, unknown> | null>>();
    let committing = false;
    const stageWrite = (path: string, write: unknown) => {
      writing = true;
      if (!writes.has(path) && writes.size >= 40)
        throw new Error('Transaction write bound exceeded');
      writes.set(path, write);
    };
    const beforeReads = (paths: readonly string[]) => {
      if (writing) throw new Error('All transaction reads must precede writes');
      if (paths.length > 40) throw new Error('Transaction read bound exceeded');
      const checked = paths.map(safePath);
      const missing = [...new Set(checked)].filter((path) => !reads.has(path));
      if (reads.size + missing.length > 40)
        throw new Error('Transaction read bound exceeded');
      return { checked, missing };
    };
    const remember = (
      path: string,
      value: Promise<Record<string, unknown> | null>,
    ) => {
      reads.set(path, value);
      // An initiated read must still fail commit even if a caller forgets to await
      // it. Observe rejection now; the original promise is awaited before commit.
      void value.catch(() => undefined);
    };
    const getMany = (paths: readonly string[]) => {
      const { checked, missing } = beforeReads(paths);
      if (missing.length) {
        const batch = this.getMany(missing, transaction);
        for (const [index, path] of missing.entries())
          remember(
            path,
            batch.then((values) => values[index]!),
          );
      }
      const result = Promise.all(
        checked.map(async (path) => structuredClone(await reads.get(path)!)),
      );
      void result.catch(() => undefined);
      return result;
    };
    try {
      const result = await callback({
        get: (path) => {
          const { checked } = beforeReads([path]);
          const key = checked[0]!;
          if (!reads.has(key)) remember(key, this.get(key, transaction));
          const result = reads
            .get(key)!
            .then((value) => structuredClone(value));
          void result.catch(() => undefined);
          return result;
        },
        getMany,
        set: (path, value) => {
          const encoded = encodeValue(value);
          if (!('mapValue' in encoded))
            throw new Error('Document must be a map');
          stageWrite(path, {
            update: {
              name: `${this.database}/documents/${safePath(path)}`,
              fields: encoded.mapValue.fields,
            },
          });
        },
        delete: (path) =>
          stageWrite(path, {
            delete: `${this.database}/documents/${safePath(path)}`,
          }),
      });
      await Promise.all(reads.values());
      committing = true;
      await this.request(
        ':commit',
        'POST',
        { transaction, writes: [...writes.values()] },
        true,
      );
      return result;
    } catch (error) {
      if (!committing) {
        // Cleanup failure must not replace the primary error; provider expires abandoned transactions.
        await this.request(':rollback', 'POST', { transaction }).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }
}
