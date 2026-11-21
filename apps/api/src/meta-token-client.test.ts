import { describe, expect, it, vi } from 'vitest';
import { MetaTokenClient } from './meta-token-client.js';
import { MetaClient } from './meta-client.js';
import { metaRequest } from '../test/meta-request.js';
import { metaResponse } from '../test/meta-response.js';
import { canonicalJson, sha256 } from './hashing.js';
import { z } from 'zod';

describe('provider-rendered Meta token counting boundary', () => {
  it('authorizes disclosure first and sends byte-identical model input/settings/schema to counting and generation', async () => {
    const request = metaRequest();
    const sequence: string[] = [];
    const bodies: string[] = [];
    const counted = new MetaTokenClient(
      'authored-key',
      {
        authorize: async (received, digest) => {
          sequence.push('authorize');
          expect(received).toEqual(request);
          expect(digest).toBe(await sha256(canonicalJson(request)));
        },
      },
      async (url, init) => {
        sequence.push('count');
        expect(url).toBe('https://api.meta.ai/v1/responses/input_tokens');
        expect(init?.redirect).toBe('manual');
        bodies.push(String(init?.body));
        return Response.json({
          object: 'response.input_tokens',
          input_tokens: 25,
        });
      },
    );
    const result = await counted.count(request, new AbortController().signal);
    expect(result).toMatchObject({
      inputTokens: 25,
      measurement: 'rendered_context',
      protocol: 'responses.v1',
    });
    expect(sequence).toEqual(['authorize', 'count']);
    const generation = new MetaClient(
      'authored-key',
      { authorize: async () => ({ inputTokenBound: 25 }) },
      async (_url, init) => {
        bodies.push(String(init?.body));
        return Response.json(metaResponse('{"summary":"Authored fixture"}'));
      },
    );
    await generation.complete(
      request,
      z.strictObject({ summary: z.string() }),
      new AbortController().signal,
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0]!)).toMatchObject({
      store: false,
      background: false,
      truncation: 'disabled',
    });
  });
  it('does not disclose text when its mandatory gate denies the request', async () => {
    const transport = vi.fn<typeof fetch>();
    const client = new MetaTokenClient(
      'authored',
      {
        authorize: async () => {
          throw new Error('Disclosure denied');
        },
      },
      transport,
    );
    await expect(
      client.count(metaRequest(), new AbortController().signal),
    ).rejects.toThrow('Disclosure denied');
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    { object: 'response.input_tokens', input_tokens: 0 },
    { object: 'response.input_tokens', input_tokens: -1 },
    { object: 'response.input_tokens', input_tokens: 1.5 },
    { object: 'response.input_tokens', input_tokens: '20' },
    { object: 'response.input_tokens', input_tokens: true },
    {
      object: 'response.input_tokens',
      input_tokens: 20,
      output: 'private marker',
    },
    { object: 'response', input_tokens: 20 },
    { input_tokens: 20 },
  ])(
    'rejects malformed provider count %# without treating it as evidence',
    async (value) => {
      const client = new MetaTokenClient(
        'authored',
        { authorize: async () => {} },
        async () => Response.json(value),
      );
      await expect(
        client.count(metaRequest(), new AbortController().signal),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    },
  );
  it('returns an over-policy measurement without inventing permission to generate', async () => {
    const client = new MetaTokenClient(
      'authored',
      { authorize: async () => {} },
      async () =>
        Response.json({ object: 'response.input_tokens', input_tokens: 25000 }),
    );
    expect(
      (await client.count(metaRequest(), new AbortController().signal))
        .inputTokens,
    ).toBe(25000);
  });
  it('never retries HTTP/transport failures or returns raw provider diagnostics', async () => {
    for (const mode of ['http', 'transport']) {
      const transport = vi.fn<typeof fetch>(async () => {
        if (mode === 'transport') throw new Error('private marker');
        return new Response('private marker', { status: 429 });
      });
      const client = new MetaTokenClient(
        'authored',
        { authorize: async () => {} },
        transport,
      );
      await expect(
        client.count(metaRequest(), new AbortController().signal),
      ).rejects.toMatchObject({
        code: mode === 'http' ? 'http_error' : 'transport_unknown',
      });
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
  it('bounds response bytes and observes cancellation during response reading', async () => {
    const controller = new AbortController();
    const stalled = new MetaTokenClient(
      'authored',
      { authorize: async () => {} },
      async () =>
        new Response(
          new ReadableStream({
            start() {
              queueMicrotask(() => controller.abort());
            },
          }),
        ),
    );
    await expect(
      stalled.count(metaRequest(), controller.signal),
    ).rejects.toThrow();
    const oversized = new MetaTokenClient(
      'authored',
      { authorize: async () => {} },
      async () => new Response('x'.repeat(4097)),
    );
    await expect(
      oversized.count(metaRequest(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
