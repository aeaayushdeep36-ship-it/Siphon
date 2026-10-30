import { z } from 'zod';
import { Count, DEFAULT_POLICY } from '@siphon/contracts';
import { canonicalJson, sha256 } from './hashing.js';
import { readJsonBounded } from './http.js';

export const MetaRequest = z.strictObject({
  model: z.literal('muse-wonder-1.0'),
  input: z.tuple([
    z.strictObject({
      role: z.literal('developer'),
      content: z.string().min(1).max(16000),
    }),
    z.strictObject({
      role: z.literal('user'),
      content: z.string().min(1).max(131072),
    }),
  ]),
  reasoning: z.strictObject({
    effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  }),
  max_output_tokens: z
    .number()
    .int()
    .min(16)
    .max(DEFAULT_POLICY.modelOutputTokens),
  stream: z.literal(false),
  store: z.literal(false),
  background: z.literal(false),
  truncation: z.literal('disabled'),
  text: z.strictObject({
    format: z.strictObject({
      type: z.literal('json_schema'),
      name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
      schema: z.record(z.string(), z.unknown()),
    }),
  }),
});
export type MetaRequest = z.infer<typeof MetaRequest>;
export const usageSchema = z
  .object({
    prompt_tokens: Count,
    completion_tokens: Count,
    total_tokens: Count,
    prompt_tokens_details: z.object({ cached_tokens: Count }).optional(),
  })
  .superRefine((usage, ctx) => {
    if (
      BigInt(usage.prompt_tokens) + BigInt(usage.completion_tokens) !==
        BigInt(usage.total_tokens) ||
      (usage.prompt_tokens_details?.cached_tokens ?? 0) > usage.prompt_tokens
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent provider usage' });
  });
export type MetaUsage = z.infer<typeof usageSchema>;
const envelopeSchema = z.object({
  object: z.literal('response'),
  id: z.string().min(1).max(300),
  model: z.literal('muse-wonder-1.0'),
  status: z.enum([
    'completed',
    'failed',
    'in_progress',
    'cancelled',
    'queued',
    'incomplete',
  ]),
  error: z.null(),
  incomplete_details: z.nullable(z.record(z.string(), z.unknown())),
  store: z.literal(false).optional(),
  background: z.literal(false).optional(),
  previous_response_id: z.null().optional(),
  conversation: z.null().optional(),
  output: z
    .array(
      z.discriminatedUnion('type', [
        z.object({
          type: z.literal('reasoning'),
          status: z.enum(['in_progress', 'completed', 'incomplete']).optional(),
        }),
        z.object({
          type: z.literal('message'),
          role: z.literal('assistant'),
          status: z.enum(['in_progress', 'completed', 'incomplete']).optional(),
          content: z
            .array(
              z.discriminatedUnion('type', [
                z.object({
                  type: z.literal('output_text'),
                  text: z.string().max(200000),
                }),
                z.object({
                  type: z.literal('refusal'),
                  refusal: z.string().max(200000),
                }),
              ]),
            )
            .min(1)
            .max(16),
        }),
      ]),
    )
    .max(16),
  usage: z.unknown(),
});

/** Internal accounting retains its existing canonical usage keys. Only this
 * explicit Responses adapter translates provider fields; output includes reasoning.
 */
export const responseUsageSchema = z
  .object({
    input_tokens: Count,
    output_tokens: Count,
    total_tokens: Count,
    input_tokens_details: z.object({ cached_tokens: Count }),
    output_tokens_details: z.object({ reasoning_tokens: Count }),
  })
  .refine(
    (usage) =>
      BigInt(usage.input_tokens) + BigInt(usage.output_tokens) ===
        BigInt(usage.total_tokens) &&
      usage.input_tokens_details.cached_tokens <= usage.input_tokens &&
      usage.output_tokens_details.reasoning_tokens <= usage.output_tokens,
  )
  .transform((usage) =>
    usageSchema.parse({
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens,
      prompt_tokens_details: {
        cached_tokens: usage.input_tokens_details.cached_tokens,
      },
    }),
  );

export class MetaFailure extends Error {
  constructor(
    public readonly code:
      | 'transport_unknown'
      | 'http_error'
      | 'invalid_response'
      | 'incomplete_output'
      | 'usage_exceeded',
    public readonly usage: MetaUsage | null = null,
  ) {
    super(`Meta request failed: ${code}`);
  }
}

export interface MetaDispatchGate {
  /** Must verify full-request token bounds (including schema/instructions), source
   * privacy, ownership/fence, attempt limits and monetary reservations, then mark
   * exactly one dispatch. No production permissive implementation is provided.
   * Return the verified reserved input bound, not an estimate from string length.
   */
  authorize(
    request: MetaRequest,
    requestDigest: string,
  ): Promise<{ inputTokenBound: number }>;
}

/** Single-attempt transport, never a standalone permission to spend credits. */
export class MetaClient {
  constructor(
    private readonly apiKey: string,
    private readonly dispatch: MetaDispatchGate,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!apiKey || /[\r\n]/.test(apiKey))
      throw new Error('Invalid Meta credential configuration');
  }

  async complete<T>(
    value: unknown,
    outputSchema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<{
    output: T;
    usage: MetaUsage;
    providerId: string;
    requestDigest: string;
  }> {
    const request = MetaRequest.parse(value);
    const body = canonicalJson(request);
    // Transport byte limit, NOT a tokenizer or proof of the input-token limit.
    if (new TextEncoder().encode(body).length > 256 * 1024)
      throw new Error('Model request byte limit');
    signal.throwIfAborted();
    const requestDigest = await sha256(body);
    const permit = await this.dispatch.authorize(request, requestDigest);
    if (
      !Number.isSafeInteger(permit.inputTokenBound) ||
      permit.inputTokenBound < 1 ||
      permit.inputTokenBound > DEFAULT_POLICY.modelInputTokens
    )
      throw new Error('Invalid verified model input bound');
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    let response: Response;
    try {
      timeout.throwIfAborted();
      response = await this.fetcher('https://api.meta.ai/v1/responses', {
        method: 'POST',
        redirect: 'error',
        signal: timeout,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch {
      throw new MetaFailure('transport_unknown');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new MetaFailure('http_error');
    }
    let raw: unknown;
    try {
      raw = await readJsonBounded(response, 512 * 1024, timeout);
    } catch {
      throw new MetaFailure('invalid_response');
    }
    // Preserve trustworthy usage even when output itself is malformed.
    const rawObject = z.object({ usage: responseUsageSchema }).safeParse(raw);
    const usage = rawObject.success ? rawObject.data.usage : null;
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success || !usage)
      throw new MetaFailure('invalid_response', usage);
    if (
      usage.prompt_tokens > permit.inputTokenBound ||
      usage.completion_tokens > request.max_output_tokens
    )
      throw new MetaFailure('usage_exceeded', usage);
    const messages = parsed.data.output.filter(
      (item) => item.type === 'message',
    );
    if (
      parsed.data.status !== 'completed' ||
      parsed.data.incomplete_details !== null ||
      messages.length !== 1 ||
      (messages[0]!.status !== undefined &&
        messages[0]!.status !== 'completed') ||
      parsed.data.output.some(
        (item) =>
          item.type === 'reasoning' &&
          item.status !== undefined &&
          item.status !== 'completed',
      ) ||
      messages[0]!.content.some((part) => part.type !== 'output_text')
    )
      throw new MetaFailure('incomplete_output', usage);
    let output: T;
    try {
      const text = messages[0]!.content
        .map((part) => (part.type === 'output_text' ? part.text : ''))
        .join('');
      if (text.length > 200000) throw new Error('Output text bound');
      output = outputSchema.parse(JSON.parse(text));
    } catch {
      throw new MetaFailure('invalid_response', usage);
    }
    return {
      output,
      usage,
      providerId: parsed.data.id,
      requestDigest,
    };
  }
}
