import { type Sandbox } from 'e2b';
import {
  ObservationKey,
  ObservationValidationRequest,
  validateObservationValidationResult,
} from '@siphon/contracts';
import { sha256, canonicalJson } from './hashing.js';
import { readJsonBounded } from './http.js';

export const VALIDATION_COMMAND =
  '/opt/siphon/venv/bin/python -I -m siphon_science.validation_job < /tmp/siphon-validation-request.json > /dev/null 2>&1';
export interface ValidationSession {
  readonly sandboxId: string;
  writeRequest(
    bytes: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ): Promise<void>;
  writeObservation(
    key: string,
    bytes: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ): Promise<void>;
  run(signal: AbortSignal): Promise<number>;
  readResult(signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}
export class E2bValidationSession implements ValidationSession {
  constructor(private readonly sandbox: Sandbox) {}
  get sandboxId() {
    return this.sandbox.sandboxId;
  }
  async writeRequest(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
    await this.sandbox.files.write(
      '/tmp/siphon-validation-request.json',
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
    await this.sandbox.files.makeDir('/tmp/siphon-validation-data', {
      signal,
      requestTimeoutMs: 30000,
    });
    await this.sandbox.files.write(
      `/tmp/siphon-validation-data/obs_${key}.npy`,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      { signal, requestTimeoutMs: 30000 },
    );
  }
  async run(signal: AbortSignal) {
    const result = await this.sandbox.commands.run(VALIDATION_COMMAND, {
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
    return this.sandbox.files.read('/tmp/siphon-validation-result.json', {
      format: 'stream',
      signal,
      requestTimeoutMs: 30000,
    });
  }
}
export interface ValidationExecutionGate {
  /** Requires a fresh evaluation-role VM, source termination, approved stored
   * artifacts, current fence and reserved output/compute. No default gate.
   */
  claim(
    request: unknown,
    payloadDigest: string,
    sandboxId: string,
  ): Promise<void>;
  authorizeResult(evaluationOperationId: string): Promise<void>;
}
export class ValidationRunner {
  constructor(
    private readonly session: ValidationSession,
    private readonly gate: ValidationExecutionGate,
  ) {}
  async run(
    value: unknown,
    payloads: Array<{ filename: string; bytes: Uint8Array }>,
    signal?: AbortSignal,
  ) {
    const request = ObservationValidationRequest.parse(value);
    const body = new Uint8Array(
      new TextEncoder().encode(canonicalJson(request)),
    );
    if (
      body.length > 65536 ||
      payloads.length !== request.manifest.observations.length ||
      new Set(payloads.map((item) => item.filename)).size !== payloads.length
    )
      throw new Error('Invalid validation input set');
    const inputs = [];
    for (const descriptor of request.manifest.observations) {
      const item = payloads.find(
        (input) => input.filename === descriptor.filename,
      );
      if (
        !item ||
        !(item.bytes instanceof Uint8Array) ||
        item.bytes.length !== descriptor.bytes
      )
        throw new Error('Validation input length mismatch');
      const bytes = new Uint8Array(item.bytes);
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (n) => n.toString(16).padStart(2, '0'),
      ).join('');
      if (hash !== descriptor.sha256)
        throw new Error('Validation input hash mismatch');
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
    deadline.throwIfAborted();
    try {
      await this.gate.authorizeResult(request.evaluationOperationId);
      await this.session.writeRequest(body, deadline);
      for (const input of inputs) {
        deadline.throwIfAborted();
        await this.gate.authorizeResult(request.evaluationOperationId);
        await this.session.writeObservation(input.key, input.bytes, deadline);
      }
      await this.gate.authorizeResult(request.evaluationOperationId);
      if ((await this.session.run(deadline)) !== 0)
        throw new Error('Numeric validation failed');
      const raw = await readJsonBounded(
        new Response(await this.session.readResult(deadline)),
        32768,
        deadline,
      );
      const result = validateObservationValidationResult(raw, request);
      await this.gate.authorizeResult(request.evaluationOperationId);
      deadline.throwIfAborted();
      return result;
    } catch {
      throw new Error('trusted_numeric_validation_failed');
    }
  }
}
