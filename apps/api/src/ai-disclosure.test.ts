import { describe, expect, it } from 'vitest';
import {
  groqFixtureConfig,
  groqContextFixture,
} from '../test/groq-stage-fixture.js';
import {
  AiDisclosureConsents,
  aiDisclosureDigest,
  aiDisclosureOptions,
  readAiDisclosureSnapshot,
} from './ai-disclosure.js';
import { WorkspaceRepository } from './workspace.js';

describe('explicit AI disclosure consent', () => {
  it('requires an explicit current configuration and input-bound decision', async () => {
    const f = await groqContextFixture();
    f.docs.documents.delete(`${f.base}/aiDisclosure/current`);
    const config = aiDisclosureOptions(groqFixtureConfig);
    const initial = await f.docs.transaction((tx) =>
      readAiDisclosureSnapshot(
        tx,
        'alice',
        f.fence.auditId,
        f.fence.revisionId,
        f.fence.inputDigest,
        config,
      ),
    );
    expect(initial).toMatchObject({ status: 'required', acceptedAt: null });

    const service = new AiDisclosureConsents(f.docs, config, f.clock);
    const body = {
      schemaVersion: '1.0',
      expectedGeneration: f.fence.generation,
      expectedInputDigest: f.fence.inputDigest,
      disclosureDigest: await aiDisclosureDigest(config),
      decision: 'accept',
    } as const;
    const accepted = await service.submit(
      'alice',
      f.fence.auditId,
      f.fence.revisionId,
      body,
      'owner-accept',
    );
    expect(accepted).toMatchObject({ decision: 'accept', replayed: false });
    const snapshot = await f.docs.transaction((tx) =>
      readAiDisclosureSnapshot(
        tx,
        'alice',
        f.fence.auditId,
        f.fence.revisionId,
        f.fence.inputDigest,
        config,
      ),
    );
    expect(snapshot).toMatchObject({
      status: 'accepted',
      acceptedAt: f.clock().toISOString(),
    });
    const workspace = await new WorkspaceRepository(
      f.docs,
      f.clock,
      config,
    ).get('alice', f.fence.auditId, f.fence.revisionId);
    expect(workspace.aiDisclosure).toMatchObject({
      status: 'accepted',
      disclosureDigest: body.disclosureDigest,
      configuration: {
        provider: 'groq',
        model: groqFixtureConfig.model,
        endpoint: groqFixtureConfig.endpoint,
        scopes: ['source_context', 'source_adapter', 'numeric_investigation'],
      },
    });
    await expect(
      service.submit(
        'alice',
        f.fence.auditId,
        f.fence.revisionId,
        body,
        'owner-accept',
      ),
    ).resolves.toMatchObject({ decision: 'accept', replayed: true });
  });

  it('revokes future dispatch authorization and requires acceptance after input or model changes', async () => {
    const f = await groqContextFixture();
    const config = aiDisclosureOptions(groqFixtureConfig);
    const service = new AiDisclosureConsents(f.docs, config, f.clock);
    const body = {
      schemaVersion: '1.0',
      expectedGeneration: f.fence.generation,
      expectedInputDigest: f.fence.inputDigest,
      disclosureDigest: await aiDisclosureDigest(config),
      decision: 'revoke',
    };
    await service.submit(
      'alice',
      f.fence.auditId,
      f.fence.revisionId,
      body,
      'owner-revoke',
    );
    const revoked = await f.docs.transaction((tx) =>
      readAiDisclosureSnapshot(
        tx,
        'alice',
        f.fence.auditId,
        f.fence.revisionId,
        f.fence.inputDigest,
        config,
      ),
    );
    expect(revoked?.status).toBe('revoked');
    expect(revoked?.acceptedAt).not.toBeNull();

    const changedModel = aiDisclosureOptions({
      ...groqFixtureConfig,
      model: 'authored/changed-model',
    });
    const configChanged = await f.docs.transaction((tx) =>
      readAiDisclosureSnapshot(
        tx,
        'alice',
        f.fence.auditId,
        f.fence.revisionId,
        f.fence.inputDigest,
        changedModel,
      ),
    );
    expect(configChanged).toMatchObject({
      status: 'required',
      acceptedAt: null,
    });
    const changedInput = await f.docs.transaction((tx) =>
      readAiDisclosureSnapshot(
        tx,
        'alice',
        f.fence.auditId,
        f.fence.revisionId,
        'c'.repeat(64),
        config,
      ),
    );
    expect(changedInput).toMatchObject({
      status: 'required',
      acceptedAt: null,
    });
  });

  it('rejects stale disclosure digests and changed revision fences', async () => {
    const f = await groqContextFixture();
    const config = aiDisclosureOptions(groqFixtureConfig);
    const service = new AiDisclosureConsents(f.docs, config, f.clock);
    const body = {
      schemaVersion: '1.0',
      expectedGeneration: f.fence.generation,
      expectedInputDigest: f.fence.inputDigest,
      disclosureDigest: 'd'.repeat(64),
      decision: 'accept',
    };
    await expect(
      service.submit(
        'alice',
        f.fence.auditId,
        f.fence.revisionId,
        body,
        'stale',
      ),
    ).rejects.toMatchObject({ code: 'ai_disclosure_changed' });
    await expect(
      service.submit(
        'alice',
        f.fence.auditId,
        f.fence.revisionId,
        {
          ...body,
          disclosureDigest: await aiDisclosureDigest(config),
          expectedGeneration: 9,
        },
        'stale-fence',
      ),
    ).rejects.toMatchObject({ code: 'stale_revision' });
  });
});
