import { CommandExitError, type Sandbox } from 'e2b';
import {
  SourceJobRequest,
  validateSourceJobResult,
  ObservationKey,
} from '@siphon/contracts';
import { sha256 } from './hashing.js';
import { readJsonBounded } from './http.js';
import { verifyUploadBytes } from './upload-bytes.js';

export const SOURCE_COMMAND =
  '/opt/siphon/venv/bin/python -I -m siphon_science.source_job < /tmp/siphon-source-request.json > /dev/null 2>&1';
export const REFERENCE_SOURCE_COMMAND =
  '/opt/siphon/venv/bin/python -I -m siphon_science.reference_source_job < /tmp/siphon-source-request.json > /dev/null 2>&1';
/** The sandbox reported a nonzero exit; no private output is exposed. */
export class SourceJobFailed extends Error {
  constructor() {
    super('source_job_failed');
  }
}
export interface SourceSession {
  readonly sandboxId: string;
  writeRequest(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  run(
    signal: AbortSignal,
    profile: 'adapter_v1' | 'reference_v1',
  ): Promise<number>;
  readManifest(signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  readObservation(
    key: string,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
}
export interface SourceExecutionGate {
  /** Must journal a single source-role execution, bind approved adapter/experiment
   * and reserve cumulative output+storage before I/O. No permissive default.
   */
  claim(
    request: unknown,
    payloadDigest: string,
    sandboxId: string,
    profile?: 'adapter_v1' | 'reference_v1',
  ): Promise<void>;
  authorizeCollection(operationId: string): Promise<void>;
}
export class E2bSourceSession implements SourceSession {
  constructor(private readonly sandbox: Sandbox) {}
  get sandboxId() {
    return this.sandbox.sandboxId;
  }
  async writeRequest(bytes: Uint8Array, signal: AbortSignal) {
    await this.sandbox.files.write(
      '/tmp/siphon-source-request.json',
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
      { signal, requestTimeoutMs: 30000 },
    );
  }
  async run(signal: AbortSignal, profile: 'adapter_v1' | 'reference_v1') {
    if (profile !== 'adapter_v1' && profile !== 'reference_v1')
      throw new Error('Invalid source extraction profile');
    try {
      const result = await this.sandbox.commands.run(
        profile === 'reference_v1' ? REFERENCE_SOURCE_COMMAND : SOURCE_COMMAND,
        {
          signal,
          requestTimeoutMs: 30000,
          timeoutMs: 120000,
          retainOutput: false,
          cwd: '/tmp',
          envs: {},
        },
      );
      return result.exitCode;
    } catch (error) {
      if (error instanceof CommandExitError) return error.exitCode;
      throw error;
    }
  }
  readManifest(signal: AbortSignal) {
    return this.sandbox.files.read('/tmp/siphon-source-result.json', {
      format: 'stream',
      signal,
      requestTimeoutMs: 30000,
    });
  }
  readObservation(value: string, signal: AbortSignal) {
    const key = ObservationKey.parse(value);
    return this.sandbox.files.read(
      `/tmp/siphon-source-job/observations/obs_${key}.npy`,
      { format: 'stream', signal, requestTimeoutMs: 30000 },
    );
  }
}

/** Returns UNVALIDATED numeric bytes. Trusted data-only decoding and sandbox
 * termination/provenance checks are still required before scientific use.
 */
export class SourceRunner {
  constructor(
    private readonly session: SourceSession,
    private readonly gate: SourceExecutionGate,
  ) {}
  async run(
    value: unknown,
    signal?: AbortSignal,
    profile: 'adapter_v1' | 'reference_v1' = 'adapter_v1',
  ) {
    const request = SourceJobRequest.parse(value);
    const serialized = JSON.stringify(request);
    const bytes = new TextEncoder().encode(serialized);
    if (bytes.length > 8 * 1024 ** 2)
      throw new Error('Source request byte limit');
    for (const file of request.files) {
      const decoded = Uint8Array.from(atob(file.dataBase64), (char) =>
        char.charCodeAt(0),
      );
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', decoded)),
        (n) => n.toString(16).padStart(2, '0'),
      ).join('');
      if (hash !== file.sha256) throw new Error('Source input digest mismatch');
    }
    const deadline = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(180000)])
      : AbortSignal.timeout(180000);
    deadline.throwIfAborted();
    await this.gate.claim(
      request,
      await sha256(serialized),
      this.session.sandboxId,
      profile,
    );
    deadline.throwIfAborted();
    try {
      await this.gate.authorizeCollection(request.operationId);
      await this.session.writeRequest(bytes, deadline);
      await this.gate.authorizeCollection(request.operationId);
      if ((await this.session.run(deadline, profile)) !== 0)
        throw new SourceJobFailed();
      await this.gate.authorizeCollection(request.operationId);
      const raw = await readJsonBounded(
        new Response(await this.session.readManifest(deadline)),
        32768,
        deadline,
      );
      const manifest = validateSourceJobResult(raw, request);
      const payloads = [];
      for (const observation of manifest.observations) {
        await this.gate.authorizeCollection(request.operationId);
        deadline.throwIfAborted();
        const stream = await this.session.readObservation(
          observation.key,
          deadline,
        );
        const verified = await verifyUploadBytes(
          stream,
          observation.bytes,
          observation.sha256,
          request.maximumOutputBytes,
          deadline,
        );
        payloads.push({
          key: observation.key,
          filename: observation.filename,
          bytes: verified.bytes,
        });
      }
      await this.gate.authorizeCollection(request.operationId);
      deadline.throwIfAborted();
      return {
        manifest,
        payloads,
        validation: 'unvalidated_numeric_bytes' as const,
      };
    } catch (error) {
      // Caller retains accounting and terminates/reconciles the source VM.
      if (error instanceof SourceJobFailed) throw error;
      // Provider and sandbox failures may contain private output or credentials.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('source_execution_or_collection_failed');
    }
  }
}
