import { decodeValue, encodeValue, FirestoreClient } from '../src/firestore.js';
import { type TestDocuments } from './document-store.js';

/** Offline REST port, not the emulator or a production persistence fallback.
 * Use for composition/request-count tests of the real FirestoreClient. Concurrent
 * transactions are deliberately unsupported; contention belongs in emulator tests.
 */
export function firestoreTransport(documents: TestDocuments) {
  const prefix =
    'https://firestore.googleapis.com/v1/projects/siphon-test/databases/(default)/documents';
  const namePrefix = 'projects/siphon-test/databases/(default)/documents/';
  const calls: string[] = [];
  const batches: string[][] = [];
  let snapshot: Map<string, Record<string, unknown>> | null = null;
  const encode = (value: Record<string, unknown>) => {
    const result = encodeValue(value);
    if (!('mapValue' in result)) throw new Error('Invalid authored fixture');
    return result.mapValue.fields;
  };
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith(prefix)) throw new Error('Unexpected fixture endpoint');
    const suffix = url.slice(prefix.length);
    calls.push(suffix);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<
      string,
      unknown
    >;
    if (suffix === ':beginTransaction') {
      if (snapshot)
        throw new Error('Concurrent fixture transactions are unsupported');
      snapshot = structuredClone(documents.documents);
      return Response.json({ transaction: 'offline-token' });
    }
    if (suffix === ':batchGet') {
      const source = body.transaction ? snapshot : documents.documents;
      if (!source || (body.transaction && body.transaction !== 'offline-token'))
        throw new Error('Invalid fixture transaction');
      const names = body.documents as string[];
      batches.push(names.map((name) => name.slice(namePrefix.length)));
      return Response.json(
        names
          .map((name) => {
            if (!name.startsWith(namePrefix))
              throw new Error('Invalid fixture identity');
            const record = source.get(name.slice(namePrefix.length));
            return record
              ? { found: { name, fields: encode(record) } }
              : { missing: name };
          })
          .reverse(),
      );
    }
    if (suffix === ':rollback') {
      snapshot = null;
      return Response.json({});
    }
    if (suffix === ':commit') {
      if (!snapshot || body.transaction !== 'offline-token')
        throw new Error('Invalid fixture commit');
      for (const write of body.writes as {
        update?: { name: string; fields: unknown };
        delete?: string;
      }[]) {
        const name = write.update?.name ?? write.delete!;
        if (!name.startsWith(namePrefix))
          throw new Error('Invalid fixture write');
        const path = name.slice(namePrefix.length);
        if (write.update)
          snapshot.set(
            path,
            decodeValue({
              mapValue: { fields: write.update.fields },
            }) as Record<string, unknown>,
          );
        else snapshot.delete(path);
      }
      documents.documents = snapshot;
      snapshot = null;
      return Response.json({ commitTime: '2026-10-29T00:00:00Z' });
    }
    if (!suffix.startsWith('/') || suffix.includes('?'))
      throw new Error('Unexpected fixture request');
    const record = documents.documents.get(suffix.slice(1));
    return record
      ? Response.json({ fields: encode(record) })
      : new Response(null, { status: 404 });
  };
  const client = new FirestoreClient(
    'siphon-test',
    async () => 'offline-only',
    transport,
  );
  return { client, calls, batches, transport };
}
