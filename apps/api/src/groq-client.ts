import { z } from 'zod';
import { Count } from '@siphon/contracts';
import { canonicalJson, sha256 } from './hashing.js';
import { readJsonBounded } from './http.js';
import { GROQ_CHAT_ENDPOINT } from './ai-config.js';

const PositiveCount = Count.refine((value) => value > 0);
const ModelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/);
// Untrusted scheduling metadata cannot create an invalid persisted timestamp.
// Larger/invalid delays remain unknown; they never authorize an automatic retry.
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** Deployment configuration, never inferred from a provider response. The
 * official-origin restriction is a credential egress boundary, not a default. */
export const GroqTransportConfig = z.object({
  model: ModelId,
  endpoint: z.literal(GROQ_CHAT_ENDPOINT),
  requestTimeoutMs: PositiveCount,
  maxRequestBytes: PositiveCount,
  maxResponseBytes: PositiveCount,
  maxInputTokens: PositiveCount,
  maxOutputTokens: PositiveCount,
});
export type GroqTransportConfig = z.infer<typeof GroqTransportConfig>;

export const GroqRequest = z.strictObject({
  model: ModelId,
  messages: z.tuple([
    z.strictObject({ role: z.literal('system'), content: z.string().min(1) }),
    z.strictObject({ role: z.literal('user'), content: z.string().min(1) }),
  ]),
  reasoning_effort: z.enum(['none', 'default', 'low', 'medium', 'high']),
  reasoning_format: z.literal('hidden'),
  max_completion_tokens: PositiveCount,
  stream: z.literal(false),
  response_format: z.strictObject({
    type: z.literal('json_schema'),
    json_schema: z.strictObject({
      name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
      strict: z.literal(true),
      schema: z.record(z.string(), z.unknown()),
    }),
  }),
});
export type GroqRequest = z.infer<typeof GroqRequest>;

/** Reasoning is included in completion_tokens; it is never returned to callers. */
export const groqUsageSchema = z
  .object({
    prompt_tokens: Count,
    completion_tokens: Count,
    total_tokens: Count,
    prompt_tokens_details: z.object({ cached_tokens: Count }).optional(),
    completion_tokens_details: z.object({ reasoning_tokens: Count }).optional(),
  })
  .refine(
    (usage) =>
      BigInt(usage.prompt_tokens) + BigInt(usage.completion_tokens) ===
        BigInt(usage.total_tokens) &&
      (usage.prompt_tokens_details?.cached_tokens ?? 0) <=
        usage.prompt_tokens &&
      (usage.completion_tokens_details?.reasoning_tokens ?? 0) <=
        usage.completion_tokens,
  )
  .transform((usage) => ({
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.prompt_tokens_details
      ? { prompt_tokens_details: usage.prompt_tokens_details }
      : {}),
  }));
export type GroqUsage = z.infer<typeof groqUsageSchema>;

const envelopeSchema = z.object({
  id: z.string().min(1).max(300),
  object: z.literal('chat.completion'),
  model: ModelId,
  choices: z
    .array(
      z.object({
        index: z.literal(0),
        finish_reason: z.string(),
        message: z.object({
          role: z.literal('assistant'),
          content: z.string(),
          refusal: z.null().optional(),
          tool_calls: z.array(z.unknown()).max(0).optional(),
          function_call: z.null().optional(),
        }),
      }),
    )
    .length(1),
  usage: z.unknown(),
});

export class GroqFailure extends Error {
  constructor(
    public readonly code:
      | 'transport_unknown'
      | 'http_error'
      | 'invalid_response'
      | 'incomplete_output'
      | 'usage_exceeded',
    public readonly usage: GroqUsage | null = null,
    public readonly httpStatus: number | null = null,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(`Groq request failed: ${code}`);
  }
}

export interface GroqDispatchGate {
  /** Authorizes the exact wire digest once, after source disclosure, revision
   * fencing and durable request/token reservations have succeeded. */
  authorize(
    request: GroqRequest,
    requestDigest: string,
  ): Promise<{ inputTokenBound: number }>;
}

type JsonSchema = Record<string, unknown>;
const asObject = (value: unknown): JsonSchema | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonSchema)
    : null;

