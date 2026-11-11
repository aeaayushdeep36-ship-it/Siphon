import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { parseAiConfiguration } from './ai-config.js';
import { GROQ_CHAT_ENDPOINT } from './ai-config.js';
import {
  GroqClient,
  GroqFailure,
  GroqRequest,
  strictJsonSchema,
} from './groq-client.js';

const FREE_TIER_ACK = 'I-confirm-this-key-is-on-Groq-Free';

function readDevelopmentVariables(text: string): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const name = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    )
      value = value.slice(1, -1);
    variables[name] = value;
  }
  return variables;
}

async function main(): Promise<void> {
  if (process.env.SIPHON_GROQ_LIVE_SMOKE !== FREE_TIER_ACK) {
    console.error(
      'Stopped before reading the local key or making a request. Confirm the Groq console shows the Free plan, then set SIPHON_GROQ_LIVE_SMOKE to the exact acknowledgement documented in docs/TESTING.md.',
    );
    process.exitCode = 2;
    return;
  }

  const localText = await readFile(
    resolve(process.cwd(), 'apps/api/.dev.vars'),
    'utf8',
  );
  const local = readDevelopmentVariables(localText);
  const environment = { ...local, ...process.env };
  const config = parseAiConfiguration(environment);
  const schema = z.strictObject({ ok: z.literal(true) });
  const request = GroqRequest.parse({
    model: config.model,
    messages: [
      {
        role: 'system',
        content: 'Return the requested JSON object and nothing else.',
      },
      { role: 'user', content: 'Return exactly {"ok":true}.' },
    ],
    reasoning_effort: 'none',
    reasoning_format: 'hidden',
    max_completion_tokens: Math.min(32, config.maxOutputTokens),
    stream: false,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'GroqSmokeCheck',
        strict: true,
        schema: strictJsonSchema(z.toJSONSchema(schema)),
      },
    },
  });
  const client = new GroqClient(
    config.apiKey,
    {
      model: config.model,
      endpoint: GROQ_CHAT_ENDPOINT,
      requestTimeoutMs: config.requestTimeoutMs,
      maxRequestBytes: config.maxRequestBytes,
      maxResponseBytes: config.maxResponseBytes,
      maxInputTokens: config.maxInputTokens,
      maxOutputTokens: config.maxOutputTokens,
    },
    {
      async authorize() {
        return { inputTokenBound: Math.min(256, config.maxInputTokens) };
      },
    },
  );

  try {
    const result = await client.complete(
      request,
      schema,
      AbortSignal.timeout(config.requestTimeoutMs),
    );
    console.log(
      JSON.stringify({
        status: 'ok',
        model: config.model,
        usage: result.usage,
      }),
    );
  } catch (error) {
    const detail =
      error instanceof GroqFailure
        ? error.code === 'http_error'
          ? `http_error status=${error.httpStatus ?? 'unknown'}${error.retryAfterMs === null ? '' : ` retry_after_seconds=${error.retryAfterMs / 1000}`}`
          : error.code
        : 'request_failed';
    console.error(
      `Groq smoke check failed (${detail}); response body omitted.`,
    );
    process.exitCode = 1;
  }
}

await main();
