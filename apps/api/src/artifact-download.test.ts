import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@siphon/contracts';
import { TestDocuments } from '../test/document-store.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import {
  ArtifactDownloadService,
  boundedDownload,
} from './artifact-download.js';
import { R2DownloadStore } from './r2-download.js';

async function setup(mode = 'ok') {
  const store = new TestDocuments();
  const now = () => new Date('2026-10-28T00:00:00Z');
  store.documents.set('testers/alice', { active: true });
  store.documents.set('testers/bob', { active: true });
  const { audit } = await new FirestoreAuditRepository(store, now).create(
    'alice',
    { schemaVersion: '1.0', title: 'Private', domain: 'heat_diffusion' },
    'create',
  );
  const id = crypto.randomUUID();
  const path = `audits/${audit.id}/artifacts/${id}`;
  store.documents.set(path, {
    ownerUid: 'alice',
    revisionId: audit.currentRevisionId,
    lifecycle: 'ready',
    expiresAt: '2026-11-01T00:00:00Z',
    bytes: 5,
    sha256: 'a'.repeat(64),
    objectKey: `audits/alice/${audit.id}/artifacts/${id}/content`,
  });
  store.documents.set('configuration/r2_class_b_period', {
    counterKey: 'r2_b_oct',
    startsAt: '2026-10-01T00:00:00Z',
    endsAt: '2026-11-01T00:00:00Z',
  });
  store.documents.set('budgets/r2_b_oct', {
    schemaVersion: '1.0',
    limit: DEFAULT_POLICY.monthlyClassB,
    spent: 0,
    reserved: 0,
    halted: false,
  });
  let calls = 0;
  let cancelled = false;
  const service = new ArtifactDownloadService(
    store,
    {
      get: async () => {
        calls++;
        if (mode === 'error') throw new Error('secret upstream diagnostics');
        if (mode === 'delete')
          store.documents.get(`audits/${audit.id}`)!.deletionRequestedAt =
            now().toISOString();
        return {
          size: 5,
          sha256: (mode === 'corrupt' ? 'b' : 'a').repeat(64),
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('hello'));
            },
            pull(controller) {
              controller.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
        };
      },
    },
    now,
  );
  return {
    store,
    path,
    audit,
    id,
    calls: () => calls,
    cancelled: () => cancelled,
    get: (uid = 'alice') =>
      service.get(uid, audit.id, id, new Request('https://example.test')),
  };
}

describe('private artifact retrieval', () => {
  it('charges before retrieval and serves a private attachment', async () => {
    const fixture = await setup();
    const response = await fixture.get();
    expect(await response.text()).toBe('hello');
    expect(response.headers.get('Content-Type')).toBe(
      'application/octet-stream',
    );
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Content-Disposition')).toContain(
      'attachment;',
    );
    expect(fixture.store.documents.get('budgets/r2_b_oct')?.spent).toBe(1);
  });
  it('blocks other owners, expired and unready artifacts before R2 calls', async () => {
    const f = await setup();
    await expect(f.get('bob')).rejects.toMatchObject({ status: 404 });
    f.store.documents.get(f.path)!.expiresAt = '2026-10-28T00:00:00Z';
    await expect(f.get()).rejects.toMatchObject({ code: 'artifact_expired' });
    f.store.documents.get(f.path)!.lifecycle = 'reserved';
    await expect(f.get()).rejects.toMatchObject({ code: 'artifact_not_ready' });
    expect(f.calls()).toBe(0);
  });
  it('blocks exhausted allowance atomically under concurrent reads', async () => {
    const f = await setup();
    f.store.documents.get('budgets/r2_b_oct')!.limit = 1;
    const results = await Promise.allSettled([f.get(), f.get()]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    for (const item of results)
      if (item.status === 'fulfilled') await item.value.body?.cancel();
    expect(f.calls()).toBe(1);
  });
  it('rechecks deletion after retrieving object metadata', async () => {
    const f = await setup('delete');
    await expect(f.get()).rejects.toMatchObject({ status: 404 });
    expect(f.cancelled()).toBe(true);
    expect(f.store.documents.get('budgets/r2_b_oct')?.spent).toBe(1);
  });
  it('rejects mismatching checksum and keeps failed attempts charged', async () => {
    const corrupt = await setup('corrupt');
    await expect(corrupt.get()).rejects.toMatchObject({
      code: 'artifact_integrity',
    });
    const failed = await setup('error');
    await expect(failed.get()).rejects.toMatchObject({
      code: 'download_unavailable',
      message: 'Artifact download is unavailable.',
    });
    expect(failed.store.documents.get('budgets/r2_b_oct')?.spent).toBe(1);
  });
  it('fails on stream truncation, excess and cancellation', async () => {
    for (const expected of [2, 6]) {
      const input = new Response('hello').body!;
      await expect(
        new Response(
          boundedDownload(input, expected, new AbortController().signal),
        ).text(),
      ).rejects.toThrow();
    }
    const controller = new AbortController();
    const input = new ReadableStream<Uint8Array>();
    const output = new Response(
      boundedDownload(input, 5, controller.signal),
    ).text();
    controller.abort();
    await expect(output).rejects.toThrow();
  });
  it('R2 adapter requires stored SHA-256 and cancels late objects after abort', async () => {
    const missing = new R2DownloadStore({
      get: async () => ({
        size: 1,
        checksums: {},
        body: new Response('x').body!,
      }),
    });
    await expect(
      missing.get('key', new AbortController().signal),
    ).rejects.toThrow('Missing stored');
    let complete!: (value: {
      size: number;
      checksums: { sha256?: ArrayBuffer };
      body: ReadableStream<Uint8Array>;
    }) => void;
    let cancelled = false;
    const late = new R2DownloadStore({
      get: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    });
    const controller = new AbortController();
    const pending = late.get('key', controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('interrupted');
    complete({
      size: 1,
      checksums: {},
      body: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    });
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });
});
