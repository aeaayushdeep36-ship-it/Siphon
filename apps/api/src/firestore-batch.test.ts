import { describe, expect, it, vi } from 'vitest';
import { FirestoreClient, FirestoreFailure, encodeValue } from './firestore.js';

const prefix = 'projects/siphon-test/databases/(default)/documents/';
function found(path: string, data: Record<string, unknown> = { value: 1 }) {
  const encoded = encodeValue(data);
  if (!('mapValue' in encoded)) throw new Error('Invalid test record');
  return { found: { name: prefix + path, fields: encoded.mapValue.fields } };
}

describe('bounded Firestore batch reads', () => {
  it('correlates shuffled found/missing rows, deduplicates requests and returns independent values', async () => {
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        documents: [
          prefix + 'budgets/a',
          prefix + 'budgets/missing',
          prefix + 'budgets/b',
        ],
        transaction: 'snapshot-token',
      });
      return Response.json([
        found('budgets/b', { value: 2 }),
        { missing: prefix + 'budgets/missing' },
        found('budgets/a', {
          nested: { value: 1 },
          createdAt: new Date('2026-10-29T00:00:00Z'),
        }),
      ]);
    });
    const client = new FirestoreClient(
      'siphon-test',
      async () => 'offline',
      transport,
    );
    const result = await client.getMany(
      ['budgets/a', 'budgets/missing', 'budgets/a', 'budgets/b'],
      'snapshot-token',
    );
    expect(result).toEqual([
      { nested: { value: 1 }, createdAt: '2026-10-29T00:00:00.000Z' },
      null,
      { nested: { value: 1 }, createdAt: '2026-10-29T00:00:00.000Z' },
      { value: 2 },
    ]);
    (result[0]!.nested as { value: number }).value = 99;
    expect(result[2]?.nested).toEqual({ value: 1 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('does no credential or network work for empty batches and invalid paths/bounds', async () => {
    const token = vi.fn(async () => 'offline');
    const transport = vi.fn<typeof fetch>();
    const client = new FirestoreClient('siphon-test', token, transport);
    expect(await client.getMany([])).toEqual([]);
    for (const paths of [
      Array(41).fill('budgets/a'),
      ['budgets/a', 'audits/../secret'],
      ['budgets/a?mask=secret'],
    ])
      await expect(client.getMany(paths)).rejects.toThrow();
    expect(token).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ['not an array', {}],
    ['empty response', []],
    ['extra document', [found('budgets/a'), found('budgets/foreign')]],
    ['duplicate document', [found('budgets/a'), found('budgets/a')]],
    [
      'both found and missing',
      [{ ...found('budgets/a'), missing: prefix + 'budgets/a' }],
    ],
    ['no result', [{ readTime: '2026-10-29T00:00:00Z' }]],
    [
      'foreign project',
      [
        {
          missing:
            'projects/other-project/databases/(default)/documents/budgets/a',
        },
      ],
    ],
    [
      'foreign transaction',
      [{ ...found('budgets/a'), transaction: 'another-snapshot' }],
    ],
    [
      'unsafe integer',
      [
        {
          found: {
            name: prefix + 'budgets/a',
            fields: { value: { integerValue: '9007199254740993' } },
          },
        },
      ],
    ],
  ])(
    'rejects %s instead of accepting a partial or misbound snapshot',
    async (_label, body) => {
      const transport = vi.fn<typeof fetch>(async () => Response.json(body));
      const client = new FirestoreClient(
        'siphon-test',
        async () => 'offline',
        transport,
      );
      await expect(
        client.getMany(['budgets/a'], 'snapshot-token'),
      ).rejects.toThrow();
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it('does not reinterpret an HTTP batch failure as missing documents or retry it', async () => {
    const transport = vi.fn<typeof fetch>(
      async () => new Response('private error', { status: 404 }),
    );
    const client = new FirestoreClient(
      'siphon-test',
      async () => 'offline',
      transport,
    );
    await expect(client.getMany(['budgets/a'])).rejects.toBeInstanceOf(
      FirestoreFailure,
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('requires every distinct requested document, including explicit missing rows', async () => {
    const client = new FirestoreClient(
      'siphon-test',
      async () => 'offline',
      async () => Response.json([found('budgets/a')]),
    );
    await expect(
      client.getMany(['budgets/a', 'budgets/missing']),
    ).rejects.toThrow('incomplete');
  });

  it('bounds the complete response before JSON/schema decoding', async () => {
    const client = new FirestoreClient(
      'siphon-test',
      async () => 'offline',
      async () => new Response(' '.repeat(1048577)),
    );
    await expect(client.getMany(['budgets/a'])).rejects.toBeInstanceOf(
      FirestoreFailure,
    );
  });
});

describe('transaction-local read cache', () => {
  function fixture() {
    const batches: string[][] = [];
    const urls: string[] = [];
    const client = new FirestoreClient(
      'siphon-test',
      async () => 'offline',
      async (url, init) => {
        urls.push(String(url));
        if (String(url).endsWith(':beginTransaction'))
          return Response.json({ transaction: 'snapshot-token' });
        if (String(url).endsWith(':batchGet')) {
          const body = JSON.parse(String(init?.body)) as {
            documents: string[];
            transaction: string;
          };
          expect(body.transaction).toBe('snapshot-token');
          batches.push(body.documents);
          return Response.json(
            body.documents
              .map((name) => ({
                ...found(name.slice(prefix.length)),
                transaction: body.transaction,
              }))
              .reverse(),
          );
        }
        if (
          String(url).endsWith(':commit') ||
          String(url).endsWith(':rollback')
        )
          return Response.json({});
        throw new Error('Unexpected unbatched request');
      },
    );
    return { client, batches, urls };
  }

  it('shares overlapping concurrent reads but never caller mutations or another transaction cache', async () => {
    const f = fixture();
    const run = () =>
      f.client.transaction(async (tx) => {
        const [first, second, duplicate] = await Promise.all([
          tx.getMany(['budgets/a', 'budgets/b']),
          tx.getMany(['budgets/b', 'budgets/c']),
          tx.get('budgets/a'),
        ]);
        first[0]!.value = 99;
        expect(duplicate).toEqual({ value: 1 });
        expect(second).toEqual([{ value: 1 }, { value: 1 }]);
        expect(await tx.get('budgets/a')).toEqual({ value: 1 });
        tx.set('budgets/updated', { value: 2 });
      });
    await run();
    expect(f.batches).toEqual([
      [prefix + 'budgets/a', prefix + 'budgets/b'],
      [prefix + 'budgets/c'],
    ]);
    expect(f.urls).toHaveLength(4);
    await run();
    expect(f.batches).toHaveLength(4);
  });

  it('keeps the forty-distinct-read cap while permitting cached repeats', async () => {
    const f = fixture();
    await expect(
      f.client.transaction(async (tx) => {
        const paths = Array.from(
          { length: 40 },
          (_, index) => `budgets/k${index}`,
        );
        await tx.getMany(paths);
        for (const path of paths) await tx.get(path);
        await tx.get('budgets/overflow');
      }),
    ).rejects.toThrow('read bound');
    expect(f.batches).toHaveLength(1);
    expect(f.urls.at(-1)).toMatch(/:rollback$/);
  });

  it('still forbids reads after writes, even when every requested value is cached', async () => {
    const f = fixture();
    await expect(
      f.client.transaction(async (tx) => {
        await tx.getMany(['budgets/a']);
        tx.set('budgets/updated', { value: 2 });
        await tx.getMany(['budgets/a']);
      }),
    ).rejects.toThrow('reads must precede writes');
    expect(f.urls.at(-1)).toMatch(/:rollback$/);
  });

  it('awaits initiated reads before commit and rolls back a forgotten failed read', async () => {
    const urls: string[] = [];
    const client = new FirestoreClient(
      'siphon-test',
      async () => 'offline',
      async (url) => {
        urls.push(String(url));
        if (String(url).endsWith(':beginTransaction'))
          return Response.json({ transaction: 'token' });
        if (String(url).endsWith(':rollback')) return Response.json({});
        throw new Error('Read failed');
      },
    );
    await expect(
      client.transaction(async (tx) => {
        void tx.get('budgets/unavailable');
        tx.set('budgets/must_not_commit', { value: 1 });
      }),
    ).rejects.toBeInstanceOf(FirestoreFailure);
    expect(urls.at(-1)).toMatch(/:rollback$/);
    expect(urls.some((url) => url.endsWith(':commit'))).toBe(false);
  });
});
