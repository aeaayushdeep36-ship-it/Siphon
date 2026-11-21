import { describe, expect, it } from 'vitest';
import { ContextCoordinator } from './context-coordinator.js';
import { AdapterCoordinator } from './adapter-coordinator.js';
import { GROQ_CHAT_ENDPOINT } from './ai-config.js';
import { adapterStageFixture } from '../test/adapter-stage-fixture.js';
import {
  groqFixtureConfig as config,
  groqContextFixture as contextFixture,
} from '../test/groq-stage-fixture.js';
async function adapterFixture() {
  const fixture = await adapterStageFixture();
  // The completed prior context is authored test data. The tested adapter stage
  // still performs real task binding, quota reservations, dispatch and settlement.
  fixture.docs.documents.set(`modelJobs/${fixture.contextOperationId}`, {
    schemaVersion: '1.0',
    operationId: fixture.contextOperationId,
    requestDigest: 'c'.repeat(64),
    provider: 'groq',
    model: config.model,
    endpoint: config.endpoint,
    configDigest: 'f'.repeat(64),
    purpose: 'context',
    inputTokenBound: config.maxInputTokens,
    outputTokenBound: config.maxOutputTokens,
    admission: 'request_bytes_screen_not_token_measurement.v1',
    createdAt: fixture.clock().toISOString(),
  });
  const task = fixture.docs.documents.get(
    `contextTasks/${fixture.contextOperationId}`,
  )!;
  task.promptVersion = 'context.groq.1';
  Object.assign(
    fixture.docs.documents.get(
      `sourceContextReviews/${fixture.source.reviewId}`,
    )!,
    {
      purpose: 'groq_context',
      model: config.model,
      endpoint: config.endpoint,
    },
  );
  fixture.transport.mockImplementation(async () =>
    Response.json({
      id: 'authored-groq-adapter',
      object: 'chat.completion',
      model: config.model,
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: JSON.stringify(fixture.adapter),
          },
        },
      ],
      usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 },
    }),
  );
  const coordinator = new AdapterCoordinator(
    fixture.docs,
    { readBatch: fixture.readBatch },
    config.apiKey,
    fixture.transport,
    fixture.clock,
    config,
  );
  return { ...fixture, coordinator };
}

