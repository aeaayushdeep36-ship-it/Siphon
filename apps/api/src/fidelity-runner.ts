import { z } from 'zod';
import {
  BaselineComparison,
  DEFAULT_POLICY,
  Id,
  ObservationValidationRequest,
} from '@siphon/contracts';
import { type FidelitySession } from './fidelity-session.js';
import { canonicalJson, sha256 } from './hashing.js';
import { readJsonBounded } from './http.js';

export const FidelityRequest = z
  .strictObject({
    schemaVersion: z.literal('1.0'),
    operationId: Id,
    original: ObservationValidationRequest,
    adapted: ObservationValidationRequest,
  })
  .superRefine((value, ctx) => {
    const a = value.original,
      b = value.adapted;
    if (
      new Set([
        value.operationId,
        a.evaluationOperationId,
        b.evaluationOperationId,
        a.sourceOperationId,
        b.sourceOperationId,
      ]).size !== 5 ||
      a.inputDigest !== b.inputDigest ||
      a.adapterDigest !== b.adapterDigest ||
      canonicalJson(a.mappings) !== canonicalJson(b.mappings)
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Baseline comparison snapshots differ or operations are reused',
      });
    const observations = [
      ...a.manifest.observations,
      ...b.manifest.observations,
    ];
    if (
      observations.reduce((n, o) => n + o.bytes, 0) >
        DEFAULT_POLICY.outputBytes ||
      observations.reduce((n, o) => n + o.shape.reduce((x, y) => x * y, 1), 0) >
        Math.floor(DEFAULT_POLICY.outputBytes / 8)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Baseline comparison exceeds numeric limits',
      });
  });

export interface FidelityExecutionGate {
  claim(request: unknown, digest: string, sandboxId: string): Promise<void>;
  authorizeResult(operationId: string): Promise<void>;
}

/** Both validated manifests contain exactly the same required shapes and keys,
 * so only value differences can occur in a completed comparison. */
export function validateFidelityResult(value: unknown, requestValue: unknown) {
  const request = FidelityRequest.parse(requestValue);
  const result = BaselineComparison.parse(value);
  const keys = request.original.mappings.map((item) => item.key).sort();
  const total = request.original.mappings.reduce(
    (sum, item) => sum + item.expectedShape.reduce((x, y) => x * y, 1),
    0,
  );
  if (
    canonicalJson(result.observations.map((item) => item.key).sort()) !==
      canonicalJson(keys) ||
    result.comparedElements !== total ||
    result.observations.some(
      (item) => item.reason !== null && item.reason !== 'value_mismatch',
    )
  )
    throw new Error('Comparison result does not match validated inputs');
  return result;
}

/** Transport only. A durable gate and confirmed sandbox termination are still required for publication. */
export class FidelityRunner {
  constructor(
    private readonly session: FidelitySession,
    private readonly gate: FidelityExecutionGate,
  ) {}
  async run(
    value: unknown,
    original: Array<{ filename: string; bytes: Uint8Array }>,
    adapted: Array<{ filename: string; bytes: Uint8Array }>,
    signal?: AbortSignal,
  ) {
    const request = FidelityRequest.parse(value),
      body = new Uint8Array(
        new TextEncoder().encode(
          canonicalJson({
            schemaVersion: '1.0',
            original: request.original,
            adapted: request.adapted,
          }),
        ),
      );
    if (body.length > 131072)
      throw new Error('Baseline request exceeds size limit');
    const inputs: Array<{
      side: 'original' | 'adapted';
      key: string;
      bytes: Uint8Array<ArrayBuffer>;
    }> = [];
    for (const [side, job, payloads] of [
      ['original', request.original, original],
      ['adapted', request.adapted, adapted],
    ] as const) {
      if (
        payloads.length !== job.manifest.observations.length ||
        new Set(payloads.map((item) => item.filename)).size !== payloads.length
      )
        throw new Error('Baseline input set mismatch');
      for (const descriptor of job.manifest.observations) {
        const item = payloads.find(
          (candidate) => candidate.filename === descriptor.filename,
        );
        if (
          !item ||
          !(item.bytes instanceof Uint8Array) ||
          item.bytes.length !== descriptor.bytes
        )
          throw new Error('Baseline input length mismatch');
        const bytes = new Uint8Array(item.bytes),
          hash = Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
            (n) => n.toString(16).padStart(2, '0'),
          ).join('');
        if (hash !== descriptor.sha256)
          throw new Error('Baseline input hash mismatch');
        inputs.push({ side, key: descriptor.key, bytes });
      }
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
      await this.gate.authorizeResult(request.operationId);
      await this.session.writeRequest(body, deadline);
      for (const input of inputs) {
        deadline.throwIfAborted();
        await this.gate.authorizeResult(request.operationId);
        await this.session.writeObservation(
          input.side,
          input.key,
          input.bytes,
          deadline,
        );
      }
      await this.gate.authorizeResult(request.operationId);
      if ((await this.session.run(deadline)) !== 0)
        throw new Error('Comparison failed');
      const result = validateFidelityResult(
        await readJsonBounded(
          new Response(await this.session.readResult(deadline)),
          32768,
          deadline,
        ),
        request,
      );
      await this.gate.authorizeResult(request.operationId);
      deadline.throwIfAborted();
      return result;
    } catch {
      throw new Error('trusted_baseline_comparison_failed');
    }
  }
}
