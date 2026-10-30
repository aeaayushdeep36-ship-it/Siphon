import assert from 'node:assert/strict';
import process from 'node:process';
import {
  FirestoreClient,
  FirestoreFailure,
} from '../apps/api/src/firestore.js';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST;
if (!endpoint || !/^127\.0\.0\.1:\d{1,5}$/.test(endpoint))
  throw new Error('A loopback Firestore emulator is required.');
const port = Number(endpoint.split(':')[1]);
if (port < 1024 || port > 65535) throw new Error('Invalid emulator port.');
const project = 'demo-siphon-rules';
const prefix = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
const requests: string[] = [];
const transport: typeof fetch = async (input, init) => {
  const url = String(input);
  // This transport is test-only. Never add an emulator override to production
  // authorization, accept an arbitrary host/project, or forward real tokens.
  assert.ok(url.startsWith(prefix));
  const suffix = url.slice(prefix.length);
  assert.ok(suffix.startsWith('/') || suffix.startsWith(':'));
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer owner');
  requests.push(suffix);
  return fetch(
    `http://${endpoint}/v1/projects/${project}/databases/(default)/documents${suffix}`,
    init,
  );
};
const store = new FirestoreClient(project, async () => 'owner', transport);
const a = 'restChecks/a',
  b = 'restChecks/b',
  missing = 'restChecks/missing';
let passed = 0;
async function scenario(_name: string, run: () => Promise<void>) {
  await run();
  passed++;
}

try {
  await scenario(
    'native values and timestamps survive a real REST commit',
    async () => {
      await store.transaction(async (tx) => {
        tx.set(a, {
          version: 1,
          absent: null,
          enabled: true,
          integer: 42,
          fraction: 0.125,
          createdAt: new Date('2026-10-29T00:00:00Z'),
          text: 'authored numeric fixture',
          empty: {},
          list: [1, { x: 'value' }],
        });
        tx.set(b, { version: 2 });
        tx.delete(missing);
      });
      assert.deepEqual(await store.get(a), {
        version: 1,
        absent: null,
        enabled: true,
        integer: 42,
        fraction: 0.125,
        createdAt: '2026-10-29T00:00:00Z',
        text: 'authored numeric fixture',
        empty: {},
        list: [1, { x: 'value' }],
      });
    },
  );
  await scenario(
    'batch reads preserve caller order, missing and duplicate identity',
    async () => {
      const start = requests.length;
      const values = await store.getMany([b, missing, a, b]);
      assert.deepEqual(
        values.map((value) => value?.version ?? null),
        [2, null, 1, 2],
      );
      values[0]!.version = 99;
      assert.equal(values[3]!.version, 2);
      assert.deepEqual(requests.slice(start), [':batchGet']);
    },
  );
  await scenario(
    'overlapping transaction reads share one snapshot/cache',
    async () => {
      const start = requests.length;
      await store.transaction(async (tx) => {
        const batch = tx.getMany([a, missing]);
        const single = tx.get(a);
        assert.deepEqual(await batch, [await single, null]);
        (await single)!.version = 99;
        assert.equal((await tx.get(a))!.version, 1);
        const next = await tx.getMany([b, a, missing]);
        assert.deepEqual(
          next.map((value) => value?.version ?? null),
          [2, 1, null],
        );
        tx.set(a, { version: 3 });
        tx.set(b, { version: 4 });
      });
      assert.deepEqual(requests.slice(start), [
        ':beginTransaction',
        ':batchGet',
        ':batchGet',
        ':commit',
      ]);
      assert.deepEqual(
        (await store.getMany([a, b])).map((value) => value!.version),
        [3, 4],
      );
    },
  );
  await scenario(
    'application failure rolls back staged writes without commit',
    async () => {
      const start = requests.length;
      const failure = new Error('authored callback failure');
      await assert.rejects(
        store.transaction(async (tx) => {
          await tx.getMany([a, b]);
          tx.set(a, { version: 99 });
          tx.delete(b);
          throw failure;
        }),
        (error) => error === failure,
      );
      assert.deepEqual(requests.slice(start), [
        ':beginTransaction',
        ':batchGet',
        ':rollback',
      ]);
      assert.deepEqual(
        (await store.getMany([a, b])).map((value) => value!.version),
        [3, 4],
      );
    },
  );
  await scenario(
    'read-after-write is refused even for a cached path',
    async () => {
      await assert.rejects(
        store.transaction(async (tx) => {
          await tx.getMany([a, b]);
          tx.set(a, { version: 99 });
          await tx.get(a);
        }),
        /reads must precede writes/,
      );
      assert.equal((await store.get(a))!.version, 3);
    },
  );
  await scenario(
    'missing documents and atomic deletion use the real protocol',
    async () => {
      assert.equal(await store.get(missing), null);
      await store.transaction(async (tx) => {
        const values = await tx.getMany([b, missing]);
        assert.deepEqual(values, [{ version: 4 }, null]);
        tx.delete(b);
      });
      assert.deepEqual(await store.getMany([b, missing]), [null, null]);
    },
  );
  await scenario(
    'failed commit is surfaced once and never retried automatically',
    async () => {
      let commits = 0;
      const rejecting = new FirestoreClient(
        project,
        async () => 'owner',
        async (input, init) => {
          if (String(input).endsWith(':commit')) {
            commits++;
            // Send a syntactically valid commit with an impossible precondition to
            // the real emulator. Its refusal must leave the existing value intact.
            const body = JSON.parse(String(init!.body)) as {
              writes: Record<string, unknown>[];
            };
            body.writes[0]!.currentDocument = { exists: false };
            return transport(input, { ...init, body: JSON.stringify(body) });
          }
          return transport(input, init);
        },
      );
      await assert.rejects(
        rejecting.transaction(async (tx) => {
          await tx.get(a);
          tx.set(a, { version: 99 });
        }),
        (error) => {
          assert.ok(error instanceof FirestoreFailure);
          assert.equal(
            commits,
            1,
            `Commit not reached (status ${error.status}; requests ${requests.slice(-5).join(',')})`,
          );
          return true;
        },
      );
      assert.equal(commits, 1);
      assert.equal((await store.get(a))!.version, 3);
    },
  );
  process.stdout.write(
    `Verified ${passed} Firestore REST emulator scenarios.\n`,
  );
} finally {
  await store.transaction(async (tx) => {
    tx.delete(a);
    tx.delete(b);
    tx.delete(missing);
  });
}
