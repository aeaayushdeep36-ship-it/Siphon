export interface UploadObjectStore {
  putOnce(
    key: string,
    bytes: Uint8Array<ArrayBuffer>,
    sha256: string,
    retention?: { expiresAt: string },
  ): Promise<{ size: number; sha256: string }>;
}

export interface UploadBucketBinding {
  put(
    key: string,
    value: ArrayBuffer,
    options: {
      onlyIf: Headers;
      sha256: ArrayBuffer;
      storageClass: 'Standard';
      httpMetadata: { contentType: string; cacheControl: string };
    },
  ): Promise<{ size: number; checksums: { sha256?: ArrayBuffer } } | null>;
}

export class R2UploadStore implements UploadObjectStore {
  constructor(private readonly bucket: UploadBucketBinding) {}
  async putOnce(key: string, bytes: Uint8Array<ArrayBuffer>, sha256: string) {
    const checksum = Uint8Array.from(sha256.match(/../g) ?? [], (value) =>
      Number.parseInt(value, 16),
    );
    const object = await this.bucket.put(
      key,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      {
        onlyIf: new Headers({ 'If-None-Match': '*' }),
        sha256: checksum.buffer,
        storageClass: 'Standard',
        httpMetadata: {
          contentType: 'application/octet-stream',
          cacheControl: 'no-store',
        },
      },
    );
    if (!object?.checksums.sha256)
      throw new Error('Storage outcome requires reconciliation');
    return {
      size: object.size,
      sha256: [...new Uint8Array(object.checksums.sha256)]
        .map((v) => v.toString(16).padStart(2, '0'))
        .join(''),
    };
  }
}
