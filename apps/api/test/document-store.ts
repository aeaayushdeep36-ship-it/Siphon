import {
  decodeValue,
  encodeValue,
  type DocumentStore,
  type DocumentTransaction,
} from '../src/firestore.js';

/** Unit test port only, not a Firestore emulator or hosted persistence fallback. */
export class TestDocuments implements DocumentStore {
  documents = new Map<string, Record<string, unknown>>();
  private tail = Promise.resolve();
  async get(path: string) {
    return structuredClone(this.documents.get(path) ?? null);
  }
  async getMany(paths: readonly string[]) {
    return paths.map((path) =>
      structuredClone(this.documents.get(path) ?? null),
    );
  }
  async listCollection(collection: string) {
    const prefix = `${collection}/`;
    const rows: Array<{ id: string; data: Record<string, unknown> }> = [];
    for (const [path, data] of this.documents.entries()) {
      if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) {
        rows.push({
          id: path.slice(prefix.length),
          data: structuredClone(data),
        });
      }
    }
    return rows;
  }
  async transaction<T>(
    callback: (tx: DocumentTransaction) => Promise<T>,
  ): Promise<T> {
    const prior = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    const documents = structuredClone(this.documents);
    let writing = false;
    try {
      const result = await callback({
        get: async (path) => {
          if (writing) throw new Error('Reads after writes');
          return structuredClone(documents.get(path) ?? null);
        },
        getMany: async (paths) => {
          if (writing) throw new Error('Reads after writes');
          return paths.map((path) =>
            structuredClone(documents.get(path) ?? null),
          );
        },
        set: (path, value) => {
          writing = true;
          documents.set(
            path,
            decodeValue(encodeValue(value)) as Record<string, unknown>,
          );
        },
        delete: (path) => {
          writing = true;
          documents.delete(path);
        },
      });
      this.documents = documents;
      return result;
    } finally {
      release();
    }
  }
}
