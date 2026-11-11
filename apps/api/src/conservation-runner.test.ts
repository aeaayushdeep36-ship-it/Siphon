import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ConservationJobRequest,
  validateConservationJobResult,
} from '@siphon/contracts';
import {
  ConservationRunner,
  E2bConservationSession,
  CONSERVATION_COMMAND,
} from './conservation-runner.js';
import type { Sandbox } from 'e2b';
import type { ValidationSession } from './validation-runner.js';

const python =
  process.env.SIPHON_PYTHON ??
  resolve('.tools/science-venv/Scripts/python.exe');
const environment = {
  ...process.env,
  PYTHONPATH: [
    resolve('packages/science'),
    resolve('packages/science/tests'),
  ].join(process.platform === 'win32' ? ';' : ':'),
};
function authoredPython(code: string, input?: string) {
  const result = spawnSync(python, ['-c', code], {
    env: environment,
    input,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1048576,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Authored scientific fixture execution failed: ${result.stderr}`,
    );
  return JSON.parse(result.stdout) as unknown;
}

function fixture(faulty = false) {
  // Every source/array is authored test data; this is never a local uploaded-code path.
  const raw = authoredPython(
    `import json,base64; from test_scientific_checks import heat_case; request,payloads=heat_case(faulty=${faulty ? 'True' : 'False'}); print(json.dumps({'request':request,'payloads':{k:base64.b64encode(v).decode() for k,v in payloads.items()}}))`,
  ) as { request: unknown; payloads: Record<string, string> };
  const request = ConservationJobRequest.parse(raw.request);
  const payloads = Object.entries(raw.payloads).map(([filename, bytes]) => ({
    filename,
    bytes: new Uint8Array(Buffer.from(bytes, 'base64')),
  }));
  let staged: unknown;
  const files: Record<string, string> = {};
  let result: unknown;
  const session: ValidationSession = {
    sandboxId: 'authored-data-only-evaluator',
    writeRequest: vi.fn(async (bytes) => {
      staged = JSON.parse(new TextDecoder().decode(bytes));
    }),
    writeObservation: vi.fn(async (key, bytes) => {
      files[`obs_${key}.npy`] = Buffer.from(bytes).toString('base64');
    }),
    run: vi.fn(async () => {
      result = authoredPython(
        "import sys,json,base64; from siphon_science.experiments import evaluate_conservation_job; x=json.load(sys.stdin); print(json.dumps(evaluate_conservation_job(x['request'],{k:base64.b64decode(v) for k,v in x['payloads'].items()})))",
        JSON.stringify({ request: staged, payloads: files }),
      );
      return 0;
    }),
    readResult: async () => new Response(JSON.stringify(result)).body!,
  };
  const gate = {
    claim: vi.fn(async () => {}),
    authorizeResult: vi.fn(async () => {}),
  };
  return {
    request,
    payloads,
    session,
    gate,
    runner: new ConservationRunner(session, gate),
  };
}

describe('conservation transport and actual authored scientific callable', () => {
  it.each([false, true])(
    'measures real NPY heat evidence through Python (faulty=%s)',
    async (faulty) => {
      const f = fixture(faulty);
      const result = await f.runner.run(f.request, f.payloads);
      expect(validateConservationJobResult(result, f.request)).toEqual(result);
      expect(result.evidence[0]?.status).toBe(
        faulty ? 'flagged' : 'passed_within_tolerance',
      );
      expect(f.gate.claim).toHaveBeenCalledOnce();
      expect(f.session.writeObservation).toHaveBeenCalledTimes(3);
    },
  );
  it('rejects corrupted bytes and undeclared source before claiming any VM', async () => {
    const f = fixture();
    f.payloads[0]!.bytes[0] = f.payloads[0]!.bytes[0]! ^ 1;
    await expect(f.runner.run(f.request, f.payloads)).rejects.toThrow('hash');
    expect(f.gate.claim).not.toHaveBeenCalled();
    const g = fixture();
    g.payloads.push({ filename: 'uploaded.py', bytes: new Uint8Array() });
    await expect(g.runner.run(g.request, g.payloads)).rejects.toThrow(
      'input set',
    );
    expect(g.session.writeRequest).not.toHaveBeenCalled();
  });
  it('fences revoked or cancelled work before staging observations', async () => {
    const f = fixture();
    f.gate.authorizeResult.mockRejectedValueOnce(new Error('revoked'));
    await expect(f.runner.run(f.request, f.payloads)).rejects.toThrow(
      'trusted_numeric_conservation_failed',
    );
    expect(f.session.writeRequest).not.toHaveBeenCalled();
    const g = fixture();
    await expect(
      g.runner.run(g.request, g.payloads, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(g.gate.claim).not.toHaveBeenCalled();
  });
  it('writes only fixed paths and runs only the bundled isolated-mode evaluator', async () => {
    const write = vi.fn<
      (...args: [string, ArrayBuffer, unknown]) => Promise<void>
    >(async () => {});
    const run = vi.fn(async () => ({ exitCode: 0 }));
    const read = vi.fn(async () => new Response('{}').body!);
    const session = new E2bConservationSession({
      sandboxId: 'fresh',
      files: { write, read, makeDir: vi.fn(async () => true) },
      commands: { run },
    } as unknown as Sandbox);
    const signal = AbortSignal.timeout(1000),
      view = new Uint8Array([1, 2, 3, 4]).subarray(1, 3);
    await session.writeRequest(view, signal);
    await session.writeObservation('times', view, signal);
    expect(write.mock.calls[0]![0]).toBe('/tmp/siphon-experiment-request.json');
    expect(new Uint8Array(write.mock.calls[0]![1])).toEqual(
      new Uint8Array([2, 3]),
    );
    expect(write.mock.calls[1]![0]).toBe(
      '/tmp/siphon-experiment-data/obs_times.npy',
    );
    await expect(
      session.writeObservation('../source.py', view, signal),
    ).rejects.toThrow();
    await session.run(signal);
    expect(run).toHaveBeenCalledWith(
      CONSERVATION_COMMAND,
      expect.objectContaining({ retainOutput: false, envs: {}, cwd: '/tmp' }),
    );
    await session.readResult(signal);
    expect(read).toHaveBeenCalledWith(
      '/tmp/siphon-experiment-result.json',
      expect.objectContaining({ format: 'stream' }),
    );
  });
});
