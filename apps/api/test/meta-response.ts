import { type MetaUsage } from '../src/meta-client.js';

/** Authored provider-wire fixture, not an API response or tokenizer measurement. */
export function metaResponse(
  text: string,
  usage: MetaUsage = {
    prompt_tokens: 20,
    completion_tokens: 10,
    total_tokens: 30,
  },
) {
  return {
    id: 'provider_fixture',
    object: 'response',
    model: 'muse-wonder-1.0',
    status: 'completed',
    error: null,
    incomplete_details: null as Record<string, unknown> | null,
    store: false,
    usage: {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      input_tokens_details: {
        cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }],
      },
    ],
  };
}
