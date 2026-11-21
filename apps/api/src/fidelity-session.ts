import { type Sandbox } from 'e2b';
import { ObservationKey } from '@siphon/contracts';

export interface FidelitySession {
  readonly sandboxId: string;
  writeRequest(
    bytes: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ): Promise<void>;
  writeObservation(
    side: 'original' | 'adapted',
    key: string,
    bytes: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ): Promise<void>;
  run(signal: AbortSignal): Promise<number>;
  readResult(signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

/** Fixed commands and generated data paths only; source files are never sent. */
export class E2bFidelitySession implements FidelitySession {
  constructor(private readonly sandbox: Sandbox) {}
  get sandboxId() {
    return this.sandbox.sandboxId;
  }
  async writeRequest(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
    await this.sandbox.files.write(
      '/tmp/siphon-fidelity-request.json',
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      { signal, requestTimeoutMs: 30000 },
    );
  }
  async writeObservation(
    side: 'original' | 'adapted',
    value: string,
    bytes: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ) {
    if (side !== 'original' && side !== 'adapted')
      throw new Error('Invalid baseline side');
    const key = ObservationKey.parse(value);
    await this.sandbox.files.makeDir(`/tmp/siphon-fidelity-${side}`, {
      signal,
      requestTimeoutMs: 30000,
    });
    await this.sandbox.files.write(
      `/tmp/siphon-fidelity-${side}/obs_${key}.npy`,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      { signal, requestTimeoutMs: 30000 },
    );
  }
  async run(signal: AbortSignal) {
    const result = await this.sandbox.commands.run(
      '/opt/siphon/venv/bin/python -I -m siphon_science.fidelity_job < /tmp/siphon-fidelity-request.json > /dev/null 2>&1',
      {
        signal,
        requestTimeoutMs: 30000,
        timeoutMs: 60000,
        retainOutput: false,
        cwd: '/tmp',
        envs: {},
      },
    );
    return result.exitCode;
  }
  readResult(signal: AbortSignal) {
    return this.sandbox.files.read('/tmp/siphon-fidelity-result.json', {
      format: 'stream',
      signal,
      requestTimeoutMs: 30000,
    });
  }
}
