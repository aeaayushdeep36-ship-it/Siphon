import { z } from 'zod';
import type { User } from 'firebase/auth';

export class RequestFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly requestId: string | null = null,
  ) {
    super(message);
  }
}

const failure = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
  }),
});

/** Retain operation keys after uncertain failures. An explicit retry of identical
 * input uses the same key; reading or reconnecting never dispatches work. */
export class AuditApi {
  private readonly keys = new Map<string, string>();
  private controller = new AbortController();
  activate(): void {
    this.controller = new AbortController();
  }
  dispose(): void {
    this.controller.abort();
    this.keys.clear();
  }
  constructor(
    private readonly user: User,
    private readonly base = import.meta.env.VITE_API_BASE_URL ?? '',
  ) {}
  async response(path: string, init: RequestInit = {}): Promise<Response> {
    const signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(90_000),
      ...(init.signal ? [init.signal] : []),
    ]);
    signal.throwIfAborted();
    if (
      this.base &&
      !/^https:\/\/[^/?#]+$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(
        this.base,
      )
    ) {
      throw new RequestFailure(
        'configuration',
        'The API origin configuration is invalid.',
      );
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await this.user.getIdToken()}`);
    signal.throwIfAborted();
    const response = await fetch(`${this.base}/api/v1${path}`, {
      ...init,
      signal,
      headers,
      cache: 'no-store',
      credentials: 'omit',
    });
    if (!response.ok) {
      const parsed = failure.safeParse(await response.json().catch(() => null));
      throw parsed.success
        ? new RequestFailure(
            parsed.data.error.code,
            parsed.data.error.message,
            parsed.data.error.requestId ?? null,
          )
        : new RequestFailure(
            'request_failed',
            `Request failed (${response.status}).`,
            response.headers.get('X-Request-Id'),
          );
    }
    return response;
  }
  async get<T>(
    path: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.response(path, signal ? { signal } : {});
    const result = schema.safeParse(await response.json());
    if (!result.success)
      throw new RequestFailure(
        'invalid_response',
        'The server returned an unsupported response. Refresh after the service is updated.',
      );
    return result.data;
  }
  async mutate<T>(
    path: string,
    method: 'POST' | 'DELETE',
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const serialized = JSON.stringify(body);
    const operation = `${method} ${path} ${serialized}`;
    const key = this.keys.get(operation) ?? crypto.randomUUID();
    this.keys.set(operation, key);
    const response = await this.response(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      ...(body === undefined ? {} : { body: serialized }),
    });
    const result = schema.safeParse(await response.json());
    if (!result.success)
      throw new RequestFailure(
        'invalid_response',
        'The operation response could not be verified. Refresh before continuing.',
      );
    this.keys.delete(operation);
    return result.data;
  }
  async upload(
    path: string,
    bytes: ArrayBuffer,
    digest: string,
  ): Promise<void> {
    await this.response(path, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Content-SHA256': digest,
      },
      body: bytes,
    });
  }
}

export async function digestBytes(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
