import { describe, expect, it, vi } from 'vitest';
import {
  E2bClient,
  type SandboxControlPlane,
  type SandboxRequest,
} from './e2b-client.js';
import { sha256 } from './hashing.js';
const request: SandboxRequest = {
  operationId: crypto.randomUUID(),
  auditId: crypto.randomUUID(),
  revisionId: crypto.randomUUID(),
  inputDigest: 'a'.repeat(64),
  role: 'source',
  templateId: 'approved-template',
  templateEvidenceId: crypto.randomUUID(),
  lifetimeSeconds: 60,
};
const templateVerification = (buildId: string) => ({
  buildId,
  tagBuildId: buildId,
  buildCount: 1,
  isPrivate: true,
});
function setup() {
  const gate = {
    authorizeCreate: vi.fn(async () => {}),
    recordCreated: vi.fn(async () => {}),
    authorizeKill: vi.fn(async () => {}),
    recordTermination: vi.fn(async () => {}),
  };
  const provider = {
    verifyTemplate: vi.fn<NonNullable<SandboxControlPlane['verifyTemplate']>>(
      async () => null,
    ),
    create: vi.fn(async () => ({ sandboxId: 'sandbox-123' })),
    kill: vi.fn(async () => true),
  };
  return {
    gate,
    provider,
    client: new E2bClient('test-secret', gate, provider),
  };
}
describe('E2B control-plane boundary (offline)', () => {
  it('reports known termination with an unrecorded journal as a distinct recoverable failure', async () => {
    const f = setup();
    f.gate.recordTermination.mockRejectedValueOnce(new Error('commit_unknown'));
    await expect(
      f.client.kill(request.operationId, 'sandbox-123'),
    ).rejects.toMatchObject({
      code: 'termination_unrecorded',
      sandboxId: 'sandbox-123',
    });
    expect(f.provider.kill).toHaveBeenCalledTimes(1);
    expect(f.gate.recordTermination).toHaveBeenCalledWith(
      request.operationId,
      'sandbox-123',
      'killed',
    );
  });
  it('sets explicit isolation/lifecycle/retry limits and journals the handle', async () => {
    const f = setup();
    expect(await f.client.create(request)).toEqual({
      sandboxId: 'sandbox-123',
    });
    expect(f.provider.create).toHaveBeenCalledWith(
      'approved-template',
      expect.objectContaining({
        retries: 0,
        idempotencyKey: await sha256(`siphon-sandbox:${request.operationId}`),
        requestTimeoutMs: 30000,
        timeoutMs: 60000,
        allowInternetAccess: false,
        network: { allowPublicTraffic: false },
        lifecycle: { onTimeout: 'kill', autoResume: false },
        envs: {},
        metadata: {
          siphonOperationId: request.operationId,
          siphonRole: 'source',
        },
      }),
    );
    expect(f.gate.recordCreated).toHaveBeenCalledWith(
      request.operationId,
      'sandbox-123',
    );
    expect(f.gate.authorizeCreate.mock.invocationCallOrder[0]).toBeLessThan(
      f.provider.create.mock.invocationCallOrder[0]!,
    );
  });
  it('checks a build-specific E2B tag before admission and launches by that tag', async () => {
    const f = setup();
    f.provider.verifyTemplate = vi.fn(async () =>
      templateVerification('build-123'),
    );
    await f.client.create({
      ...request,
      templateBuildId: 'build-123',
      templateTag: 'siphon-build123',
    });
    expect(f.provider.verifyTemplate).toHaveBeenCalledWith(
      'test-secret',
      'approved-template',
      'siphon-build123',
      expect.any(AbortSignal),
      'https://api.e2b.app/',
    );
    expect(f.provider.verifyTemplate.mock.invocationCallOrder[0]).toBeLessThan(
      f.gate.authorizeCreate.mock.invocationCallOrder[0]!,
    );
    expect(f.provider.create).toHaveBeenCalledWith(
      'approved-template:siphon-build123',
      expect.any(Object),
    );
  });
  it('uses a configured HTTPS provider endpoint and rejects insecure endpoints', async () => {
    const f = setup();
    const client = new E2bClient(
      'test-secret',
      f.gate,
      f.provider,
      'https://e2b.example.test/api',
    );
    await client.create(request);
    expect(f.provider.create).toHaveBeenCalledWith(
      'approved-template',
      expect.objectContaining({ apiUrl: 'https://e2b.example.test/api' }),
    );
    expect(
      () => new E2bClient('test-secret', f.gate, f.provider, 'http://e2b.test'),
    ).toThrow('E2B API endpoint must be a clean HTTPS URL');
  });
  it('fails closed when a build tag no longer resolves to the recorded build', async () => {
    const f = setup();
    f.provider.verifyTemplate = vi.fn(async () =>
      templateVerification('different-build'),
    );
    await expect(
      f.client.create({
        ...request,
        templateBuildId: 'build-123',
        templateTag: 'siphon-build123',
      }),
    ).rejects.toThrow('Pinned E2B template build mismatch');
    expect(f.gate.authorizeCreate).not.toHaveBeenCalled();
    expect(f.provider.create).not.toHaveBeenCalled();
  });
  it.each([
    ['a template with multiple builds', { buildCount: 2 }],
    ['a public template', { isPrivate: false }],
    ['a tag pointing at another build', { tagBuildId: 'other-build' }],
  ])('fails closed for %s before admission', async (_label, change) => {
    const f = setup();
    f.provider.verifyTemplate = vi.fn(async () => ({
      ...templateVerification('build-123'),
      ...change,
    }));
    await expect(
      f.client.create({
        ...request,
        templateBuildId: 'build-123',
        templateTag: 'siphon-build123',
      }),
    ).rejects.toThrow('Pinned E2B template build mismatch');
    expect(f.gate.authorizeCreate).not.toHaveBeenCalled();
    expect(f.provider.create).not.toHaveBeenCalled();
  });
  it.each(['changed', 'unavailable'])(
    'does not expose a session when post-creation template verification is %s',
    async (outcome) => {
      const f = setup();
      f.provider.verifyTemplate.mockResolvedValueOnce(
        templateVerification('build-123'),
      );
      if (outcome === 'changed')
        f.provider.verifyTemplate.mockResolvedValueOnce(
          templateVerification('other'),
        );
      else
        f.provider.verifyTemplate.mockRejectedValueOnce(
          new Error('provider error'),
        );
      await expect(
        f.client.create({
          ...request,
          templateBuildId: 'build-123',
          templateTag: 'siphon-build123',
        }),
      ).rejects.toMatchObject({
        code: 'template_verification_failed',
        sandboxId: 'sandbox-123',
      });
      expect(f.gate.recordCreated).toHaveBeenCalledWith(
        request.operationId,
        'sandbox-123',
      );
      expect(f.provider.create).toHaveBeenCalledTimes(1);
    },
  );
  it('preserves the sandbox handle if cancelled after creation', async () => {
    const f = setup();
    const controller = new AbortController();
    f.provider.verifyTemplate.mockResolvedValue(
      templateVerification('build-123'),
    );
    f.gate.recordCreated.mockImplementation(async () => controller.abort());
    await expect(
      f.client.create(
        {
          ...request,
          templateBuildId: 'build-123',
          templateTag: 'siphon-build123',
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({
      code: 'template_verification_failed',
      sandboxId: 'sandbox-123',
    });
    expect(f.provider.verifyTemplate).toHaveBeenCalledTimes(1);
  });
  it('does not contact provider after admission denial, cancellation or invalid lifetime', async () => {
    const f = setup();
    f.gate.authorizeCreate.mockRejectedValueOnce(new Error('budget_exhausted'));
    await expect(f.client.create(request)).rejects.toThrow('budget_exhausted');
    await expect(
      f.client.create(request, AbortSignal.abort()),
    ).rejects.toThrow();
    await expect(
      f.client.create({ ...request, lifetimeSeconds: 181 }),
    ).rejects.toThrow();
    expect(f.provider.create).not.toHaveBeenCalled();
  });
  it('uses stable provider keys scoped to each durable sandbox operation', async () => {
    const f = setup();
    await f.client.create(request);
    await f.client.create(request);
    await f.client.create({ ...request, operationId: crypto.randomUUID() });
    const calls = f.provider.create.mock.calls as unknown as Array<
      [string, { idempotencyKey?: string }]
    >;
    const keys = calls.map((call) => call[1].idempotencyKey);
    expect(keys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });
  it('does not retry or expose provider errors after ambiguous creation', async () => {
    const f = setup();
    f.provider.create.mockRejectedValue(
      new Error('secret-bearing provider response'),
    );
    await expect(f.client.create(request)).rejects.toMatchObject({
      code: 'create_unknown',
      message: 'create_unknown',
      sandboxId: null,
    });
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    expect(f.gate.recordCreated).not.toHaveBeenCalled();
  });
  it('preserves a known handle for reconciliation when journal persistence fails', async () => {
    const f = setup();
    f.gate.recordCreated.mockRejectedValue(new Error('commit_unknown'));
    await expect(f.client.create(request)).rejects.toMatchObject({
      code: 'handle_unrecorded',
      sandboxId: 'sandbox-123',
    });
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    expect(f.gate.recordCreated).toHaveBeenCalledTimes(2);
  });
  it('retries only the idempotent handle journal after an ambiguous commit', async () => {
    const f = setup();
    f.gate.recordCreated.mockRejectedValueOnce(new Error('commit_unknown'));
    await expect(f.client.create(request)).resolves.toEqual({
      sandboxId: 'sandbox-123',
    });
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    expect(f.gate.recordCreated).toHaveBeenCalledTimes(2);
  });
  it('authorizes kill and distinguishes not-found from uncertain termination', async () => {
    const f = setup();
    expect(await f.client.kill(request.operationId, 'sandbox-123')).toBe(
      'killed',
    );
    f.provider.kill.mockResolvedValueOnce(false);
    expect(await f.client.kill(request.operationId, 'sandbox-123')).toBe(
      'not_found',
    );
    f.provider.kill.mockRejectedValueOnce(new Error('timeout'));
    await expect(
      f.client.kill(request.operationId, 'sandbox-123'),
    ).rejects.toMatchObject({ code: 'kill_unknown' });
    f.gate.authorizeKill.mockRejectedValueOnce(new Error('wrong_handle'));
    await expect(
      f.client.kill(request.operationId, 'sandbox-123'),
    ).rejects.toThrow('wrong_handle');
    expect(f.provider.kill).toHaveBeenCalledTimes(3);
  });
});
