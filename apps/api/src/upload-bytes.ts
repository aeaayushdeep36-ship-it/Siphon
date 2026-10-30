import { Count, Digest } from '@siphon/contracts';
import { ApiError } from './errors.js';

export interface VerifiedUploadBytes {
  bytes: Uint8Array<ArrayBuffer>;
  sha256: string;
}

/** Bounded by the authorized reservation, never by a client header alone.
 * This verifies transport integrity only; Python/NumPy inspection remains isolated.
 */
export async function verifyUploadBytes(
  body: ReadableStream<Uint8Array> | null,
  expectedBytes: number,
  expectedDigest: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<VerifiedUploadBytes> {
  Count.parse(expectedBytes);
  Count.parse(maximumBytes);
  Digest.parse(expectedDigest);
  if (expectedBytes > maximumBytes)
    throw new ApiError(
      413,
      'body_too_large',
      'Reserved upload exceeds the allowed size.',
    );
  if (signal.aborted)
    throw new ApiError(422, 'upload_interrupted', 'Upload was interrupted.');
  if (!body && expectedBytes !== 0)
    throw new ApiError(
      422,
      'length_mismatch',
      'Upload length does not match its reservation.',
    );
  const bytes = new Uint8Array(expectedBytes);
  let offset = 0;
  if (body) {
    const reader = body.getReader();
    const abort = () => {
      void reader.cancel('Upload interrupted').catch(() => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        if (signal.aborted)
          throw new ApiError(
            422,
            'upload_interrupted',
            'Upload was interrupted.',
          );
        const chunk = await reader.read();
        if (signal.aborted)
          throw new ApiError(
            422,
            'upload_interrupted',
            'Upload was interrupted.',
          );
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array))
          throw new ApiError(
            422,
            'invalid_upload',
            'Expected binary upload data.',
          );
        if (chunk.value.byteLength > expectedBytes - offset) {
          void reader.cancel('Length exceeded').catch(() => undefined);
          throw new ApiError(
            413,
            'length_mismatch',
            'Upload exceeds its reserved byte length.',
          );
        }
        bytes.set(chunk.value, offset);
        offset += chunk.value.byteLength;
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        422,
        'upload_interrupted',
        'Upload could not be read completely.',
      );
    } finally {
      signal.removeEventListener('abort', abort);
      reader.releaseLock();
    }
  }
  if (offset !== expectedBytes)
    throw new ApiError(
      422,
      'length_mismatch',
      'Upload length does not match its reservation.',
    );
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = [...new Uint8Array(hash)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  if (signal.aborted)
    throw new ApiError(422, 'upload_interrupted', 'Upload was interrupted.');
  if (sha256 !== expectedDigest)
    throw new ApiError(
      422,
      'digest_mismatch',
      'Upload SHA-256 does not match its reservation.',
    );
  return { bytes, sha256 };
}