/** Lower optional fields to nullable required fields for constrained decoding.
 * Original Zod contracts remain authoritative for semantic validation. */
export function strictJsonSchema(value: JsonSchema): JsonSchema {
  const visit = (schema: JsonSchema): JsonSchema => {
    const result = { ...schema };
    const properties = asObject(schema.properties);
    if (properties) {
      const required = new Set(
        Array.isArray(schema.required) ? schema.required : [],
      );
      result.properties = Object.fromEntries(
        Object.entries(properties).map(([name, property]) => {
          const object = asObject(property);
          if (!object) throw new Error('Unsupported JSON property schema');
          const converted = visit(object);
          return [
            name,
            required.has(name)
              ? converted
              : { anyOf: [converted, { type: 'null' }] },
          ];
        }),
      );
      result.required = Object.keys(properties);
      result.additionalProperties = false;
    } else if (schema.type === 'object') {
      // Dynamic records cannot be represented faithfully by strict decoding.
      if (schema.additionalProperties !== false)
        throw new Error('Dynamic JSON records require a reviewed wire schema');
      result.properties = {};
      result.required = [];
    }
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
      const items = schema[key];
      if (Array.isArray(items))
        result[key] = items.map((item: unknown) => {
          const object = asObject(item);
          if (!object) throw new Error('Unsupported JSON union schema');
          return visit(object);
        });
    }
    if (Array.isArray(result.oneOf)) {
      if (result.anyOf !== undefined)
        throw new Error('Combined JSON unions require a reviewed wire schema');
      // Constrained decoding supports anyOf. The original Zod union still
      // enforces its full semantics after decoding.
      result.anyOf = result.oneOf;
      delete result.oneOf;
    }
    if ('const' in result) {
      result.enum = [result.const];
      delete result.const;
    }
    const items = asObject(schema.items);
    if (items) result.items = visit(items);
    for (const key of ['$defs', 'definitions'] as const) {
      const definitions = asObject(schema[key]);
      if (definitions)
        result[key] = Object.fromEntries(
          Object.entries(definitions).map(([name, item]) => {
            const object = asObject(item);
            if (!object) throw new Error('Unsupported JSON definition schema');
            return [name, visit(object)];
          }),
        );
    }
    return result;
  };
  return visit(value);
}

/** Restore only optional null placeholders introduced by strictJsonSchema.
 * Required nulls and explicitly nullable optional fields are preserved. */
