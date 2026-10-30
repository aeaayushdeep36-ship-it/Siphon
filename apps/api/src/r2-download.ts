import { type DownloadObjectStore } from './artifact-download.js';

export interface DownloadBucketBinding {
  get(key: string): Promise<{
    size: number;
    checksums: { sha256?: ArrayBuffer };
    body: ReadableStream<Uint8Array>;
  } | null>;
}

export class R2DownloadStore implements DownloadObjectStore {
  constructor(private readonly bucket: DownloadBucketBinding) {}
  async get(key: string, signal: AbortSignal) {
    signal.throwIfAborted();
    // R2 binding get has no AbortSignal argument. Bound the caller's wait and
    // cancel late bodies; a timed-out attempt remains charged.
    const object = await new Promise<
      Awaited<ReturnType<DownloadBucketBinding['get']>>
    >((resolve, reject) => {
      let settled = false;
      const abort = () => {
        settled = true;
        signal.removeEventListener('abort', abort);
        reject(new Error('Artifact retrieval interrupted'));
      };
      signal.addEventListener('abort', abort, { once: true });
      this.bucket.get(key).then(
        (value) => {
          signal.removeEventListener('abort', abort);
          if (settled) {
            void value?.body.cancel().catch(() => undefined);
            return;
          }
          settled = true;
          resolve(value);
        },
        () => {
          signal.removeEventListener('abort', abort);
          if (!settled) {
            settled = true;
            reject(new Error('Artifact retrieval failed'));
          }
        },
      );
    });
    if (!object) return null;
    if (!object.checksums.sha256) {
      await object.body.cancel().catch(() => undefined);
      throw new Error('Missing stored SHA-256');
    }
    return {
      size: object.size,
      sha256: [...new Uint8Array(object.checksums.sha256)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
      body: object.body,
    };
  }
}
