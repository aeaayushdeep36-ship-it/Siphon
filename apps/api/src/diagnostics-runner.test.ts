import { describe, expect, it, vi } from 'vitest';
import {
  DiagnosticsRunner,
  E2bDiagnosticsSession,
  DIAGNOSTICS_COMMAND,
} from './diagnostics-runner.js';
import { type ValidationSession } from './validation-runner.js';
import { type Sandbox } from 'e2b';
import { E2bClient, type SandboxControlPlane } from './e2b-client.js';
import { diagnosticsFixture } from '../test/diagnostics-fixture.js';

async function setup() {
  const f = await diagnosticsFixture();
  const session: ValidationSession = {
    sandboxId: 'fresh-diagnostics',
    writeRequest: vi.fn(async () => {}),
    writeObservation: vi.fn(async () => {}),
    run: vi.fn(async () => 0),
    readResult: async () => new Response(JSON.stringify(f.result)).body!,
  };
  const gate = {
    claim: vi.fn(async () => {}),
    authorizeResult: vi.fn(async () => {}),
  };
  return { ...f, session, gate, runner: new DiagnosticsRunner(session, gate) };
}

describe('data-only diagnostic transport (offline)', () => {
  it('claims once and sends only the bounded numeric request and declared observations', async () => {
    const f = await setup();
    expect(await f.runner.run(f.request, f.payloads)).toEqual(f.result);
    expect(f.gate.claim).toHaveBeenCalledWith(
      f.request,
      expect.stringMatching(/^[a-f0-9]{64}$/),
      'fresh-diagnostics',
    );
    expect(f.session.writeObservation).toHaveBeenCalledTimes(4);
    expect(f.session.run).toHaveBeenCalledOnce();
    expect(f.gate.authorizeResult).toHaveBeenCalledWith(f.request.operationId);
  });
  it.each(['hash', 'extra_source', 'length', 'cancelled'])(
    'rejects %s before claiming or staging',
    async (kind) => {
      const f = await setup();
      if (kind === 'hash') f.payloads[0]!.bytes[0] = 0;
      if (kind === 'extra_source')
        f.payloads.push({ filename: 'source.py', bytes: new Uint8Array() });
      if (kind === 'length') f.payloads[0]!.bytes = new Uint8Array();
      await expect(
        f.runner.run(
          f.request,
          f.payloads,
          kind === 'cancelled' ? AbortSignal.abort() : undefined,
        ),
      ).rejects.toThrow();
      expect(f.gate.claim).not.toHaveBeenCalled();
      expect(f.session.writeRequest).not.toHaveBeenCalled();
    },
  );
  it.each(['exit', 'identity', 'verdict', 'oversize', 'revoked', 'cancelled'])(
    'discards %s without accepting a diagnostic result',
    async (kind) => {
      const f = await setup();
      const controller = new AbortController();
      if (kind === 'exit') f.session.run = async () => 2;
      if (kind === 'identity') f.result.inputDigest = 'f'.repeat(64);
      if (kind === 'verdict')
        f.session.readResult = async () =>
          new Response(
            JSON.stringify({
              ...f.result,
              metrics: f.result.metrics.map((item) => ({
                ...item,
                status: 'flagged',
              })),
            }),
          ).body!;
      if (kind === 'oversize')
        f.session.readResult = async () =>
          new Response('x'.repeat(32769)).body!;
      if (kind === 'revoked')
        f.gate.authorizeResult.mockRejectedValueOnce(new Error('denied'));
      if (kind === 'cancelled')
        f.session.run = async () => {
          controller.abort();
          return 0;
        };
      await expect(
        f.runner.run(f.request, f.payloads, controller.signal),
      ).rejects.toThrow('trusted_numeric_diagnostics_failed');
    },
  );
  it('uses fixed isolated-mode paths and transfers only the exact byte view', async () => {
    const write = vi.fn<
      (path: string, body: ArrayBuffer, options: unknown) => Promise<unknown>
    >(async () => ({}));
    const run = vi.fn(async () => ({ exitCode: 0 }));
    const read = vi.fn(async () => new Response('{}').body!);
    const sandbox = {
      sandboxId: 'fixture',
      files: { write, read, makeDir: vi.fn(async () => true) },
      commands: { run },
    } as unknown as Sandbox;
    const session = new E2bDiagnosticsSession(sandbox);
    const signal = AbortSignal.timeout(1000);
    const view = new Uint8Array([10, 20, 30, 40]).subarray(1, 3);
    await session.writeRequest(view, signal);
    await session.writeObservation('times', view, signal);
    expect(new Uint8Array(write.mock.calls[0]![1] as ArrayBuffer)).toEqual(
      new Uint8Array([20, 30]),
    );
    expect(write.mock.calls[0]![0]).toBe(
      '/tmp/siphon-diagnostics-request.json',
    );
    expect(write.mock.calls[1]![0]).toBe(
      '/tmp/siphon-diagnostics-data/obs_times.npy',
    );
    await expect(
      session.writeObservation('../source.py', view, signal),
    ).rejects.toThrow();
    expect(await session.run(signal)).toBe(0);
    expect(run).toHaveBeenCalledWith(
      DIAGNOSTICS_COMMAND,
      expect.objectContaining({ retainOutput: false, envs: {}, cwd: '/tmp' }),
    );
    await session.readResult(signal);
    expect(read).toHaveBeenCalledWith(
      '/tmp/siphon-diagnostics-result.json',
      expect.objectContaining({ format: 'stream' }),
    );
  });
  it('hands off the original evaluation-role diagnostic session after durable handle recording', async () => {
    const f = await setup();
    const gate = {
      authorizeCreate: vi.fn(async () => {}),
      recordCreated: vi.fn(async () => {}),
      authorizeKill: vi.fn(async () => {}),
      recordTermination: vi.fn(async () => {}),
    };
    const provider: SandboxControlPlane = {
      create: vi.fn(async () => ({
        sandboxId: f.session.sandboxId,
        diagnosticsSession: f.session,
      })),
      kill: vi.fn(async () => true),
    };
    const client = new E2bClient('authored-secret', gate, provider);
    const request = {
      operationId: f.request.operationId,
      auditId: f.request.auditId,
      revisionId: f.request.revisionId,
      inputDigest: f.request.validation.inputDigest,
      role: 'evaluation' as const,
      templateId: 'fixture',
      templateEvidenceId: crypto.randomUUID(),
      lifetimeSeconds: 60,
    };
    expect((await client.createDiagnostics(request)).session).toBe(f.session);
    expect(gate.recordCreated).toHaveBeenCalledWith(
      request.operationId,
      f.session.sandboxId,
    );
    await expect(
      client.createDiagnostics({ ...request, role: 'source' }),
    ).rejects.toThrow('Evaluation');
    provider.create = async () => ({ sandboxId: 'missing-session' });
    await expect(client.createDiagnostics(request)).rejects.toMatchObject({
      code: 'handle_unrecorded',
      sandboxId: 'missing-session',
    });
  });
});
