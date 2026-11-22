import { describe, expect, it, vi } from 'vitest';
import { KvArtifacts } from './kv-artifacts.js';
import { TestDocuments } from '../test/document-store.js';
import { sha256 } from './hashing.js';
function fixture() {
  const docs = new TestDocuments(),
    data = new Map<string, ArrayBuffer>();
  const put = vi.fn(
    async (
      key: string,
      bytes: ArrayBuffer,
      _options: { expiration: number },
    ) => {
      expect(_options.expiration).toBeGreaterThan(0);
      data.set(key, bytes.slice(0));
    },
  );
  const get = vi.fn(async (key: string, type: 'arrayBuffer') => {
    expect(type).toBe('arrayBuffer');
    return data.get(key)?.slice(0) ?? null;
  });
  let now = new Date('2026-10-30T00:00:00.000Z');
  const store = new KvArtifacts({ put, get }, docs, () => now),
    key = `audits/alice/${crypto.randomUUID()}/artifacts/${crypto.randomUUID()}/content`;
  const retention = { expiresAt: '2026-11-06T00:00:00.000Z' };
  return {
    docs,
    data,
    put,
    get,
    store,
    key,
    retention,
    setTime: (value: string) => {
      now = new Date(value);
    },
  };
}
describe('private hard-capped KV content storage', () => {
  it('preserves immutable bytes, fixed expiry, replay without writes and accounted verified reads', async () => {
    const f = fixture(),
      bytes = new TextEncoder().encode('private authored fixture'),
      hash = await sha256('private authored fixture');
    expect(await f.store.putOnce(f.key, bytes, hash, f.retention)).toEqual({
      size: bytes.length,
      sha256: hash,
    });
    await f.store.putOnce(f.key, bytes, hash, f.retention);
    expect(f.put).toHaveBeenCalledTimes(1);
    const value = await f.store.get(f.key, new AbortController().signal);
    expect(await new Response(value!.body).text()).toBe(
      'private authored fixture',
    );
    expect(f.docs.documents.get('storageKvDays/2026-10-30')).toMatchObject({
      writes: 1,
      reads: 1,
    });
    expect(f.put.mock.calls[0]![2]).toEqual({
      expiration: Date.parse(f.retention.expiresAt) / 1000,
    });
    await expect(
      f.store.putOnce(
        f.key,
        new TextEncoder().encode('changed'),
        await sha256('changed'),
        f.retention,
      ),
    ).rejects.toThrow('conflict');
    await expect(
      f.store.putOnce(f.key, bytes, hash, {
        expiresAt: '2026-11-07T00:00:00.000Z',
      }),
    ).rejects.toThrow('conflict');
  });
  it('chunks large numeric artifacts and verifies every part before delivery', async () => {
    const f = fixture(),
      bytes = new Uint8Array(9 * 1024 * 1024);
    bytes[bytes.length - 1] = 7;
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (n) => n.toString(16).padStart(2, '0'),
    ).join('');
    await f.store.putOnce(f.key, bytes, hash, f.retention);
    expect(f.put).toHaveBeenCalledTimes(2);
    const value = await f.store.get(f.key, new AbortController().signal);
    const retrieved = new Uint8Array(
      await new Response(value!.body).arrayBuffer(),
    );
    expect(retrieved.length).toBe(bytes.length);
    expect(await crypto.subtle.digest('SHA-256', retrieved)).toEqual(
      await crypto.subtle.digest('SHA-256', bytes),
    );
    const key = f.put.mock.calls[1]![0];
    f.data.set(key, new Uint8Array(1024 * 1024).buffer);
    const corrupted = await f.store.get(f.key, new AbortController().signal);
    await expect(new Response(corrupted!.body).arrayBuffer()).rejects.toThrow(
      'interrupted',
    );
  });
  it('does not publish a partial write or refund failed attempts, and resumes only identical content', async () => {
    const f = fixture(),
      bytes = new TextEncoder().encode('data'),
      hash = await sha256('data');
    f.put.mockRejectedValueOnce(new Error('private upstream details'));
    await expect(
      f.store.putOnce(f.key, bytes, hash, f.retention),
    ).rejects.toThrow('reconciliation');
    await expect(
      f.store.get(f.key, new AbortController().signal),
    ).rejects.toThrow('unavailable');
    expect(f.docs.documents.get('storageKvDays/2026-10-30')).toMatchObject({
      writes: 1,
    });
    await f.store.putOnce(f.key, bytes, hash, f.retention);
    expect(f.docs.documents.get('storageKvDays/2026-10-30')).toMatchObject({
      writes: 2,
    });
    expect(
      await new Response(
        (await f.store.get(f.key, new AbortController().signal))!.body,
      ).text(),
    ).toBe('data');
  });
  it('allows one writer and denies conflicting concurrent content before KV I/O', async () => {
    const f = fixture();
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.put.mockImplementationOnce(async (key, bytes) => {
      await pending;
      f.data.set(key, bytes);
    });
    const bytes = new TextEncoder().encode('data'),
      hash = await sha256('data'),
      first = f.store.putOnce(f.key, bytes, hash, f.retention);
    await vi.waitFor(() => expect(f.put).toHaveBeenCalledTimes(1));
    await expect(
      f.store.putOnce(f.key, bytes, hash, f.retention),
    ).rejects.toThrow('claimed');
    release();
    await first;
    expect(f.put).toHaveBeenCalledTimes(1);
  });
  it('stops before hard daily/storage ceilings and never calls KV for invalid hashes or expiry', async () => {
    const f = fixture(),
      bytes = new TextEncoder().encode('data'),
      hash = await sha256('data');
    f.docs.documents.set('storageKvDays/2026-10-30', {
      schemaVersion: '1.0',
      writes: 800,
      reads: 0,
    });
    await expect(
      f.store.putOnce(f.key, bytes, hash, f.retention),
    ).rejects.toThrow('allowance');
    expect(f.put).not.toHaveBeenCalled();
    f.docs.documents.delete('storageKvDays/2026-10-30');
    f.docs.documents.set('budgets/kv_storage_bytes', {
      schemaVersion: '1.0',
      allocated: 512 * 1024 * 1024,
    });
    await expect(
      f.store.putOnce(f.key, bytes, hash, f.retention),
    ).rejects.toThrow('allowance');
    f.docs.documents.delete('budgets/kv_storage_bytes');
    await expect(
      f.store.putOnce(f.key, bytes, '0'.repeat(64), f.retention),
    ).rejects.toThrow('invalid');
    await expect(
      f.store.putOnce(f.key, bytes, hash, {
        expiresAt: '2026-10-30T00:00:10.000Z',
      }),
    ).rejects.toThrow('retention');
    await f.store.putOnce(f.key, bytes, hash, f.retention);
    f.docs.documents.set('storageKvDays/2026-10-30', {
      schemaVersion: '1.0',
      writes: 1,
      reads: 80000,
    });
    await expect(
      f.store.get(f.key, new AbortController().signal),
    ).rejects.toThrow();
    expect(f.get).not.toHaveBeenCalled();
  });
  it('fails unavailable replicas and expiry honestly, while absent/cancelled reads never fetch content', async () => {
    const f = fixture();
    expect(await f.store.get(f.key, new AbortController().signal)).toBeNull();
    await expect(f.store.get(f.key, AbortSignal.abort())).rejects.toThrow();
    expect(f.get).not.toHaveBeenCalled();
    await f.store.putOnce(
      f.key,
      new TextEncoder().encode('data'),
      await sha256('data'),
      f.retention,
    );
    f.data.clear();
    const read = await f.store.get(f.key, new AbortController().signal);
    await expect(new Response(read!.body).text()).rejects.toThrow();
    f.setTime(f.retention.expiresAt);
    await expect(
      f.store.get(f.key, new AbortController().signal),
    ).rejects.toThrow();
  });
  it('authorizes and charges ten object manifests in one database transaction without relying on timing coalescing', async () => {
    const f = fixture(),
      keys = Array.from(
        { length: 10 },
        () =>
          `audits/alice/${crypto.randomUUID()}/artifacts/${crypto.randomUUID()}/content`,
      );
    for (const key of keys)
      await f.store.putOnce(
        key,
        new TextEncoder().encode('data'),
        await sha256('data'),
        f.retention,
      );
    let transactions = 0;
    const grouped = new KvArtifacts(
      { put: f.put, get: f.get },
      {
        get: (path) => f.docs.get(path),
        getMany: (paths) => f.docs.getMany(paths),
        transaction: async (callback) => {
          transactions++;
          return f.docs.transaction(callback);
        },
      },
      () => new Date('2026-10-30T00:00:00.000Z'),
    );
    const objects = await grouped.getMany(keys, new AbortController().signal);
    expect(transactions).toBe(1);
    expect(objects).toHaveLength(10);
    expect(
      await Promise.all(
        objects.map(async (object) => new Response(object!.body).text()),
      ),
    ).toEqual(Array(10).fill('data'));
    expect(f.docs.documents.get('storageKvDays/2026-10-30')).toMatchObject({
      reads: 10,
      writes: 10,
    });
  });
});
