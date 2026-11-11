import { describe, expect, it } from 'vitest';
import {
  decodeValue,
  encodeValue,
  FirestoreClient,
  FirestoreFailure,
} from './firestore.js';
import { FirestoreAccountingStore } from './firestore-accounting.js';
import { reserveOperation, type Operation } from './accounting.js';
import { randomUUID } from 'node:crypto';

describe('Firestore value boundary', () => {
  it('routes every document read to the selected named database', async () => {
    const calls: string[] = [];
    const client = new FirestoreClient(
      'siphon-test',
      async () => 'test-only-credential',
      async (input) => {
        calls.push(String(input));
        return new Response(null, { status: 404 });
      },
      'private-audits',
    );
    expect(client.database).toBe(
      'projects/siphon-test/databases/private-audits',
    );
    expect(await client.get('testers/alice')).toBeNull();
    expect(calls).toEqual([
      'https://firestore.googleapis.com/v1/projects/siphon-test/databases/private-audits/documents/testers/alice',
    ]);
  });

  it('rejects invalid database identifiers before credential use or transport', () => {
    for (const databaseId of ['', '../other', '(default)/documents', 'UPPER'])
      expect(
        () =>
          new FirestoreClient(
            'siphon-test',
            async () => {
              throw new Error('must not request credentials');
            },
            async () => {
              throw new Error('must not send requests');
            },
            databaseId,
          ),
      ).toThrow('Invalid Firestore database ID');
  });

  it('round trips integer money, nulls, arrays and native timestamps', () => {
    const input = {
      money: 135_000_000,
      missing: null,
      flags: [true, false],
      createdAt: new Date('2026-10-28T00:00:00Z'),
    };
    expect(decodeValue(encodeValue(input))).toEqual({
      ...input,
      createdAt: '2026-10-28T00:00:00.000Z',
    });
    expect(encodeValue(input.money)).toEqual({ integerValue: '135000000' });
  });
  it('rejects unsupported and lossy data instead of coercing it', () => {
    for (const value of [NaN, Infinity, undefined, 9007199254740992, [[1]]])
      expect(() => encodeValue(value)).toThrow();
    expect(() => decodeValue({ integerValue: '9007199254740993' })).toThrow();
    expect(() =>
      decodeValue({ stringValue: 'x', integerValue: '3' }),
    ).toThrow();
  });
});

