import { type Sandbox } from 'e2b';
import {
  DiagnosticJobRequest,
  ObservationKey,
  validateDiagnosticJobResult,
} from '@siphon/contracts';
import { canonicalJson, sha256 } from './hashing.js';
import { readJsonBounded } from './http.js';
import { type ValidationSession } from './validation-runner.js';

export const DIAGNOSTICS_COMMAND =
  '/opt/siphon/venv/bin/python -I -m siphon_science.diagnostics_job < /tmp/siphon-diagnostics-request.json > /dev/null 2>&1';

/** Separate launcher paths; this session can never run an uploaded module. */
export class E2bDiagnosticsSession implements ValidationSession {
  constructor(private readonly sandbox: Sandbox) {}
  get sandboxId() {
    return this.sandbox.sandboxId;
  }
  async writeRequest(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
    await this.sandbox.files.write(
      '/tmp/siphon-diagnostics-request.json',
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      { signal, requestTimeoutMs: 30000 },
    );
  }
  async writeObservation(
    value: string,
    bytes: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ) {
    const key = ObservationKey.parse(value);
    await this.sandbox.files.makeDir('/tmp/siphon-diagnostics-data', {
      signal,
      requestTimeoutMs: 30000,
    });
    await this.sandbox.files.write(
      `/tmp/siphon-diagnostics-data/obs_${key}.npy`,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      { signal, requestTimeoutMs: 30000 },
    );
  }
  async run(signal: AbortSignal) {
    const result = await this.sandbox.commands.run(DIAGNOSTICS_COMMAND, {
      signal,
      requestTimeoutMs: 30000,
      timeoutMs: 60000,
      retainOutput: false,
      cwd: '/tmp',
      envs: {},
    });
    return result.exitCode;
  }
  readResult(signal: AbortSignal) {
    return this.sandbox.files.read('/tmp/siphon-diagnostics-result.json', {
      format: 'stream',
      signal,
      requestTimeoutMs: 30000,
    });
  }
}

export interface DiagnosticsExecutionGate {
  claim(
    request: unknown,
    payloadDigest: string,
    sandboxId: string,
  ): Promise<void>;
  authorizeResult(operationId: string): Promise<void>;
}

export class DiagnosticsRunner {
  constructor(
    private readonly session: ValidationSession,
    private readonly gate: DiagnosticsExecutionGate,
  ) {}
  async run(
    value: unknown,
    payloads: Array<{ filename: string; bytes: Uint8Array }>,
    signal?: AbortSignal,
  ) {
    const request = DiagnosticJobRequest.parse(value);
    const encoded = new Uint8Array(
      new TextEncoder().encode(canonicalJson(request)),
    );
    const descriptors = request.validation.manifest.observations;
    if (
      encoded.length > 65536 ||
      payloads.length !== descriptors.length ||
      new Set(payloads.map((item) => item.filename)).size !== payloads.length
    )
      throw new Error('Invalid diagnostic input set');
    const inputs = [];
    for (const descriptor of descriptors) {
      const payload = payloads.find(
        (item) => item.filename === descriptor.filename,
      );
      if (
        !payload ||
        !(payload.bytes instanceof Uint8Array) ||
        payload.bytes.length !== descriptor.bytes
      )
        throw new Error('Diagnostic input length mismatch');
      const bytes = new Uint8Array(payload.bytes);
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('');
      if (digest !== descriptor.sha256)
        throw new Error('Diagnostic input hash mismatch');
      inputs.push({ key: descriptor.key, bytes });
    }
    const deadline = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(180000)])
      : AbortSignal.timeout(180000);
    deadline.throwIfAborted();
    await this.gate.claim(
      request,
      await sha256(canonicalJson(request)),
      this.session.sandboxId,
    );
    try {
      deadline.throwIfAborted();
      await this.gate.authorizeResult(request.operationId);
      await this.session.writeRequest(encoded, deadline);
      for (const input of inputs) {
        deadline.throwIfAborted();
        await this.gate.authorizeResult(request.operationId);
        await this.session.writeObservation(input.key, input.bytes, deadline);
      }
      await this.gate.authorizeResult(request.operationId);
      if ((await this.session.run(deadline)) !== 0)
        throw new Error('Diagnostic process failed');
      const raw = await readJsonBounded(
        new Response(await this.session.readResult(deadline)),
        32768,
        deadline,
      );
      const result = validateDiagnosticJobResult(raw, request);
      await this.gate.authorizeResult(request.operationId);
      deadline.throwIfAborted();
      return result;
    } catch {
      throw new Error('trusted_numeric_diagnostics_failed');
    }
  }
}
