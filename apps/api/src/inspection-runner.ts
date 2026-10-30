import { type Sandbox } from 'e2b';
import {
  InspectionJobRequest,
  validateInspectionJobResult,
} from '@siphon/contracts';
import { sha256 } from './hashing.js';
import { readJsonBounded } from './http.js';

const inputPath = '/tmp/siphon-inspection/request.json';
const outputPath = '/tmp/siphon-inspection/result.json';
// Approved image installs this module into the isolated interpreter's site-packages.
// No source text, filename or model-generated expression enters shell syntax.
export const INSPECTION_COMMAND =
  'ulimit -f 2048 && /opt/siphon/venv/bin/python -I -m siphon_science.inspection_job < /tmp/siphon-inspection/request.json > /tmp/siphon-inspection/result.json 2>/dev/null';

export interface InspectionSession {
  readonly sandboxId: string;
  writeRequest(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  run(signal: AbortSignal): Promise<number>;
  readResult(signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

/** Uses the already-created fresh inspection sandbox; never reconnects/extends its lifetime. */
export class E2bInspectionSession implements InspectionSession {
  constructor(private readonly sandbox: Sandbox) {}
  get sandboxId() {
    return this.sandbox.sandboxId;
  }
  async writeRequest(bytes: Uint8Array, signal: AbortSignal) {
    await this.sandbox.files.write(
      inputPath,
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
      { signal, requestTimeoutMs: 30000 },
    );
  }
  async run(signal: AbortSignal) {
    const result = await this.sandbox.commands.run(INSPECTION_COMMAND, {
      signal,
      requestTimeoutMs: 30000,
      timeoutMs: 30000,
      retainOutput: false,
      cwd: '/tmp',
      envs: {},
    });
    return result.exitCode;
  }
  readResult(signal: AbortSignal) {
    return this.sandbox.files.read(outputPath, {
      format: 'stream',
      signal,
      requestTimeoutMs: 30000,
    });
  }
}

export interface InspectionExecutionGate {
  /** Must verify inspection role, job payload digest, current fence and fresh session identity.
   * Must journal a single claim; never allow a second run in a user-modified sandbox.
   */
  claim(
    request: unknown,
    payloadDigest: string,
    sandboxId: string,
  ): Promise<void>;
  /** Reauthorize publication after remote I/O; cancellation must discard late results. */
  authorizeResult(operationId: string): Promise<void>;
}

export class InspectionRunner {
  constructor(
    private readonly session: InspectionSession,
    private readonly gate: InspectionExecutionGate,
  ) {}
  async run(value: unknown, signal?: AbortSignal) {
    const request = InspectionJobRequest.parse(value);
    const bytes = new TextEncoder().encode(JSON.stringify(request));
    if (bytes.length > 200000)
      throw new Error('Inspection request exceeds byte limit');
    // Validate digests before any sandbox I/O. Binary decode never evaluates source.
    for (const source of request.sources) {
      const decoded = Uint8Array.from(atob(source.sourceBase64), (char) =>
        char.charCodeAt(0),
      );
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', decoded)),
        (n) => n.toString(16).padStart(2, '0'),
      ).join('');
      if (digest !== source.sourceDigest)
        throw new Error('Inspection source digest mismatch');
    }
    const deadline = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
      : AbortSignal.timeout(60000);
    deadline.throwIfAborted();
    await this.gate.claim(
      request,
      await sha256(JSON.stringify(request)),
      this.session.sandboxId,
    );
    deadline.throwIfAborted();
    try {
      await this.session.writeRequest(bytes, deadline);
      deadline.throwIfAborted();
      const exitCode = await this.session.run(deadline);
      if (exitCode !== 0) throw new Error('Inspection job did not complete');
      const stream = await this.session.readResult(deadline);
      const raw = await readJsonBounded(
        new Response(stream),
        1000000,
        deadline,
      );
      const result = validateInspectionJobResult(raw, request);
      await this.gate.authorizeResult(request.operationId);
      deadline.throwIfAborted();
      return result;
    } catch {
      // Caller must terminate/reconcile the sandbox; failure is never a refund.
      throw new Error('inspection_execution_failed');
    }
  }
}
