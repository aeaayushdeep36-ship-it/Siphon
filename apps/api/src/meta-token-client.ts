import { z } from 'zod';
import { Count } from '@siphon/contracts';
import { MetaRequest } from './meta-client.js';
import { canonicalJson, sha256 } from './hashing.js';
import { readJsonBounded } from './http.js';

export interface MetaTokenGate {
  /** Token counting discloses the complete request too. Must authorize owner,
   * current revision, exact request/source disclosure and a bounded one-shot
   * counting attempt before transport; no default or inference permission.
   */
  authorize(request: MetaRequest, requestDigest: string): Promise<void>;
}
export class MetaTokenFailure extends Error {
  constructor(
    public readonly code:
      'transport_unknown' | 'http_error' | 'invalid_response',
  ) {
    super(`Meta token count failed: ${code}`);
  }
}
const CountResponse = z.strictObject({
  object: z.literal('response.input_tokens'),
  input_tokens: Count.refine((value) => value > 0),
});

/** Provider-rendered context measurement, not a billing estimate or execution
 * permit. The body is exactly the strict Responses request sent by MetaClient.
 * No Chat translation, character heuristic, generation, server history or retry.
 */
export class MetaTokenClient {
  constructor(
    private readonly apiKey: string,
    private readonly gate: MetaTokenGate,
    private readonly transport: typeof fetch = fetch,
  ) {
    if (!apiKey || /[\r\n]/.test(apiKey))
      throw new Error('Invalid Meta credential configuration');
  }
  async count(value: unknown, signal: AbortSignal) {
    const request = MetaRequest.parse(value);
    const body = canonicalJson(request);
    if (new TextEncoder().encode(body).length > 256 * 1024)
      throw new Error('Model request byte limit');
    signal.throwIfAborted();
    const requestDigest = await sha256(body);
    await this.gate.authorize(request, requestDigest);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    let response: Response;
    try {
      deadline.throwIfAborted();
      response = await this.transport(
        'https://api.meta.ai/v1/responses/input_tokens',
        {
          method: 'POST',
          redirect: 'error',
          signal: deadline,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
          body,
        },
      );
    } catch {
      throw new MetaTokenFailure('transport_unknown');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new MetaTokenFailure('http_error');
    }
    try {
      const result = CountResponse.parse(
        await readJsonBounded(response, 4096, deadline),
      );
      deadline.throwIfAborted();
      return {
        model: request.model,
        protocol: 'responses.v1' as const,
        requestDigest,
        inputTokens: result.input_tokens,
        measurement: 'rendered_context' as const,
      };
    } catch {
      throw new MetaTokenFailure('invalid_response');
    }
  }
}