describe('Firestore transaction transport', () => {
  it('commits operation and counters together with transaction-bound reads and native dates', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const transport: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith(':beginTransaction'))
        return Response.json({ transaction: 'token+/=' });
      if (url.endsWith(':batchGet')) {
        const body = JSON.parse(String(init.body)) as {
          documents: string[];
          transaction: string;
        };
        expect(body.transaction).toBe('token+/=');
        return Response.json(
          body.documents
            .map((name) => {
              if (name.includes('/operations/')) return { missing: name };
              const fields = name.includes('/testers/')
                ? { active: true }
                : name.includes('/budgets/')
                  ? {
                      schemaVersion: '1.0',
                      limit: 100,
                      reserved: 0,
                      spent: 0,
                      halted: false,
                    }
                  : name.includes('/revisions/')
                    ? {
                        schemaVersion: '1.0',
                        auditId: operation.auditId,
                        revisionId: operation.revisionId,
                        ownerUid: 'alice',
                        stage: 'inspecting',
                        status: 'running',
                        generation: 0,
                        inputDigest: operation.inputDigest,
                        cancellationRequestedAt: null,
                      }
                    : {
                        schemaVersion: '1.0',
                        id: operation.auditId,
                        ownerUid: 'alice',
                        title: 'Audit',
                        domain: 'heat_diffusion',
                        currentRevisionId: operation.revisionId,
                        createdAt: operation.createdAt,
                        updatedAt: operation.updatedAt,
                        deletionRequestedAt: null,
                      };
              const encoded = encodeValue(fields);
              if (!('mapValue' in encoded)) throw new Error('Invalid fixture');
              return { found: { name, fields: encoded.mapValue.fields } };
            })
            .reverse(),
        );
      }
      if (url.endsWith(':commit'))
        return Response.json({ commitTime: '2026-10-28T00:00:00Z' });
      throw new Error('Unexpected request');
    };
    const client = new FirestoreClient(
      'siphon-test',
      async () => 'test-only-credential',
      transport,
    );
    const operation: Operation = {
      schemaVersion: '1.0',
      id: randomUUID(),
      revisionId: randomUUID(),
      auditId: randomUUID(),
      ownerUid: 'alice',
      inputDigest: 'a'.repeat(64),
      requestDigest: 'f'.repeat(64),
      fence: 0,
      outcome: 'reserved',
      providerHandle: null,
      usage: null,
      createdAt: '2026-10-28T00:00:00Z',
      updatedAt: '2026-10-28T00:00:00Z',
      charges: [
        {
          counterKey: 'meta',
          amount: 50,
          unit: 'micro_usd',
          consumeOnDispatch: false,
        },
      ],
    };
    await reserveOperation(new FirestoreAccountingStore(client), operation);
    expect(calls).toHaveLength(5);
    expect(calls[1]?.url).toMatch(/:batchGet$/);
    const commit: unknown = JSON.parse(String(calls.at(-1)?.init.body));
    expect(commit).toMatchObject({
      transaction: 'token+/=',
      writes: [
        { update: { fields: { reserved: { integerValue: '50' } } } },
        {
          update: {
            fields: {
              createdAt: { timestampValue: '2026-10-28T00:00:00.000Z' },
            },
          },
        },
      ],
    });
  });
  it('does not retry or roll back an ambiguous commit', async () => {
    const urls: string[] = [];
    const client = new FirestoreClient(
      'siphon-test',
      async () => 'test-only-credential',
      async (input) => {
        urls.push(String(input));
        if (String(input).endsWith(':beginTransaction'))
          return Response.json({ transaction: 'token' });
        throw new Error(
          'Connection lost after commit may have reached provider',
        );
      },
    );
    await expect(
      client.transaction(async (tx) => {
        tx.set('budgets/meta', { limit: 1 });
      }),
    ).rejects.toMatchObject({ ambiguousCommit: true });
    expect(urls).toHaveLength(2);
    expect(urls[1]).toMatch(/:commit$/);
  });
  it('rolls back application failures, rejects reads after writes and path injection', async () => {
    const urls: string[] = [];
    const client = new FirestoreClient(
      'siphon-test',
      async () => 'test-only-credential',
      async (input) => {
        urls.push(String(input));
        return Response.json(
          String(input).endsWith(':beginTransaction')
            ? { transaction: 'token' }
            : {},
        );
      },
    );
    await expect(
      client.transaction(async (tx) => {
        tx.set('budgets/meta', { limit: 1 });
        await tx.get('budgets/meta');
      }),
    ).rejects.toThrow('reads must precede');
    expect(urls[1]).toMatch(/:rollback$/);
    await expect(client.get('budgets/../operations')).rejects.toThrow(
      'Invalid document path',
    );
    await expect(client.get('budgets/x?mask=secret')).rejects.toThrow(
      'Invalid document path',
    );
  });
  it('returns no document on 404 but fails closed on denied access', async () => {
    const missing = new FirestoreClient(
      'siphon-test',
      async () => 'test-only-credential',
      async () => new Response('', { status: 404 }),
    );
    expect(await missing.get('audits/missing')).toBeNull();
    const denied = new FirestoreClient(
      'siphon-test',
      async () => 'test-only-credential',
      async () => new Response('sensitive provider error', { status: 403 }),
    );
    await expect(denied.get('audits/missing')).rejects.toBeInstanceOf(
      FirestoreFailure,
    );
    await expect(denied.get('audits/missing')).rejects.toThrow(
      'Firestore request failed',
    );
  });
});
