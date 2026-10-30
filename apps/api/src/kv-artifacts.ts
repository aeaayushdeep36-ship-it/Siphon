import { z } from 'zod';
import { Count, Digest, Id, Timestamp } from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import { type DownloadObjectStore } from './artifact-download.js';
import { type UploadObjectStore } from './r2-upload.js';
import { canonicalJson, sha256 } from './hashing.js';
import { nativeTimestamps } from './audit-commands.js';

export interface KvArtifactBinding {
  put(
    key: string,
    value: ArrayBuffer,
    options: { expiration: number },
  ): Promise<void>;
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
}
const PART_BYTES = 8 * 1024 * 1024,
  MAX_OBJECT = 50 * 1024 * 1024;
const Manifest = z.strictObject({
  schemaVersion: z.literal('1.0'),
  logicalKey: z.string().max(600),
  sha256: Digest,
  bytes: Count.max(MAX_OBJECT),
  parts: z
    .array(
      z.strictObject({
        key: z.string().max(200),
        bytes: Count.max(PART_BYTES),
        sha256: Digest,
      }),
    )
    .max(7),
  status: z.enum(['writing', 'ready', 'unknown']),
  invocationId: Id,
  leaseUntil: Timestamp,
  expiresAt: Timestamp,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
type Manifest = z.infer<typeof Manifest>;
const Daily = z.strictObject({
  schemaVersion: z.literal('1.0'),
  reads: Count,
  writes: Count,
});
const digest = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (n) => n.toString(16).padStart(2, '0'),
  ).join('');
type Pending = {
  key: string;
  path: string;
  signal: AbortSignal;
  resolve: (value: Awaited<ReturnType<KvArtifacts['get']>>) => void;
  reject: (error: Error) => void;
};

/** KV is eventually consistent and has no atomic create-only write. Firestore
 * owns immutable content manifests/leases; content-addressed parts can only be
 * rewritten with identical bytes/expiry. A missing KV replica is an error, never
 * permission to substitute bytes or publish an unconfirmed artifact.
 */
export class KvArtifacts implements UploadObjectStore, DownloadObjectStore {
  private pending: Pending[] = [];
  constructor(
    private readonly kv: KvArtifactBinding,
    private readonly documents: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (typeof kv?.put !== 'function' || typeof kv?.get !== 'function')
      throw new Error('Private KV binding unavailable');
  }
  private key(value: string) {
    if (
      !/^audits\/[A-Za-z0-9_-]{1,128}\/[a-fA-F0-9-]{36}\/artifacts\/[a-fA-F0-9-]{36}\/content$/.test(
        value,
      )
    )
      throw new Error('Invalid private artifact key');
    return value;
  }
  async putOnce(
    keyValue: string,
    input: Uint8Array<ArrayBuffer>,
    claimedHash: string,
    retention?: { expiresAt: string },
  ) {
    const key = this.key(keyValue),
      hash = Digest.parse(claimedHash),
      bytes = new Uint8Array(input),
      now = this.clock();
    if (
      bytes.length > MAX_OBJECT ||
      (await digest(bytes)) !== hash ||
      !retention
    )
      throw new Error('KV artifact input invalid');
    const expiresAt = new Date(
        Timestamp.parse(retention.expiresAt),
      ).toISOString(),
      expiration = Math.floor(Date.parse(expiresAt) / 1000);
    if (
      expiration * 1000 < now.getTime() + 61000 ||
      Date.parse(expiresAt) > now.getTime() + 30 * 86400_000
    )
      throw new Error('KV retention invalid');
    const objectId = await sha256(key),
      path = `storageObjects/${objectId}`,
      invocationId = crypto.randomUUID();
    const parts: Manifest['parts'] = [];
    for (let offset = 0; offset < bytes.length; offset += PART_BYTES) {
      const chunk = bytes.slice(offset, offset + PART_BYTES);
      parts.push({
        key: `siphon/${objectId}/${hash}/${parts.length}`,
        bytes: chunk.length,
        sha256: await digest(chunk),
      });
    }
    const claimed = await this.documents.transaction(async (tx) => {
      const date = now.toISOString().slice(0, 10),
        dailyPath = `storageKvDays/${date}`;
      const [saved, rawDaily, rawStorage] = await tx.getMany([
        path,
        dailyPath,
        'budgets/kv_storage_bytes',
      ]);
      const old = saved ? Manifest.parse(saved) : null;
      if (
        old &&
        (old.logicalKey !== key ||
          old.sha256 !== hash ||
          old.bytes !== bytes.length ||
          old.expiresAt !== expiresAt ||
          canonicalJson(old.parts) !== canonicalJson(parts))
      )
        throw new Error('Immutable KV content conflict');
      if (old?.status === 'ready') return false;
      if (
        old?.status === 'writing' &&
        Date.parse(old.leaseUntil) > now.getTime()
      )
        throw new Error('KV artifact write already claimed');
      const daily = rawDaily
        ? Daily.parse(rawDaily)
        : { schemaVersion: '1.0' as const, reads: 0, writes: 0 };
      if (daily.writes + parts.length > 800)
        throw new Error('KV free write allowance exhausted');
      const storage = z
        .strictObject({ schemaVersion: z.literal('1.0'), allocated: Count })
        .parse(rawStorage ?? { schemaVersion: '1.0', allocated: 0 });
      if (storage.allocated + (old ? 0 : bytes.length) > 512 * 1024 * 1024)
        throw new Error('KV free storage allowance exhausted');
      const record = Manifest.parse({
        schemaVersion: '1.0',
        logicalKey: key,
        sha256: hash,
        bytes: bytes.length,
        parts,
        status: 'writing',
        invocationId,
        leaseUntil: new Date(now.getTime() + 60000).toISOString(),
        expiresAt,
        createdAt: old?.createdAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
      });
      tx.set(path, nativeTimestamps(record));
      tx.set(dailyPath, { ...daily, writes: daily.writes + parts.length });
      if (!old)
        tx.set('budgets/kv_storage_bytes', {
          ...storage,
          allocated: storage.allocated + bytes.length,
        });
      return true;
    });
    if (!claimed) return { size: bytes.length, sha256: hash };
    try {
      for (const [index, part] of parts.entries())
        await this.kv.put(
          part.key,
          bytes.slice(index * PART_BYTES, index * PART_BYTES + part.bytes)
            .buffer,
          { expiration },
        );
      await this.documents.transaction(async (tx) => {
        const current = Manifest.parse(await tx.get(path));
        if (
          current.invocationId !== invocationId ||
          current.status !== 'writing' ||
          this.clock().getTime() >= Date.parse(current.leaseUntil)
        )
          throw new Error('KV write claim expired');
        tx.set(
          path,
          nativeTimestamps({
            ...current,
            status: 'ready',
            updatedAt: this.clock().toISOString(),
          }),
        );
      });
    } catch {
      await this.documents
        .transaction(async (tx) => {
          const current = Manifest.parse(await tx.get(path));
          if (
            current.invocationId === invocationId &&
            current.status === 'writing'
          )
            tx.set(
              path,
              nativeTimestamps({
                ...current,
                status: 'unknown',
                updatedAt: this.clock().toISOString(),
              }),
            );
        })
        .catch(() => undefined);
      throw new Error('KV artifact write requires reconciliation');
    }
    return { size: bytes.length, sha256: hash };
  }
  async get(
    keyValue: string,
    signal: AbortSignal,
  ): Promise<{
    size: number;
    sha256: string;
    body: ReadableStream<Uint8Array>;
  } | null> {
    const key = this.key(keyValue);
    signal.throwIfAborted();
    const path = `storageObjects/${await sha256(key)}`;
    return new Promise((resolve, reject) => {
      this.pending.push({ key, path, signal, resolve, reject });
      if (this.pending.length === 1)
        queueMicrotask(() => {
          const batch = this.pending.splice(0, 10);
          void this.readGroup(batch);
          if (this.pending.length) void this.drain();
        });
    });
  }
  async getMany(keys: readonly string[], signal: AbortSignal) {
    if (
      keys.length < 1 ||
      keys.length > 10 ||
      new Set(keys).size !== keys.length
    )
      throw new Error('Invalid private storage batch');
    signal.throwIfAborted();
    const paths = await Promise.all(
      keys.map(async (key) => `storageObjects/${await sha256(this.key(key))}`),
    );
    const promises: Array<Promise<Awaited<ReturnType<KvArtifacts['get']>>>> =
      [];
    const batch = keys.map((key, index) => {
      let resolve!: (value: Awaited<ReturnType<KvArtifacts['get']>>) => void,
        reject!: (error: Error) => void;
      promises.push(
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
      );
      return { key, path: paths[index]!, signal, resolve, reject };
    });
    const settled = Promise.allSettled(promises);
    await this.readGroup(batch);
    const results = await settled;
    const failed = results.find((item) => item.status === 'rejected');
    if (failed) {
      await Promise.allSettled(
        results.map((item) =>
          item.status === 'fulfilled' ? item.value?.body.cancel() : undefined,
        ),
      );
      throw new Error('Private storage batch unavailable');
    }
    return results.map((item) =>
      item.status === 'fulfilled' ? item.value : null,
    );
  }
  private async drain() {
    while (this.pending.length)
      await this.readGroup(this.pending.splice(0, 10));
  }
  private async readGroup(batch: Pending[]) {
    try {
      const now = this.clock(),
        dailyPath = `storageKvDays/${now.toISOString().slice(0, 10)}`;
      const manifests = await this.documents.transaction(async (tx) => {
        const saved = await tx.getMany([
          ...batch.map((item) => item.path),
          dailyPath,
        ]);
        const daily = Daily.parse(
          saved[batch.length] ?? { schemaVersion: '1.0', reads: 0, writes: 0 },
        );
        let attempts = 0;
        const parsed = batch.map((item, index) => {
          item.signal.throwIfAborted();
          const value = saved[index];
          if (!value) return null;
          const manifest = Manifest.parse(value);
          if (
            manifest.logicalKey !== item.key ||
            manifest.status !== 'ready' ||
            Date.parse(manifest.expiresAt) <= now.getTime()
          )
            throw new Error('KV artifact is unavailable');
          if (
            manifest.parts.reduce((sum, part) => sum + part.bytes, 0) !==
            manifest.bytes
          )
            throw new Error('KV manifest size mismatch');
          attempts += manifest.parts.length;
          return manifest;
        });
        if (daily.reads + attempts > 80000)
          throw new Error('KV free read allowance exhausted');
        if (attempts)
          tx.set(dailyPath, { ...daily, reads: daily.reads + attempts });
        return parsed;
      });
      for (const [index, item] of batch.entries()) {
        const manifest = manifests[index];
        if (!manifest) {
          item.resolve(null);
          continue;
        }
        let partIndex = 0,
          cancelled = false;
        const kv = this.kv,
          clock = this.clock;
        const body = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                item.signal.throwIfAborted();
                if (cancelled) return;
                if (clock().getTime() >= Date.parse(manifest.expiresAt))
                  throw new Error('KV retention expired');
                const part = manifest.parts[partIndex++];
                if (!part) {
                  controller.close();
                  return;
                }
                const value = await kv.get(part.key, 'arrayBuffer');
                item.signal.throwIfAborted();
                if (cancelled) return;
                if (
                  !value ||
                  value.byteLength !== part.bytes ||
                  (await digest(new Uint8Array(value))) !== part.sha256
                )
                  throw new Error('KV part integrity unavailable');
                controller.enqueue(new Uint8Array(value));
              } catch {
                if (!cancelled)
                  controller.error(
                    new Error('Private artifact transfer interrupted'),
                  );
              }
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        );
        item.resolve({ size: manifest.bytes, sha256: manifest.sha256, body });
      }
    } catch {
      for (const item of batch)
        item.reject(new Error('Private artifact unavailable'));
    }
  }
}
