import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { verifyUploadBytes } from './upload-bytes.js';

const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const stream = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
const signal = () => new AbortController().signal;

describe('bounded upload integrity', () => {
  it('preserves arbitrary binary bytes across chunk boundaries and uses SHA-256', async () => {
    const bytes = new Uint8Array([0, 255, 128, 42, 13, 10]);
    const result = await verifyUploadBytes(
      stream([bytes.slice(0, 2), bytes.slice(2, 5), bytes.slice(5)]),
      bytes.length,
      digest(bytes),
      100,
      signal(),
    );
    expect(result.bytes).toEqual(bytes);
    expect(result.sha256).toBe(digest(bytes));
  });
  it('accepts an exactly empty file only with its correct digest', async () => {
    expect(
      (
        await verifyUploadBytes(
          null,
          0,
          digest(new Uint8Array()),
          100,
          signal(),
        )
      ).bytes,
    ).toHaveLength(0);
    await expect(
      verifyUploadBytes(null, 1, 'a'.repeat(64), 100, signal()),
    ).rejects.toMatchObject({ code: 'length_mismatch' });
  });
  it('cancels an oversized stream immediately without allocating its claimed contents', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(100));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      verifyUploadBytes(body, 10, 'a'.repeat(64), 20, signal()),
    ).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toBe(true);
  });
  it('rejects truncation and same-length corruption', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(
      verifyUploadBytes(
        stream([bytes.slice(0, 2)]),
        3,
        digest(bytes),
        10,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'length_mismatch' });
    await expect(
      verifyUploadBytes(
        stream([new Uint8Array([1, 2, 4])]),
        3,
        digest(bytes),
        10,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'digest_mismatch' });
  });
  it('interrupts a stalled read and releases its reader', async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({});
    const pending = verifyUploadBytes(
      body,
      1,
      'a'.repeat(64),
      10,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'upload_interrupted' });
    expect(body.locked).toBe(false);
  });
  it('does not expose stream errors or accept a reservation over the configured bound', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('private upstream details'));
      },
    });
    await expect(
      verifyUploadBytes(body, 1, 'a'.repeat(64), 10, signal()),
    ).rejects.toThrow('Upload could not be read completely.');
    await expect(
      verifyUploadBytes(null, 11, 'a'.repeat(64), 10, signal()),
    ).rejects.toMatchObject({ code: 'body_too_large' });
  });
});
