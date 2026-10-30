import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from 'firebase/auth';
import { z } from 'zod';
import { AuditApi, digestBytes, RequestFailure } from './api.js';

afterEach(() => vi.unstubAllGlobals());
const user = { getIdToken: async () => 'test-id-token' } as User;
describe('private audit HTTP boundary', () => {
  it('reuses the operation key after an ambiguous commit and never retries itself', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: 'commit_unknown',
              message: 'Refresh before retry.',
              requestId: 'request-one',
            },
          },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ accepted: true }));
    vi.stubGlobal('fetch', fetcher);
    const api = new AuditApi(user, 'https://api.example.com');
    const schema = z.object({ accepted: z.boolean() });
    await expect(
      api.mutate('/audits', 'POST', { title: 'Authored fixture' }, schema),
    ).rejects.toMatchObject({
      code: 'commit_unknown',
      requestId: 'request-one',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await api.mutate('/audits', 'POST', { title: 'Authored fixture' }, schema);
    const first = fetcher.mock.calls[0]?.[1] as RequestInit;
    const second = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(first.headers).get('Idempotency-Key')).toBe(
      new Headers(second.headers).get('Idempotency-Key'),
    );
    expect(new Headers(second.headers).get('Authorization')).toBe(
      'Bearer test-id-token',
    );
    expect(second.credentials).toBe('omit');
  });
  it('does not turn malformed API data into an audit state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ success: 'fake' })),
    );
    const api = new AuditApi(user, 'https://api.example.com');
    await expect(
      api.get('/audits', z.object({ audits: z.array(z.string()) })),
    ).rejects.toBeInstanceOf(RequestFailure);
  });
  it('hashes exact source bytes with SHA-256', async () => {
    const bytes = new TextEncoder().encode('abc');
    expect(await digestBytes(bytes.buffer)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  it('stops pending token acquisition before dispatch when signed out', async () => {
    let finishToken: (value: string) => void = () => undefined;
    const pendingUser = {
      getIdToken: () =>
        new Promise<string>((resolve) => {
          finishToken = resolve;
        }),
    } as User;
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const api = new AuditApi(pendingUser, 'https://api.example.com');
    const request = api.get('/audits', z.unknown());
    api.dispose();
    finishToken('test-id-token');
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
