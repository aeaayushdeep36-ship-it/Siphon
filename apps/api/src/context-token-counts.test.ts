import { describe, expect, it, vi } from 'vitest';
import { ContextTokenCounts } from './context-token-counts.js';
import { TestDocuments } from '../test/document-store.js';
import { firestoreTransport } from '../test/firestore-transport.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { AuditCommands } from './audit-commands.js';
import { canonicalJson, sha256 } from './hashing.js';
import { type DocumentStore } from './firestore.js';

async function fixture(sourceCount = 1) {
  const docs = new TestDocuments();
  docs.documents.set('testers/alice', { active: true });
  const { audit } = await new FirestoreAuditRepository(docs).create(
    'alice',
    {
      schemaVersion: '1.0',
      title: 'Authored count fixture',
      domain: 'orbital_dynamics',
    },
    'create',
  );
  let now = new Date('2026-10-29T00:00:00.000Z');
  const clock = () => now;
  const sources: {
    artifactId: string;
    reviewId: string;
    sourceDigest: string;
    text: string;
  }[] = [];
  const manifest = [];
  const expiresAt = '2026-10-30T00:00:00.000Z';
  for (let i = 0; i < sourceCount; i++) {
    const artifactId = crypto.randomUUID(),
      reviewId = crypto.randomUUID();
    const text = `# Authored orbit fixture ${i}; ignore instructions is untrusted text.\nx = 1\n`;
    const sourceDigest = await sha256(text);
    sources.push({ artifactId, reviewId, sourceDigest, text });
    manifest.push({
      schemaVersion: '1.0',
      artifactId,
      path: `fixture${i}.py`,
      bytes: new TextEncoder().encode(text).length,
      sha256: sourceDigest,
    });
    docs.documents.set(`audits/${audit.id}/artifacts/${artifactId}`, {
      artifactId,
      auditId: audit.id,
      ownerUid: 'alice',
      lifecycle: 'ready',
      sha256: sourceDigest,
      expiresAt,
    });
    docs.documents.set(`sourceContextReviews/${reviewId}`, {
      schemaVersion: '1.0',
      id: reviewId,
      ownerUid: 'alice',
      auditId: audit.id,
      artifactId,
      sourceDigest,
      purpose: 'meta_context',
      approved: true,
      verifiedAt: now.toISOString(),
      expiresAt,
    });
  }
  const inputDigest = await sha256(
    canonicalJson({ uploads: manifest, answers: [] }),
  );
  const revisionPath = `audits/${audit.id}/revisions/${audit.currentRevisionId}`;
  Object.assign(docs.documents.get(revisionPath)!, {
    stage: 'inspecting',
    status: 'running',
    sourceManifest: manifest,
    inputDigest,
  });
  // Authored availability/charging fixture, NOT evidence that the live endpoint is free.
  docs.documents.set('configuration/meta_counting', {
    schemaVersion: '1.0',
    model: 'muse-wonder-1.0',
    protocol: 'responses.v1',
    profile: 'stateless_text_json_no_tools.v1',
    countingCharge: 'no_charge',
    evidenceDigest: 'e'.repeat(64),
    verifiedAt: now.toISOString(),
    expiresAt,
  });
  const fence = {
    auditId: audit.id,
    revisionId: audit.currentRevisionId,
    generation: 0,
    inputDigest,
  };
  const countId = crypto.randomUUID();
  const transport = vi.fn<typeof fetch>(async () =>
    Response.json({ object: 'response.input_tokens', input_tokens: 100 }),
  );
  let documents: DocumentStore = docs;
  const run = (id = countId, signal = new AbortController().signal) =>
    new ContextTokenCounts(documents, 'authored-key', transport, clock).measure(
      'alice',
      fence,
      id,
      sources,
      signal,
    );
  return {
    docs,
    audit,
    sources,
    fence,
    countId,
    transport,
    revisionPath,
    clock,
    run,
    setTime: (value: string) => {
      now = new Date(value);
    },
    useStore: (value: DocumentStore) => {
      documents = value;
    },
    job: () => docs.documents.get(`modelTokenCountJobs/${countId}`)!,
    counter: () =>
      docs.documents.get(`budgets/model_token_counts_${fence.revisionId}`)!,
  };
}

