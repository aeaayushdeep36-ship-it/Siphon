import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from 'firebase/auth';
import { z } from 'zod';
import { AuditApi, RequestFailure } from './api.js';

const user = { getIdToken: async () => 'fixture-token' } as User;
const receipt = z.object({ ok: z.literal(true) });

afterEach(() => vi.unstubAllGlobals());

describe('browser audit API', () => {
  it('uses the same operation key after an uncertain failure and replaces it after success', async () => {
    const headers: Headers[] = [];
    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        headers.push(new Headers(init.headers));
        if (++attempt === 1) throw new TypeError('connection lost');
        return Response.json({ ok: true });
      }),
    );
    const api = new AuditApi(user, 'http://localhost:8787');
    await expect(
      api.mutate('/audits', 'POST', { title: 'Fixture' }, receipt),
    ).rejects.toThrow('connection lost');
    await api.mutate('/audits', 'POST', { title: 'Fixture' }, receipt);
    await api.mutate('/audits', 'POST', { title: 'Fixture' }, receipt);
    expect(headers[0]?.get('authorization')).toBe('Bearer fixture-token');
    expect(headers[0]?.get('idempotency-key')).toBe(
      headers[1]?.get('idempotency-key'),
    );
    expect(headers[2]?.get('idempotency-key')).not.toBe(
      headers[1]?.get('idempotency-key'),
    );
  });

  it('rejects a malformed response instead of presenting it as a successful operation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: false })),
    );
    const api = new AuditApi(user, 'http://localhost:8787');
    await expect(
      api.mutate('/audits', 'POST', {}, receipt),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([
    {
      path: '/audits/a/revisions/r/resume',
      code: 'workflow_stopped',
      changes: true,
    },
    {
      path: '/audits/a/revisions/r/scientific-run',
      code: 'workflow_stopped',
      changes: true,
    },
    {
      path: '/audits/a/revisions/r/scientific-run',
      code: 'workflow_dispatch_unknown',
      changes: false,
    },
    {
      path: '/audits/a/revisions/r/run',
      code: 'workflow_stopped',
      changes: false,
    },
  ])(
    'preserves safe retry semantics for $path and $code',
    async ({ path, code, changes }) => {
      const keys: string[] = [];
      let calls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          keys.push(new Headers(init.headers).get('idempotency-key')!);
          if (++calls === 1)
            return Response.json(
              { error: { code, message: 'Fixture' } },
              { status: 409 },
            );
          return Response.json({ ok: true });
        }),
      );
      const api = new AuditApi(user, 'http://localhost:8787');
      await expect(api.mutate(path, 'POST', {}, receipt)).rejects.toMatchObject(
        { code },
      );
      await api.mutate(path, 'POST', {}, receipt);
      expect(keys[0] === keys[1]).toBe(!changes);
    },
  );

  it('rejects unsafe API origins before sending credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const api = new AuditApi(user, 'http://example.com');
    await expect(api.get('/audits', z.unknown())).rejects.toBeInstanceOf(
      RequestFailure,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the selected bytes and checksum to the authenticated upload endpoint', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new AuditApi(user, 'https://api.example.test');
    const bytes = new Uint8Array([0, 10, 255]).buffer;
    const digest = 'a'.repeat(64);
    await api.upload(
      '/audits/a/revisions/r/artifacts/f/content',
      bytes,
      digest,
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const headers = new Headers(init.headers);
    expect(url).toBe(
      'https://api.example.test/api/v1/audits/a/revisions/r/artifacts/f/content',
    );
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(bytes);
    expect(headers.get('authorization')).toBe('Bearer fixture-token');
    expect(headers.get('content-type')).toBe('application/octet-stream');
    expect(headers.get('x-content-sha256')).toBe(digest);
  });

  it('does not report an upload as successful when the API rejects its bytes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: 'upload_integrity_mismatch',
              message: 'Upload rejected.',
            },
          },
          { status: 422 },
        ),
      ),
    );
    const api = new AuditApi(user, 'https://api.example.test');
    await expect(
      api.upload(
        '/audits/a/revisions/r/artifacts/f/content',
        new ArrayBuffer(1),
        'a'.repeat(64),
      ),
    ).rejects.toMatchObject({ code: 'upload_integrity_mismatch' });
  });

  it('explains when the frontend server returns HTML instead of the API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html></html>', {
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );
    const api = new AuditApi(user, 'http://localhost:5173');
    await expect(api.get('/audits', z.unknown())).rejects.toMatchObject({
      code: 'api_unavailable',
      message: expect.stringContaining('VITE_API_BASE_URL'),
    });
  });
});