export function normalizeStrictJsonOutput(
  value: unknown,
  schema: JsonSchema,
): unknown {
  const resolve = (node: JsonSchema): JsonSchema => {
    if (typeof node.$ref !== 'string') return node;
    if (!node.$ref.startsWith('#/'))
      throw new Error('External JSON schema references are unsupported');
    let resolved: unknown = schema;
    for (const segment of node.$ref.slice(2).split('/')) {
      const object = asObject(resolved);
      resolved = object?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    const object = asObject(resolved);
    if (!object) throw new Error('Unresolved JSON schema reference');
    return object;
  };
  const allowsNull = (node: JsonSchema): boolean =>
    node.type === 'null' ||
    (Array.isArray(node.type) && node.type.includes('null')) ||
    (Array.isArray(node.anyOf) &&
      node.anyOf.some((item: unknown) => {
        const object = asObject(item);
        return object !== null && allowsNull(object);
      }));
  const walk = (item: unknown, node: JsonSchema): unknown => {
    node = resolve(node);
    const union = node.anyOf ?? node.oneOf;
    if (Array.isArray(union)) {
      const candidates = union
        .map((entry: unknown) => asObject(entry))
        .filter((entry): entry is JsonSchema => entry !== null)
        .map(resolve);
      const object = asObject(item);
      const matched = candidates.find((candidate) => {
        const properties = asObject(candidate.properties);
        if (!object || !properties) return false;
        return Object.entries(properties).every(([key, entry]) => {
          const property = asObject(entry);
          if (!property) return true;
          if ('const' in property) return object[key] === property.const;
          if (Array.isArray(property.enum))
            return property.enum.includes(object[key]);
          return true;
        });
      });
      if (matched) return walk(item, matched);
    }
    if (Array.isArray(item)) {
      const items = asObject(node.items);
      return items ? item.map((entry) => walk(entry, items)) : item;
    }
    const object = asObject(item);
    const properties = asObject(node.properties);
    if (!object || !properties) return item;
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    return Object.fromEntries(
      Object.entries(object).flatMap(([name, entry]) => {
        const property = asObject(properties[name]);
        if (!property) return [[name, entry]];
        if (
          entry === null &&
          !required.has(name) &&
          !allowsNull(resolve(property))
        )
          return [];
        return [[name, walk(entry, property)]];
      }),
    );
  };
  return walk(value, schema);
}

/** One attempt only. Quota scheduling and uncertain-outcome reconciliation belong
 * to the durable caller, not an SDK's hidden retry loop. */
export class GroqClient {
  private readonly config: GroqTransportConfig;

  constructor(
    private readonly apiKey: string,
    config: GroqTransportConfig,
    private readonly dispatch: GroqDispatchGate,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!apiKey || apiKey.trim() !== apiKey || /\s/.test(apiKey))
      throw new Error('Invalid Groq credential configuration');
    this.config = GroqTransportConfig.parse(config);
  }

  async complete<T>(
    value: unknown,
    outputSchema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<{
    output: T;
    usage: GroqUsage;
    providerId: string;
    requestDigest: string;
  }> {
    const request = GroqRequest.parse(value);
    if (
      request.model !== this.config.model ||
      request.max_completion_tokens > this.config.maxOutputTokens
    )
      throw new Error('Model request does not match deployment configuration');
    const body = canonicalJson(request);
    if (new TextEncoder().encode(body).length > this.config.maxRequestBytes)
      throw new Error('Model request byte limit');
    signal.throwIfAborted();
    const requestDigest = await sha256(body);
    const permit = await this.dispatch.authorize(request, requestDigest);
    if (
      !Number.isSafeInteger(permit.inputTokenBound) ||
      permit.inputTokenBound < 1 ||
      permit.inputTokenBound > this.config.maxInputTokens
    )
      throw new Error('Invalid model input bound');
    const timeout = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.config.requestTimeoutMs),
    ]);
    let response: Response;
    try {
      timeout.throwIfAborted();
      const fetcher = this.fetcher;
      response = await fetcher(this.config.endpoint, {
        method: 'POST',
        redirect: 'manual',
        signal: timeout,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch {
      throw new GroqFailure('transport_unknown');
    }
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after');
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const retryAfterMs =
        Number.isFinite(seconds) &&
        seconds >= 0 &&
        seconds * 1000 <= MAX_RETRY_AFTER_MS &&
        Number.isSafeInteger(Math.ceil(seconds * 1000))
          ? Math.ceil(seconds * 1000)
          : null;
      await response.body?.cancel().catch(() => undefined);
      throw new GroqFailure('http_error', null, response.status, retryAfterMs);
    }
    let raw: unknown;
    try {
      raw = await readJsonBounded(
        response,
        this.config.maxResponseBytes,
        timeout,
      );
    } catch {
      throw new GroqFailure('invalid_response');
    }
    const usageResult = z.object({ usage: groqUsageSchema }).safeParse(raw);
    const usage = usageResult.success ? usageResult.data.usage : null;
    if (!usage) throw new GroqFailure('invalid_response');
    if (
      usage.prompt_tokens > permit.inputTokenBound ||
      usage.completion_tokens > request.max_completion_tokens
    )
      throw new GroqFailure('usage_exceeded', usage);
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success || parsed.data.model !== request.model)
      throw new GroqFailure('invalid_response', usage);
    const choice = parsed.data.choices[0]!;
    if (choice.finish_reason !== 'stop')
      throw new GroqFailure('incomplete_output', usage);
    let output: T;
    try {
      const original = z.toJSONSchema(outputSchema) as JsonSchema;
      output = outputSchema.parse(
        normalizeStrictJsonOutput(JSON.parse(choice.message.content), original),
      );
    } catch {
      throw new GroqFailure('invalid_response', usage);
    }
    return { output, usage, providerId: parsed.data.id, requestDigest };
  }
}
