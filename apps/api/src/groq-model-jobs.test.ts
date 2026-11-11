import { describe, expect, it } from 'vitest';
import { ContextCoordinator } from './context-coordinator.js';
import { ContextSourceReviews } from './context-source-reviews.js';
import { ContextTasks } from './context-tasks.js';
import { GroqModelJobs, groqConfigurationDigest } from './groq-model-jobs.js';
import { type AiConfiguration } from './ai-config.js';
import {
  groqContextFixture,
  groqFixtureConfig,
} from '../test/groq-stage-fixture.js';

type Fixture = Awaited<ReturnType<typeof groqContextFixture>>;
const day = '20261108';
const requestCounter = `budgets/groq_requests_day_${day}`;
const tokenCounter = `budgets/groq_tokens_day_${day}`;
const quotaPath = 'aiQuotaWindows/groq';

function coordinator(f: Fixture, config: AiConfiguration = groqFixtureConfig) {
  return new ContextCoordinator(
    f.docs,
    { readBatch: f.readBatch },
    config.apiKey,
    f.transport,
    f.clock,
    undefined,
    config,
  );
}

async function prepare(
  f: Fixture,
  config: AiConfiguration = groqFixtureConfig,
) {
  const review = await new ContextSourceReviews(
    f.docs,
    { readBatch: f.readBatch },
    f.clock,
    config,
  ).loadAndReview('alice', f.fence);
  if (review.status === 'blocked')
    throw new Error('Authored source was blocked');
  return new ContextTasks(f.docs, f.clock, undefined, config).prepare(
    'alice',
    f.fence,
    review.sources,
  );
}

function quotaEntry(f: Fixture, tokens = 1, offsetMs = 0) {
  return {
    operationId: crypto.randomUUID(),
    dispatchedAt: new Date(f.clock().getTime() + offsetMs).toISOString(),
    tokens,
  };
}