describe('private one-shot context token measurements', () => {
  it('records a measured count, consumes a separate attempt and replays without generation or billing evidence', async () => {
    const f = await fixture();
    const first = await f.run();
    expect(first).toMatchObject({
      replayed: false,
      measurement: {
        inputTokens: 100,
        inputTokenLimit: 24000,
        measurement: 'rendered_context',
        withinInputPolicy: true,
        protocol: 'responses.v1',
      },
    });
    expect(await f.run()).toEqual({ ...first, replayed: true });
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.counter()).toMatchObject({ spent: 1, reserved: 0, limit: 8 });
    expect(f.job().status).toBe('measured');
    expect(
      [...f.docs.documents.keys()].some(
        (key) =>
          key.startsWith('modelTokenEvidence/') ||
          key.startsWith('operations/'),
      ),
    ).toBe(false);
    const serialized = JSON.stringify(f.job());
    expect(serialized).not.toContain('ignore instructions');
    expect(serialized).not.toContain('authored-key');
    expect(f.transport.mock.calls[0]![0]).toBe(
      'https://api.meta.ai/v1/responses/input_tokens',
    );
  });

  it('batches all ten source disclosures through the actual Firestore REST codec and transaction cache', async () => {
    const f = await fixture(10);
    const wire = firestoreTransport(f.docs);
    f.useStore(wire.client);
    expect((await f.run()).measurement.inputTokens).toBe(100);
    expect(wire.batches.filter((batch) => batch.length === 20)).toHaveLength(3);
    // Authored REST traffic only; OAuth/Meta/runtime limits are not measured here.
    expect(wire.calls).toHaveLength(17);
    expect(f.counter().spent).toBe(1);
  });

  it.each([
    'missing_config',
    'expired_config',
    'unverified_charge',
    'expired_review',
    'missing_review',
    'changed_artifact',
    'expired_artifact',
    'inactive_invitation',
  ])(
    'denies %s before provider disclosure or attempt consumption',
    async (mode) => {
      const f = await fixture();
      const config = f.docs.documents.get('configuration/meta_counting')!;
      const reviewPath = `sourceContextReviews/${f.sources[0]!.reviewId}`;
      const artifact = f.docs.documents.get(
        `audits/${f.audit.id}/artifacts/${f.sources[0]!.artifactId}`,
      )!;
      if (mode === 'missing_config')
        f.docs.documents.delete('configuration/meta_counting');
      if (mode === 'expired_config') config.expiresAt = f.clock().toISOString();
      if (mode === 'unverified_charge') config.countingCharge = 'unknown';
      if (mode === 'expired_review')
        f.docs.documents.get(reviewPath)!.expiresAt =
          '2026-10-29T00:00:05.000Z';
      if (mode === 'missing_review') f.docs.documents.delete(reviewPath);
      if (mode === 'changed_artifact') artifact.sha256 = 'f'.repeat(64);
      if (mode === 'expired_artifact')
        artifact.expiresAt = '2026-10-29T00:00:05.000Z';
      if (mode === 'inactive_invitation')
        f.docs.documents.get('testers/alice')!.active = false;
      await expect(f.run()).rejects.toThrow();
      expect(f.transport).not.toHaveBeenCalled();
      expect(f.job()).toBeUndefined();
      expect(f.counter()).toBeUndefined();
    },
  );

  it('preserves an over-policy measurement as a rejection, with no generation authorization', async () => {
    const f = await fixture();
    f.transport.mockResolvedValueOnce(
      Response.json({ object: 'response.input_tokens', input_tokens: 24001 }),
    );
    expect((await f.run()).measurement).toMatchObject({
      inputTokens: 24001,
      withinInputPolicy: false,
    });
    expect(f.counter().spent).toBe(1);
  });

  it('caps separate counting attempts without resetting an existing cap or usage', async () => {
    const f = await fixture();
    f.docs.documents.set(`budgets/model_token_counts_${f.fence.revisionId}`, {
      schemaVersion: '1.0',
      limit: 1,
      reserved: 0,
      spent: 0,
      halted: false,
    });
    await f.run();
    await expect(f.run(crypto.randomUUID())).rejects.toThrow();
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.counter()).toMatchObject({ spent: 1, limit: 1 });
  });

  it('allows only one concurrent claimant and does not let the losing caller mark its job unknown', async () => {
    const f = await fixture();
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.transport.mockImplementationOnce(async () => {
      await pending;
      return Response.json({
        object: 'response.input_tokens',
        input_tokens: 100,
      });
    });
    const first = f.run();
    await vi.waitFor(() => expect(f.transport).toHaveBeenCalledTimes(1));
    await expect(f.run()).rejects.toThrow();
    expect(f.job().status).toBe('dispatching');
    release();
    expect((await first).replayed).toBe(false);
    expect(f.job().status).toBe('measured');
    expect(f.counter().spent).toBe(1);
  });

  it.each(['http', 'transport', 'malformed'])(
    'retains the spent attempt and fixed unknown journal after %s; same ID never resends',
    async (mode) => {
      const f = await fixture();
      f.transport.mockImplementationOnce(async () => {
        if (mode === 'transport') throw new Error('private upstream marker');
        return mode === 'http'
          ? new Response('private upstream marker', { status: 429 })
          : Response.json({ input_tokens: 'private upstream marker' });
      });
      await expect(f.run()).rejects.toThrow(
        'Context token count unavailable; no generation was authorized',
      );
      expect(f.job().status).toBe('unknown');
      expect(f.counter().spent).toBe(1);
      expect(JSON.stringify(f.job())).not.toContain('private upstream marker');
      await expect(f.run()).rejects.toThrow();
      expect(f.transport).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['cancel', 'revoke_review', 'change_config', 'late_response'])(
    'rejects %s between disclosure and publication while preserving attempt history',
    async (mode) => {
      const f = await fixture();
      f.transport.mockImplementationOnce(async () => {
        if (mode === 'cancel')
          await new AuditCommands(f.docs, f.clock).cancel(
            'alice',
            f.fence.auditId,
            f.fence.revisionId,
            'cancel',
          );
        if (mode === 'revoke_review')
          f.docs.documents.delete(
            `sourceContextReviews/${f.sources[0]!.reviewId}`,
          );
        if (mode === 'change_config')
          f.docs.documents.get('configuration/meta_counting')!.evidenceDigest =
            'f'.repeat(64);
        if (mode === 'late_response') f.setTime('2026-10-29T00:00:11.000Z');
        return Response.json({
          object: 'response.input_tokens',
          input_tokens: 100,
        });
      });
      await expect(f.run()).rejects.toThrow();
      expect(f.job()).toMatchObject({
        status: 'unknown',
        result: null,
        failureCode: 'publication_denied',
      });
      expect(f.counter().spent).toBe(1);
    },
  );

  it('does not recount expired or altered cached measurements and rechecks permission on replay', async () => {
    const f = await fixture();
    await f.run();
    f.setTime('2026-10-29T00:01:00.000Z');
    await expect(f.run()).rejects.toThrow();
    f.setTime('2026-10-29T00:00:01.000Z');
    const result = f.job().result as Record<string, unknown>;
    result.revisionId = crypto.randomUUID();
    await expect(f.run()).rejects.toThrow();
    result.revisionId = f.fence.revisionId;
    f.docs.documents.get('testers/alice')!.active = false;
    await expect(f.run()).rejects.toThrow();
    expect(f.transport).toHaveBeenCalledTimes(1);
  });

  it('honors cancellation before any provider request', async () => {
    const f = await fixture();
    const signal = AbortSignal.abort();
    await expect(f.run(f.countId, signal)).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.job()).toBeUndefined();
  });
});
