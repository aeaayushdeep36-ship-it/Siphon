import { z } from 'zod';
import { DEFAULT_POLICY } from '@siphon/contracts';

/** Operator settings are explicit. The allowlisted origin/path is a credential
 * disclosure boundary, rather than an alternative provider or silent default. */
export const GROQ_CHAT_ENDPOINT =
  'https://api.groq.com/openai/v1/chat/completions';

const positiveInteger = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

const environmentSchema = z
  .object({
    SIPHON_AI_PROVIDER: z.literal('groq'),
    SIPHON_AI_MODEL: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
    SIPHON_AI_ENDPOINT: z.literal(GROQ_CHAT_ENDPOINT),
    SIPHON_AI_REASONING_EFFORT: z.enum([
      'low',
      'medium',
      'high',
      'none',
      'default',
    ]),
    GROQ_API_KEY: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x7e]+$/),
    SIPHON_AI_REQUEST_TIMEOUT_MS: positiveInteger.pipe(z.number().max(60_000)),
    SIPHON_AI_MAX_INPUT_BYTES: positiveInteger,
    SIPHON_AI_MAX_INPUT_TOKENS: positiveInteger.pipe(
      z.number().max(DEFAULT_POLICY.modelInputTokens),
    ),
    SIPHON_AI_MAX_OUTPUT_TOKENS: positiveInteger.pipe(
      z.number().min(16).max(DEFAULT_POLICY.modelOutputTokens),
    ),
    SIPHON_AI_MAX_REQUEST_BYTES: positiveInteger.pipe(
      z.number().max(256 * 1024),
    ),
    SIPHON_AI_MAX_RESPONSE_BYTES: positiveInteger.pipe(
      z.number().max(512 * 1024),
    ),
    SIPHON_AI_REQUESTS_PER_MINUTE: positiveInteger,
    SIPHON_AI_REQUESTS_PER_DAY: positiveInteger,
    SIPHON_AI_TOKENS_PER_MINUTE: positiveInteger,
    SIPHON_AI_TOKENS_PER_DAY: positiveInteger,
  })
  .superRefine((value, ctx) => {
    if (value.SIPHON_AI_MAX_INPUT_BYTES > value.SIPHON_AI_MAX_REQUEST_BYTES)
      ctx.addIssue({
        code: 'custom',
        message: 'AI input byte screen must fit the request transport byte cap',
        path: ['SIPHON_AI_MAX_INPUT_BYTES'],
      });
    if (
      value.SIPHON_AI_MAX_INPUT_TOKENS + value.SIPHON_AI_MAX_OUTPUT_TOKENS >
      value.SIPHON_AI_TOKENS_PER_MINUTE
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Request input and output must fit the minute token allowance',
        path: ['SIPHON_AI_MAX_INPUT_TOKENS'],
      });
    if (
      value.SIPHON_AI_TOKENS_PER_MINUTE > value.SIPHON_AI_TOKENS_PER_DAY ||
      value.SIPHON_AI_REQUESTS_PER_MINUTE > value.SIPHON_AI_REQUESTS_PER_DAY
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Minute allowances must fit the daily allowances',
      });
  })
  .transform((value) => ({
    provider: value.SIPHON_AI_PROVIDER,
    model: value.SIPHON_AI_MODEL,
    endpoint: value.SIPHON_AI_ENDPOINT,
    reasoningEffort: value.SIPHON_AI_REASONING_EFFORT,
    apiKey: value.GROQ_API_KEY,
    requestTimeoutMs: value.SIPHON_AI_REQUEST_TIMEOUT_MS,
    maxInputBytes: value.SIPHON_AI_MAX_INPUT_BYTES,
    maxInputTokens: value.SIPHON_AI_MAX_INPUT_TOKENS,
    maxOutputTokens: value.SIPHON_AI_MAX_OUTPUT_TOKENS,
    maxRequestBytes: value.SIPHON_AI_MAX_REQUEST_BYTES,
    maxResponseBytes: value.SIPHON_AI_MAX_RESPONSE_BYTES,
    requestsPerMinute: value.SIPHON_AI_REQUESTS_PER_MINUTE,
    requestsPerDay: value.SIPHON_AI_REQUESTS_PER_DAY,
    tokensPerMinute: value.SIPHON_AI_TOKENS_PER_MINUTE,
    tokensPerDay: value.SIPHON_AI_TOKENS_PER_DAY,
  }));

export interface AiEnvironment {
  SIPHON_AI_PROVIDER?: string;
  SIPHON_AI_MODEL?: string;
  SIPHON_AI_ENDPOINT?: string;
  SIPHON_AI_REASONING_EFFORT?: string;
  GROQ_API_KEY?: string;
  SIPHON_AI_REQUEST_TIMEOUT_MS?: string;
  SIPHON_AI_MAX_INPUT_BYTES?: string;
  SIPHON_AI_MAX_INPUT_TOKENS?: string;
  SIPHON_AI_MAX_OUTPUT_TOKENS?: string;
  SIPHON_AI_MAX_REQUEST_BYTES?: string;
  SIPHON_AI_MAX_RESPONSE_BYTES?: string;
  SIPHON_AI_REQUESTS_PER_MINUTE?: string;
  SIPHON_AI_REQUESTS_PER_DAY?: string;
  SIPHON_AI_TOKENS_PER_MINUTE?: string;
  SIPHON_AI_TOKENS_PER_DAY?: string;
}

export type AiConfiguration = z.infer<typeof environmentSchema>;

export class AiConfigurationError extends Error {
  constructor() {
    super(
      'AI configuration is missing or invalid; no model call is authorized',
    );
  }
}

/** Never expose Zod's error object: it can include the supplied secret value. */
export function parseAiConfiguration(
  environment: AiEnvironment,
): AiConfiguration {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) throw new AiConfigurationError();
  return parsed.data;
}