describe('Groq coordinator integration', () => {
  it('publishes context and questions from one accounted Groq call without Meta configuration or token-count requests', async () => {
    const f = await contextFixture();
    const coordinator = new ContextCoordinator(
      f.docs,
      { readBatch: f.readBatch },
      config.apiKey,
      f.transport,
      f.clock,
      undefined,
      config,
    );
    const result = await coordinator.run('alice', f.fence, f.ids);
    expect(result.status).toBe('waiting_for_input');
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.transport.mock.calls[0]![0]).toBe(GROQ_CHAT_ENDPOINT);
    const request = JSON.parse(String(f.transport.mock.calls[0]![1]?.body));
    expect(request.model).toBe(config.model);
    expect(request.response_format.json_schema.strict).toBe(true);
    expect(
      f.docs.documents.get(`operations/${f.ids.operationId}`),
    ).toMatchObject({ outcome: 'succeeded' });
    expect(
      f.docs.documents.get(`modelReceipts/${f.ids.operationId}`),
    ).toMatchObject({
      operationId: f.ids.operationId,
      provider: 'groq',
      model: config.model,
      endpoint: config.endpoint,
      providerId: 'authored-groq-response',
      outcome: 'succeeded',
      failureCode: null,
      usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 },
    });
    expect(f.docs.documents.get(`${f.base}/context/current`)).toMatchObject({
      proposal: f.proposal,
    });
    expect(f.docs.documents.has('configuration/meta_credits')).toBe(false);
    if (result.status !== 'waiting_for_input')
      throw new Error('Fixture did not reach clarification');
    expect(await coordinator.run('alice', result.fence, f.ids)).toMatchObject({
      status: 'waiting_for_input',
    });
    expect(f.transport).toHaveBeenCalledTimes(1);
  });

  it('blocks credential-bearing source before Groq I/O or generation reservations', async () => {
    const f = await contextFixture('api_key = "AUTHORED_SENSITIVE_VALUE"\n');
    const coordinator = new ContextCoordinator(
      f.docs,
      { readBatch: f.readBatch },
      config.apiKey,
      f.transport,
      f.clock,
      undefined,
      config,
    );
    const result = await coordinator.run('alice', f.fence, f.ids);
    expect(result).toMatchObject({
      status: 'blocked',
      code: 'source_disclosure_blocked',
    });
    expect(JSON.stringify(result)).not.toContain('AUTHORED_SENSITIVE_VALUE');
    expect(f.docs.documents.has(`operations/${f.ids.operationId}`)).toBe(false);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('blocks Groq token literals in source comments without exposing their value', async () => {
    const marker = `gsk_${'A'.repeat(52)}`;
    const f = await contextFixture(`# provider example: ${marker}\n`);
    const coordinator = new ContextCoordinator(
      f.docs,
      { readBatch: f.readBatch },
      config.apiKey,
      f.transport,
      f.clock,
      undefined,
      config,
    );
    const result = await coordinator.run('alice', f.fence, f.ids);
    expect(result).toMatchObject({
      status: 'blocked',
      code: 'source_disclosure_blocked',
    });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('returns a size blocker without truncating or dispatching an oversized request', async () => {
    const f = await contextFixture();
    const coordinator = new ContextCoordinator(
      f.docs,
      { readBatch: f.readBatch },
      config.apiKey,
      f.transport,
      f.clock,
      undefined,
      { ...config, maxInputBytes: 1000 },
    );
    expect(await coordinator.run('alice', f.fence, f.ids)).toMatchObject({
      status: 'blocked',
      code: 'ai_request_too_large',
      fence: f.fence,
    });
    expect(f.docs.documents.has(`operations/${f.ids.operationId}`)).toBe(false);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('fits a small authored simulation within the documented conservative free-tier settings', async () => {
    const f = await contextFixture();
    const deployment = {
      ...config,
      maxInputBytes: 6000,
      maxInputTokens: 6000,
      maxOutputTokens: 1000,
      tokensPerMinute: 7000,
      tokensPerDay: 180000,
      requestsPerMinute: 20,
      requestsPerDay: 900,
    };
    const coordinator = new ContextCoordinator(
      f.docs,
      { readBatch: f.readBatch },
      deployment.apiKey,
      f.transport,
      f.clock,
      undefined,
      deployment,
    );
    expect(await coordinator.run('alice', f.fence, f.ids)).toMatchObject({
      status: 'waiting_for_input',
    });
    expect(
      new TextEncoder().encode(String(f.transport.mock.calls[0]![1]?.body))
        .length,
    ).toBeLessThanOrEqual(deployment.maxInputBytes);
  });

  it('returns a quota blocker before Groq I/O when the daily request allowance is exhausted', async () => {
    const f = await contextFixture();
    f.docs.documents.set('budgets/groq_requests_day_20261108', {
      schemaVersion: '1.0',
      limit: config.requestsPerDay,
      spent: config.requestsPerDay,
      reserved: 0,
      halted: false,
    });
    const coordinator = new ContextCoordinator(
      f.docs,
      { readBatch: f.readBatch },
      config.apiKey,
      f.transport,
      f.clock,
      undefined,
      config,
    );
    expect(await coordinator.run('alice', f.fence, f.ids)).toMatchObject({
      status: 'blocked',
      code: 'ai_quota_unavailable',
      fence: f.fence,
    });
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('rejects foreign callers and stale revisions before source disclosure', async () => {
    for (const mode of ['foreign', 'stale']) {
      const f = await contextFixture();
      const coordinator = new ContextCoordinator(
        f.docs,
        { readBatch: f.readBatch },
        config.apiKey,
        f.transport,
        f.clock,
        undefined,
        config,
      );
      await expect(
        coordinator.run(
          mode === 'foreign' ? 'bob' : 'alice',
          mode === 'stale' ? { ...f.fence, generation: 1 } : f.fence,
          f.ids,
        ),
      ).rejects.toThrow();
      expect(f.readBatch).not.toHaveBeenCalled();
      expect(f.transport).not.toHaveBeenCalled();
    }
  });

  it('names the selected provider when credentials are absent and never falls back to Meta', async () => {
    const f = await contextFixture();
    const context = new ContextCoordinator(
      f.docs,
      { readBatch: f.readBatch },
      '',
      f.transport,
      f.clock,
      undefined,
      config,
    );
    expect(await context.run('alice', f.fence, f.ids)).toMatchObject({
      status: 'blocked',
      code: 'ai_credentials_required',
      required: ['Groq API key'],
    });
    const adapter = new AdapterCoordinator(
      f.docs,
      { readBatch: f.readBatch },
      '',
      f.transport,
      f.clock,
      config,
    );
    expect(await adapter.run('alice', f.fence)).toMatchObject({
      status: 'blocked',
      code: 'ai_credentials_required',
    });
    expect(f.readBatch).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('publishes an unverified adapter proposal from one Groq request and replays without dispatch', async () => {
    const f = await adapterFixture();
    const result = await f.coordinator.run('alice', f.fence);
    expect(result.status).toBe('proposal_ready');
    if (result.status !== 'proposal_ready')
      throw new Error('Authored adapter fixture was blocked');
    expect(result.proposal).toEqual(f.adapter);
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.transport.mock.calls[0]![0]).toBe(GROQ_CHAT_ENDPOINT);
    expect(
      f.docs.documents.get(`operations/${result.operationId}`),
    ).toMatchObject({ outcome: 'succeeded' });
    expect(
      f.docs.documents.get(`modelReceipts/${result.operationId}`),
    ).toMatchObject({
      operationId: result.operationId,
      provider: 'groq',
      model: config.model,
      providerId: 'authored-groq-adapter',
      outcome: 'succeeded',
      failureCode: null,
      usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 },
    });
    expect(
      f.docs.documents.get(`${f.base}/adapterProposals/current`),
    ).toMatchObject({ status: 'proposed' });
    expect(f.docs.documents.has(`${f.base}/adapters/current`)).toBe(false);
    expect(await f.coordinator.run('alice', result.fence)).toMatchObject({
      status: 'proposal_ready',
      adapterDigest: result.adapterDigest,
    });
    expect(f.transport).toHaveBeenCalledTimes(1);
  });

  it('refuses an adapter disclosure review for a different provider or model before Groq I/O', async () => {
    for (const change of [
      { purpose: 'meta_context' },
      { model: 'authored/other-model' },
    ]) {
      const f = await adapterFixture();
      Object.assign(
        f.docs.documents.get(`sourceContextReviews/${f.source.reviewId}`)!,
        change,
      );
      await expect(f.coordinator.run('alice', f.fence)).rejects.toThrow(
        'disclosure',
      );
      expect(f.transport).not.toHaveBeenCalled();
    }
  });

  it('returns the advanced adapter fence with a size blocker so runtime issue publication uses the current revision', async () => {
    const f = await adapterFixture();
    const coordinator = new AdapterCoordinator(
      f.docs,
      { readBatch: f.readBatch },
      config.apiKey,
      f.transport,
      f.clock,
      { ...config, maxInputBytes: 1000 },
    );
    expect(await coordinator.run('alice', f.fence)).toMatchObject({
      status: 'blocked',
      code: 'ai_request_too_large',
      fence: { ...f.fence, generation: 1 },
    });
    expect(f.docs.documents.get(f.base)).toMatchObject({
      stage: 'adapting',
      generation: 1,
    });
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('settles truncated Groq adapter usage and blocks replay rather than publishing or repeating the call', async () => {
    const f = await adapterFixture();
    f.transport.mockImplementation(async () =>
      Response.json({
        id: 'authored-incomplete',
        object: 'chat.completion',
        model: config.model,
        choices: [
          {
            index: 0,
            finish_reason: 'length',
            message: { role: 'assistant', content: '{' },
          },
        ],
        usage: {
          prompt_tokens: 500,
          completion_tokens: 100,
          total_tokens: 600,
        },
      }),
    );
    await expect(f.coordinator.run('alice', f.fence)).rejects.toThrow();
    const stage = f.docs.documents.get(`adapterStages/${f.fence.revisionId}`)!;
    expect(
      f.docs.documents.get(`operations/${stage.operationId}`),
    ).toMatchObject({ outcome: 'failed' });
    const receipt = f.docs.documents.get(`modelReceipts/${stage.operationId}`);
    expect(receipt).toMatchObject({
      operationId: stage.operationId,
      provider: 'groq',
      model: config.model,
      outcome: 'failed',
      failureCode: 'incomplete_output',
      usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 },
    });
    expect(receipt).not.toHaveProperty('content');
    expect(receipt).not.toHaveProperty('reasoning');
    expect(f.docs.documents.has(`${f.base}/adapterProposals/current`)).toBe(
      false,
    );
    expect(
      await f.coordinator.run('alice', { ...f.fence, generation: 1 }),
    ).toMatchObject({
      status: 'blocked',
      code: 'adapter_operation_requires_reconciliation',
    });
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
});
