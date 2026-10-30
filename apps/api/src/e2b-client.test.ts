import { describe, expect, it, vi } from 'vitest';
import { E2bClient, type SandboxRequest } from './e2b-client.js';
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
function setup() {
  const gate = {
    authorizeCreate: vi.fn(async () => {}),
    recordCreated: vi.fn(async () => {}),
    authorizeKill: vi.fn(async () => {}),
    recordTermination: vi.fn(async () => {}),
  };
  const provider = {
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
    f.gate.recordCreated.mockRejectedValueOnce(new Error('commit_unknown'));
    await expect(f.client.create(request)).rejects.toMatchObject({
      code: 'handle_unrecorded',
      sandboxId: 'sandbox-123',
    });
    expect(f.provider.create).toHaveBeenCalledTimes(1);
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
