import { describe, expect, it, vi } from 'vitest';
import { InspectionPipeline } from './inspection-pipeline.js';
import { SandboxControlFailure, type SandboxRequest } from './e2b-client.js';
import { type InspectionSession } from './inspection-runner.js';

function setup() {
  const request: SandboxRequest = {
    operationId: crypto.randomUUID(),
    auditId: crypto.randomUUID(),
    revisionId: crypto.randomUUID(),
    inputDigest: 'a'.repeat(64),
    role: 'inspection',
    templateId: 'fixture',
    templateEvidenceId: crypto.randomUUID(),
    lifetimeSeconds: 60,
  };
  const sourceDigest =
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const artifactId = crypto.randomUUID();
  const payload = {
    schemaVersion: '1.0' as const,
    operationId: request.operationId,
    inputDigest: request.inputDigest,
    maximumSourceBytes: 131072,
    sources: [{ artifactId, sourceDigest, sourceBase64: '' }],
  };
  const result = {
    schemaVersion: '1.0',
    operationId: request.operationId,
    inputDigest: request.inputDigest,
    sources: [
      {
        artifactId,
        inspection: {
          schemaVersion: '1.0',
          sourceDigest,
          parsed: true,
          truncated: false,
          dependencies: [],
          definitions: [],
          findings: [],
        },
      },
    ],
  };
  const session: InspectionSession = {
    sandboxId: 'fixture-sandbox',
    writeRequest: async () => {},
    run: async () => 0,
    readResult: async () => new Response(JSON.stringify(result)).body!,
  };
  const sources = { load: vi.fn(async () => payload) };
  const sandboxes = {
    createInspection: vi.fn(async () => ({
      sandboxId: session.sandboxId,
      session,
    })),
    connectInspection: vi.fn(async () => session),
    kill: vi.fn(async () => 'killed' as const),
  };
  const jobs = {
    claim: vi.fn(async () => {}),
    authorizeResult: vi.fn(async () => {}),
    publish: vi.fn(async () => ({
      resultDigest: 'b'.repeat(64),
      replayed: false,
    })),
  };
  const pipeline = new InspectionPipeline(sources, sandboxes, jobs);
  const run = (signal?: AbortSignal) =>
    pipeline.run(
      'alice',
      request,
      {
        auditId: request.auditId,
        revisionId: request.revisionId,
        generation: 0,
        inputDigest: request.inputDigest,
      },
      signal,
    );
  return { request, sources, sandboxes, jobs, session, pipeline, run };
}
describe('internal inspection stage orchestration (offline)', () => {
  it('creates in one phase and reconnects from the journaled handle in the next', async () => {
    const f = setup();
    const fence = {
      auditId: f.request.auditId,
      revisionId: f.request.revisionId,
      generation: 0,
      inputDigest: f.request.inputDigest,
    };
    const created = await f.pipeline.createSandbox(f.request, fence);
    expect(created).toMatchObject({
      status: 'created',
      operationId: f.request.operationId,
      sandboxId: f.session.sandboxId,
    });
    const execution = await f.pipeline.executeConnected(
      'alice',
      f.request,
      fence,
      f.session.sandboxId,
    );
    expect(execution).toMatchObject({
      status: 'published',
      operationId: f.request.operationId,
      sandboxId: f.session.sandboxId,
    });
    expect(f.sources.load.mock.invocationCallOrder[0]).toBeLessThan(
      f.sandboxes.connectInspection.mock.invocationCallOrder[0]!,
    );
    expect(f.jobs.publish.mock.invocationCallOrder[0]).toBeGreaterThan(
      f.sandboxes.connectInspection.mock.invocationCallOrder[0]!,
    );
  });
  it('loads, inspects and publishes before terminating the same fresh session', async () => {
    const f = setup();
    expect(await f.run()).toMatchObject({
      cleanup: 'confirmed',
      replayed: false,
    });
    expect(f.sources.load.mock.invocationCallOrder[0]).toBeLessThan(
      f.sandboxes.createInspection.mock.invocationCallOrder[0]!,
    );
    expect(f.jobs.publish.mock.invocationCallOrder[0]).toBeLessThan(
      f.sandboxes.kill.mock.invocationCallOrder[0]!,
    );
  });
  it('does not create a sandbox when private source loading fails', async () => {
    const f = setup();
    f.sources.load.mockRejectedValueOnce(new Error('source corrupted'));
    await expect(f.run()).rejects.toThrow('source corrupted');
    expect(f.sandboxes.createInspection).not.toHaveBeenCalled();
  });
  it('reports pending termination after successful evidence publication when kill is uncertain', async () => {
    const f = setup();
    f.sandboxes.kill.mockRejectedValueOnce(new Error('kill_unknown'));
    expect(await f.run()).toMatchObject({ cleanup: 'pending' });
    expect(f.jobs.publish).toHaveBeenCalledOnce();
  });
  it('attempts termination with a fresh signal even if cancellation aborts inspection', async () => {
    const f = setup();
    const controller = new AbortController();
    f.session.run = async () => {
      controller.abort();
      throw new Error('interrupted');
    };
    await expect(f.run(controller.signal)).rejects.toThrow(
      'inspection_execution_failed',
    );
    expect(f.jobs.publish).not.toHaveBeenCalled();
    expect(f.sandboxes.kill).toHaveBeenCalledWith(
      f.request.operationId,
      'fixture-sandbox',
      expect.any(AbortSignal),
    );
  });
  it('attempts cleanup for a known create handle when session handoff fails', async () => {
    const f = setup();
    f.sandboxes.createInspection.mockRejectedValueOnce(
      new SandboxControlFailure('handle_unrecorded', 'known-sandbox'),
    );
    await expect(f.run()).rejects.toMatchObject({ code: 'handle_unrecorded' });
    expect(f.sandboxes.kill).toHaveBeenCalledWith(
      f.request.operationId,
      'known-sandbox',
      expect.any(AbortSignal),
    );
  });
  it('terminates a sandbox if template verification fails after creation', async () => {
    const f = setup();
    f.sandboxes.createInspection.mockRejectedValueOnce(
      new SandboxControlFailure(
        'template_verification_failed',
        'known-sandbox',
      ),
    );
    await expect(f.run()).rejects.toMatchObject({
      code: 'template_verification_failed',
    });
    expect(f.jobs.publish).not.toHaveBeenCalled();
    expect(f.sandboxes.kill).toHaveBeenCalledWith(
      f.request.operationId,
      'known-sandbox',
      expect.any(AbortSignal),
    );
  });
});
