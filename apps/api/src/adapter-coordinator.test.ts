import { describe, expect, it } from 'vitest';
import { AdapterTasks } from './adapter-tasks.js';
import { AdapterPipeline } from './adapter-pipeline.js';
import { metaResponse } from '../test/meta-response.js';
import { adapterStageFixture as fixture } from '../test/adapter-stage-fixture.js';
import { WorkspaceRepository } from './workspace.js';
import { canonicalJson, sha256 } from './hashing.js';

describe('connected source-bound adapter proposal stage', () => {
  it('uses one exact count/model request, actual reservations/settlement and immutable publication; proposal stays unverified', async () => {
    const f = await fixture(),
      result = await f.coordinator.run('alice', f.fence);
    expect(result.status).toBe('proposal_ready');
    if (result.status !== 'proposal_ready')
      throw new Error('Authored stage failed');
    expect(result.proposal).toEqual(f.adapter);
    expect(result.fence.generation).toBe(1);
    expect(f.transport).toHaveBeenCalledTimes(2);
    expect(f.transport.mock.calls[0]![1]?.body).toBe(
      f.transport.mock.calls[1]![1]?.body,
    );
    expect(
      f.docs.documents.get(`${f.base}/adapterProposals/current`),
    ).toMatchObject({
      status: 'proposed',
      adapterDigest: result.adapterDigest,
    });
    expect(f.docs.documents.has(`${f.base}/adapters/current`)).toBe(false);
    const workspace = await new WorkspaceRepository(f.docs).get(
      'alice',
      f.audit.id,
      f.fence.revisionId,
    );
    expect(workspace.adapterQuestions?.questions).toHaveLength(
      f.adapter.mappings.length,
    );
    const review = {
      schemaVersion: '1.0',
      expectedGeneration: result.fence.generation,
      expectedInputDigest: result.fence.inputDigest,
      adapterDigest: result.adapterDigest,
      questionSetDigest: await sha256(
        canonicalJson(workspace.adapterQuestions),
      ),
      answers: workspace.adapterQuestions!.questions.map((question) => ({
        schemaVersion: '1.0',
        questionId: question.id,
        selectedOptionId: 'confirm',
        customText: '',
      })),
    };
    const repository = new WorkspaceRepository(f.docs);
    expect(
      await repository.submitAdapterReview(
        'alice',
        f.audit.id,
        f.fence.revisionId,
        review,
      ),
    ).toMatchObject({ allDeclaredConfirmed: true, replayed: false });
    expect(
      await repository.submitAdapterReview(
        'alice',
        f.audit.id,
        f.fence.revisionId,
        review,
      ),
    ).toMatchObject({ replayed: true });
    await expect(
      repository.submitAdapterReview(
        'bob',
        f.audit.id,
        f.fence.revisionId,
        review,
      ),
    ).rejects.toThrow();
    expect(f.docs.documents.has(`${f.base}/adapters/current`)).toBe(false);
    f.docs.documents.get(
      `${f.base}/adapterQuestions/current`,
    )!.questionSetDigest = 'a'.repeat(64);
    await expect(
      new WorkspaceRepository(f.docs).get(
        'alice',
        f.audit.id,
        f.fence.revisionId,
      ),
    ).rejects.toThrow('question display integrity');
    f.docs.documents.get(
      `${f.base}/adapterQuestions/current`,
    )!.questionSetDigest = await sha256(
      canonicalJson(workspace.adapterQuestions),
    );
    expect(
      f.docs.documents.get(`operations/${result.operationId}`),
    ).toMatchObject({ outcome: 'succeeded' });
    expect(
      f.docs.documents.get(`budgets/model_attempts_${f.fence.revisionId}`),
    ).toMatchObject({ spent: 1, reserved: 0 });
    expect(await f.coordinator.run('alice', result.fence)).toMatchObject({
      status: 'proposal_ready',
      adapterDigest: result.adapterDigest,
    });
    expect(f.transport).toHaveBeenCalledTimes(2);
    await expect(
      new AdapterPipeline(f.docs, 'authored', f.transport, f.clock).run(
        result.operationId,
        JSON.parse(String(f.transport.mock.calls[1]![1]?.body)),
      ),
    ).rejects.toThrow();
    expect(f.transport).toHaveBeenCalledTimes(2);
  });
  it('refuses unresolved declarations, altered context provenance and foreign callers before source/model I/O', async () => {
    for (const mode of ['answers', 'context', 'foreign']) {
      const f = await fixture();
      if (mode === 'answers')
        f.docs.documents.get(
          `${f.base}/contextAnswerResolution/current`,
        )!.allUserDeclarationsResolved = false;
      if (mode === 'context')
        f.docs.documents.get(`operations/${f.contextOperationId}`)!.outcome =
          'unknown';
      await expect(
        f.coordinator.run(mode === 'foreign' ? 'bob' : 'alice', f.fence),
      ).rejects.toThrow();
      expect(f.readBatch).not.toHaveBeenCalled();
      expect(f.transport).not.toHaveBeenCalled();
    }
  });
  it('settles unusable model output once and keeps the stage blocked instead of fabricating an adapter', async () => {
    const f = await fixture();
    f.transport.mockImplementation(async (url) =>
      String(url).endsWith('/input_tokens')
        ? Response.json({ object: 'response.input_tokens', input_tokens: 1000 })
        : Response.json(
            metaResponse('{"code":"invented simulation"}', {
              prompt_tokens: 1000,
              completion_tokens: 50,
              total_tokens: 1050,
            }),
          ),
    );
    await expect(f.coordinator.run('alice', f.fence)).rejects.toThrow();
    const stage = f.docs.documents.get(`adapterStages/${f.fence.revisionId}`)!;
    expect(
      f.docs.documents.get(`operations/${stage.operationId}`),
    ).toMatchObject({ outcome: 'failed' });
    expect(f.docs.documents.has(`${f.base}/adapterProposals/current`)).toBe(
      false,
    );
    expect(
      await f.coordinator.run('alice', { ...f.fence, generation: 1 }),
    ).toMatchObject({
      status: 'blocked',
      code: 'adapter_operation_requires_reconciliation',
    });
    expect(f.transport).toHaveBeenCalledTimes(2);
  });
  it('binds a proposal to actual source bytes and excludes context-only dispatch at the adapter stage', async () => {
    const f = await fixture();
    await f.coordinator.run('alice', f.fence);
    f.source.text += 'changed';
    await expect(
      new AdapterTasks(f.docs, f.clock).prepare(
        'alice',
        { ...f.fence, generation: 1 },
        [f.source],
      ),
    ).rejects.toThrow('digest');
  });
});