describe('Groq quota reservations and reconciliation', () => {
  it('requires current owner AI disclosure before reserving or dispatching a provider call', async () => {
    const f = await groqContextFixture();
    const prepared = await prepare(f);
    const consentPath = `${f.base}/aiDisclosure/current`;
    f.docs.documents.delete(consentPath);
    const runner = new GroqModelJobs(
      f.docs,
      groqFixtureConfig.apiKey,
      groqFixtureConfig,
      f.transport,
      f.clock,
    );

    await expect(
      runner.run('alice', f.fence, f.ids.operationId, prepared, 'context'),
    ).rejects.toMatchObject({ code: 'ai_disclosure_required' });
    expect(f.transport).not.toHaveBeenCalled();
    expect(
      f.docs.documents.get(`operations/${f.ids.operationId}`),
    ).toBeUndefined();
    expect(f.docs.documents.get(f.base)?.slotLeaseId ?? null).toBeNull();
  });

  it('blocks dispatch when consent was revoked for the current model configuration', async () => {
    const f = await groqContextFixture();
    const prepared = await prepare(f);
    f.docs.documents.get(`${f.base}/aiDisclosure/current`)!.decision =
      'revoked';
    const runner = new GroqModelJobs(
      f.docs,
      groqFixtureConfig.apiKey,
      groqFixtureConfig,
      f.transport,
      f.clock,
    );

    await expect(
      runner.run('alice', f.fence, f.ids.operationId, prepared, 'context'),
    ).rejects.toMatchObject({ code: 'ai_disclosure_required' });
    expect(f.transport).not.toHaveBeenCalled();
    expect(
      f.docs.documents.get(`operations/${f.ids.operationId}`),
    ).toBeUndefined();
  });

  it('releases capacity during a quota wait while preserving the operation reservation for a later authorized retry', async () => {
    const f = await groqContextFixture();
    const prepared = await prepare(f);
    let current = f.clock();
    const clock = () => current;
    f.docs.documents.set(quotaPath, {
      entries: [quotaEntry(f, groqFixtureConfig.tokensPerMinute)],
      blockedUntil: null,
      halted: false,
    });
    const runner = new GroqModelJobs(
      f.docs,
      groqFixtureConfig.apiKey,
      groqFixtureConfig,
      f.transport,
      clock,
    );
    await expect(
      runner.run('alice', f.fence, f.ids.operationId, prepared, 'context'),
    ).rejects.toMatchObject({ code: 'ai_quota_unavailable' });
    expect(f.docs.documents.get(f.base)).toMatchObject({ slotLeaseId: null });
    expect(f.docs.documents.get('slots/global')!.leaseIds).toEqual([]);
    expect(f.docs.documents.get('slots/user_alice')!.leaseIds).toEqual([]);
    const released = [...f.docs.documents.entries()].filter(([path]) =>
      path.startsWith('slotLeases/'),
    );
    expect(released).toHaveLength(1);
    expect(released[0]![1]).toMatchObject({
      status: 'released',
      pendingOperations: 0,
    });
    expect(
      f.docs.documents.get(`operations/${f.ids.operationId}`),
    ).toMatchObject({ outcome: 'reserved' });
    expect(f.docs.documents.get(requestCounter)).toMatchObject({
      spent: 0,
      reserved: 1,
    });
    expect(f.transport).not.toHaveBeenCalled();
    current = new Date(current.getTime() + 60001);
    await expect(
      runner.run('alice', f.fence, f.ids.operationId, prepared, 'context'),
    ).resolves.toMatchObject({ providerId: 'authored-groq-response' });
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.docs.documents.get(requestCounter)).toMatchObject({
      spent: 1,
      reserved: 0,
    });
    expect(f.docs.documents.get(tokenCounter)).toMatchObject({
      spent: 600,
      reserved: 0,
    });
  });

  it('retains capacity when quota-blocked work races a dispatched operation whose outcome then becomes unknown', async () => {
    const f = await groqContextFixture();
    const prepared = await prepare(f);
    let notifyDispatch!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      notifyDispatch = resolve;
    });
    let loseResponse!: (error: Error) => void;
    const pending = new Promise<Response>((_resolve, reject) => {
      loseResponse = reject;
    });
    f.transport.mockImplementation(async () => {
      notifyDispatch();
      return pending;
    });
    const runner = new GroqModelJobs(
      f.docs,
      groqFixtureConfig.apiKey,
      groqFixtureConfig,
      f.transport,
      f.clock,
    );
    // Attach the rejection handler immediately: the failure is deliberate fixture behavior.
    const first = runner
      .run('alice', f.fence, f.ids.operationId, prepared, 'context')
      .then(
        () => {
          throw new Error('Authored transport unexpectedly completed');
        },
        (error: unknown) => error,
      );
    await dispatched;
    const leaseId = f.docs.documents.get(f.base)!.slotLeaseId;
    expect(typeof leaseId).toBe('string');
    await expect(
      runner.run('alice', f.fence, crypto.randomUUID(), prepared, 'context'),
    ).rejects.toMatchObject({ code: 'ai_quota_unavailable' });
    expect(f.docs.documents.get(f.base)!.slotLeaseId).toBe(leaseId);
    expect(f.docs.documents.get(`slotLeases/${String(leaseId)}`)).toMatchObject(
      { status: 'held', pendingOperations: 1 },
    );
    loseResponse(new Error('Authored response lost after provider dispatch'));
    expect(await first).toMatchObject({ code: 'transport_unknown' });
    expect(
      f.docs.documents.get(`operations/${f.ids.operationId}`),
    ).toMatchObject({ outcome: 'unknown' });
    await expect(
      runner.run('alice', f.fence, crypto.randomUUID(), prepared, 'context'),
    ).rejects.toMatchObject({ code: 'ai_quota_unavailable' });
    expect(f.docs.documents.get(f.base)!.slotLeaseId).toBe(leaseId);
    expect(f.docs.documents.get(`slotLeases/${String(leaseId)}`)).toMatchObject(
      { status: 'held', pendingOperations: 1 },
    );
    expect(f.docs.documents.get('slots/global')!.leaseIds).toContain(leaseId);
    expect(f.transport).toHaveBeenCalledOnce();
  });

  it.each(['requests', 'tokens'])(
    'refuses exhausted daily %s before provider I/O',
    async (kind) => {
      const f = await groqContextFixture();
      const key = kind === 'requests' ? requestCounter : tokenCounter;
      const limit =
        kind === 'requests'
          ? groqFixtureConfig.requestsPerDay
          : groqFixtureConfig.tokensPerDay;
      f.docs.documents.set(key, {
        schemaVersion: '1.0',
        limit,
        reserved: 0,
        spent: limit,
        halted: false,
      });
      const result = await coordinator(f).run('alice', f.fence, f.ids);
      expect(result).toMatchObject({
        status: 'blocked',
        code: 'ai_quota_unavailable',
      });
      expect(f.transport).not.toHaveBeenCalled();
      expect(f.docs.documents.get(key)).toMatchObject({
        spent: limit,
        reserved: 0,
      });
      expect(f.docs.documents.has(`operations/${f.ids.operationId}`)).toBe(
        false,
      );
    },
  );

  it.each(['requests', 'tokens', 'blocked', 'halted', 'future'])(
    'refuses rolling quota conflicts: %s',
    async (kind) => {
      const f = await groqContextFixture();
      const config = { ...groqFixtureConfig, requestsPerMinute: 1 };
      f.docs.documents.set(quotaPath, {
        entries: ['requests', 'tokens', 'future'].includes(kind)
          ? [
              quotaEntry(
                f,
                kind === 'tokens' ? config.tokensPerMinute : 1,
                kind === 'future' ? 1 : 0,
              ),
            ]
          : [],
        blockedUntil:
          kind === 'blocked'
            ? new Date(f.clock().getTime() + 5000).toISOString()
            : null,
        halted: kind === 'halted',
      });
      expect(
        await coordinator(f, config).run('alice', f.fence, f.ids),
      ).toMatchObject({ status: 'blocked', code: 'ai_quota_unavailable' });
      expect(f.transport).not.toHaveBeenCalled();
      expect(
        f.docs.documents.get(`operations/${f.ids.operationId}`),
      ).toMatchObject({ outcome: 'reserved' });
      expect(f.docs.documents.get(requestCounter)).toMatchObject({
        spent: 0,
        reserved: 1,
      });
    },
  );

  it('expires rolling entries at the exact window boundary and settles actual token use', async () => {
    const f = await groqContextFixture();
    f.docs.documents.set(quotaPath, {
      entries: [quotaEntry(f, groqFixtureConfig.tokensPerMinute, -60000)],
      blockedUntil: null,
      halted: false,
    });
    expect(await coordinator(f).run('alice', f.fence, f.ids)).toMatchObject({
      status: 'waiting_for_input',
    });
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.docs.documents.get(tokenCounter)).toMatchObject({
      spent: 600,
      reserved: 0,
    });
    expect(f.docs.documents.get(requestCounter)).toMatchObject({
      spent: 1,
      reserved: 0,
    });
    const quota = f.docs.documents.get(quotaPath)!;
    expect(quota.entries).toHaveLength(1);
    expect(quota.entries).toEqual([
      expect.objectContaining({
        operationId: f.ids.operationId,
        tokens:
          groqFixtureConfig.maxInputTokens + groqFixtureConfig.maxOutputTokens,
      }),
    ]);
  });

  it('allows only one dispatch for concurrent delivery of the same operation', async () => {
    const f = await groqContextFixture();
    const result = await Promise.allSettled([
      coordinator(f).run('alice', f.fence, f.ids),
      coordinator(f).run('alice', f.fence, f.ids),
    ]);
    expect(
      result.some(
        (entry) =>
          entry.status === 'fulfilled' &&
          entry.value.status === 'waiting_for_input',
      ),
    ).toBe(true);
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.docs.documents.get(requestCounter)).toMatchObject({
      spent: 1,
      reserved: 0,
    });
    expect(f.docs.documents.get(tokenCounter)).toMatchObject({
      spent: 600,
      reserved: 0,
    });
    expect(f.docs.documents.get(quotaPath)!.entries).toHaveLength(1);
  });

  it('retains unknown-use reservations and blocks replay after transport failure', async () => {
    const f = await groqContextFixture();
    f.transport.mockRejectedValue(new Error('Authored lost provider response'));
    await expect(
      coordinator(f).run('alice', f.fence, f.ids),
    ).rejects.toMatchObject({ code: 'transport_unknown' });
    expect(
      f.docs.documents.get(`operations/${f.ids.operationId}`),
    ).toMatchObject({ outcome: 'unknown', usage: null });
    expect(f.docs.documents.get(tokenCounter)).toMatchObject({
      spent: 0,
      reserved:
        groqFixtureConfig.maxInputTokens + groqFixtureConfig.maxOutputTokens,
    });
    expect(f.docs.documents.get(requestCounter)).toMatchObject({
      spent: 1,
      reserved: 0,
    });
    expect(await coordinator(f).run('alice', f.fence, f.ids)).toMatchObject({
      status: 'blocked',
      code: 'context_operation_requires_reconciliation',
    });
    expect(f.transport).toHaveBeenCalledOnce();
  });

  it('halts the provider on an input overrun even when total usage fits the token reservation', async () => {
    const f = await groqContextFixture();
    f.transport.mockImplementation(async () =>
      Response.json({
        id: 'authored-overrun',
        object: 'chat.completion',
        model: groqFixtureConfig.model,
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: JSON.stringify(f.proposal) },
          },
        ],
        usage: {
          prompt_tokens: groqFixtureConfig.maxInputTokens + 1,
          completion_tokens: 100,
          total_tokens: groqFixtureConfig.maxInputTokens + 101,
        },
      }),
    );
    await expect(
      coordinator(f).run('alice', f.fence, f.ids),
    ).rejects.toMatchObject({ code: 'usage_exceeded' });
    expect(f.docs.documents.get(quotaPath)).toMatchObject({ halted: true });
    expect(
      f.docs.documents.get(`operations/${f.ids.operationId}`),
    ).toMatchObject({ outcome: 'failed' });
    expect(f.docs.documents.get(tokenCounter)).toMatchObject({
      spent: groqFixtureConfig.maxInputTokens + 101,
      reserved: 0,
    });
    expect(f.docs.documents.has(`${f.base}/context/current`)).toBe(false);
  });

  it('preserves a later provider cooldown when another response carries an earlier Retry-After', async () => {
    const f = await groqContextFixture();
    const until = new Date(f.clock().getTime() + 10000).toISOString();
    f.transport.mockImplementation(async () => {
      const quota = f.docs.documents.get(quotaPath)!;
      f.docs.documents.set(quotaPath, { ...quota, blockedUntil: until });
      return new Response('authored provider error', {
        status: 429,
        headers: { 'retry-after': '1' },
      });
    });
    await expect(
      coordinator(f).run('alice', f.fence, f.ids),
    ).rejects.toMatchObject({ httpStatus: 429 });
    expect(f.docs.documents.get(quotaPath)).toMatchObject({
      blockedUntil: until,
    });
    expect(
      f.docs.documents.get(`operations/${f.ids.operationId}`),
    ).toMatchObject({ outcome: 'unknown' });
    expect(f.transport).toHaveBeenCalledOnce();
  });

  it('rejects request tampering before reserving operations or disclosing source', async () => {
    const f = await groqContextFixture();
    const prepared = await prepare(f);
    if (!('messages' in prepared.request))
      throw new Error('Expected Groq fixture');
    prepared.request.messages[1].content += '\nchanged';
    await expect(
      new GroqModelJobs(
        f.docs,
        groqFixtureConfig.apiKey,
        groqFixtureConfig,
        f.transport,
        f.clock,
      ).run('alice', f.fence, f.ids.operationId, prepared, 'context'),
    ).rejects.toThrow();
    expect(f.docs.documents.has(`operations/${f.ids.operationId}`)).toBe(false);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('releases a never-dispatched operation and slot when source approval expires between preparation and binding', async () => {
    const f = await groqContextFixture();
    const prepared = await prepare(f);
    const source = prepared.sources[0]!;
    const reviewPath = `sourceContextReviews/${source.reviewId}`;
    f.docs.documents.set(reviewPath, {
      ...f.docs.documents.get(reviewPath),
      expiresAt: '2026-11-07T23:59:59.000Z',
    });

    await expect(
      new GroqModelJobs(
        f.docs,
        groqFixtureConfig.apiKey,
        groqFixtureConfig,
        f.transport,
        f.clock,
      ).run('alice', f.fence, f.ids.operationId, prepared, 'context'),
    ).rejects.toThrow('Source disclosure is not approved');

    expect(f.transport).not.toHaveBeenCalled();
    expect(
      f.docs.documents.get(`operations/${f.ids.operationId}`),
    ).toMatchObject({
      outcome: 'failed',
    });
    expect(f.docs.documents.get(requestCounter)).toMatchObject({
      spent: 0,
      reserved: 0,
    });
    expect(f.docs.documents.get(f.base)).toMatchObject({ slotLeaseId: null });
    expect(f.docs.documents.get('slots/global')!.leaseIds).toEqual([]);
  });

  it('rejects an existing immutable job with changed configuration before reservation', async () => {
    const f = await groqContextFixture();
    const prepared = await prepare(f);
    f.docs.documents.set(`modelJobs/${f.ids.operationId}`, {
      schemaVersion: '1.0',
      operationId: f.ids.operationId,
      requestDigest: prepared.requestDigest,
      provider: 'groq',
      model: groqFixtureConfig.model,
      endpoint: groqFixtureConfig.endpoint,
      configDigest: await groqConfigurationDigest({
        ...groqFixtureConfig,
        requestsPerDay: 99,
      }),
      purpose: 'context',
      inputTokenBound: groqFixtureConfig.maxInputTokens,
      outputTokenBound: groqFixtureConfig.maxOutputTokens,
      admission: 'request_bytes_screen_not_token_measurement.v1',
      createdAt: f.clock().toISOString(),
    });
    await expect(
      new GroqModelJobs(
        f.docs,
        groqFixtureConfig.apiKey,
        groqFixtureConfig,
        f.transport,
        f.clock,
      ).run('alice', f.fence, f.ids.operationId, prepared, 'context'),
    ).rejects.toThrow('configuration');
    expect(f.docs.documents.has(`operations/${f.ids.operationId}`)).toBe(false);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('excludes secret rotations from the public configuration digest', async () => {
    expect(await groqConfigurationDigest(groqFixtureConfig)).toBe(
      await groqConfigurationDigest({
        ...groqFixtureConfig,
        apiKey: 'another-authored-secret',
      }),
    );
    expect(await groqConfigurationDigest(groqFixtureConfig)).not.toBe(
      await groqConfigurationDigest({
        ...groqFixtureConfig,
        maxOutputTokens: groqFixtureConfig.maxOutputTokens - 1,
      }),
    );
  });
});
