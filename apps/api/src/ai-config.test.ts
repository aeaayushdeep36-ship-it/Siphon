import { describe, expect, it } from 'vitest';
import {
  AiConfigurationError,
  GROQ_CHAT_ENDPOINT,
  parseAiConfiguration,
  type AiEnvironment,
} from './ai-config.js';

const configured: AiEnvironment = {
  SIPHON_AI_PROVIDER: 'groq',
  SIPHON_AI_MODEL: 'authored/model',
  SIPHON_AI_ENDPOINT: GROQ_CHAT_ENDPOINT,
  SIPHON_AI_REASONING_EFFORT: 'low',
  GROQ_API_KEY: 'authored-secret',
  SIPHON_AI_REQUEST_TIMEOUT_MS: '60000',
  SIPHON_AI_MAX_INPUT_BYTES: '6000',
  SIPHON_AI_MAX_INPUT_TOKENS: '4000',
  SIPHON_AI_MAX_OUTPUT_TOKENS: '2000',
  SIPHON_AI_MAX_REQUEST_BYTES: '262144',
  SIPHON_AI_MAX_RESPONSE_BYTES: '524288',
  SIPHON_AI_REQUESTS_PER_MINUTE: '20',
  SIPHON_AI_REQUESTS_PER_DAY: '900',
  SIPHON_AI_TOKENS_PER_MINUTE: '7000',
  SIPHON_AI_TOKENS_PER_DAY: '180000',
};

describe('explicit server-side AI configuration', () => {
  it('preserves the configured model and smaller operator allowances', () => {
    expect(parseAiConfiguration(configured)).toEqual({
      provider: 'groq',
      model: 'authored/model',
      endpoint: GROQ_CHAT_ENDPOINT,
      reasoningEffort: 'low',
      apiKey: 'authored-secret',
      requestTimeoutMs: 60000,
      maxInputBytes: 6000,
      maxInputTokens: 4000,
      maxOutputTokens: 2000,
      maxRequestBytes: 262144,
      maxResponseBytes: 524288,
      requestsPerMinute: 20,
      requestsPerDay: 900,
      tokensPerMinute: 7000,
      tokensPerDay: 180000,
    });
  });

  it('requires every setting instead of guessing model, quotas or key', () => {
    for (const key of Object.keys(configured) as (keyof AiEnvironment)[]) {
      const missing = { ...configured };
      delete missing[key];
      expect(() => parseAiConfiguration(missing)).toThrow(AiConfigurationError);
    }
  });

  it('does not disclose malformed credentials in configuration errors', () => {
    expect(() =>
      parseAiConfiguration({ ...configured, GROQ_API_KEY: 'private\nsecret' }),
    ).toThrow('AI configuration is missing or invalid');
    try {
      parseAiConfiguration({ ...configured, GROQ_API_KEY: 'private\nsecret' });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('private');
      expect(String(error)).not.toContain('secret');
    }
  });

  it('rejects credential exfiltration endpoints, unsupported providers and model controls', () => {
    for (const endpoint of [
      'https://evil.example/openai/v1/chat/completions',
      'https://api.groq.com.evil.example/openai/v1/chat/completions',
      `${GROQ_CHAT_ENDPOINT}?debug=true`,
      'http://api.groq.com/openai/v1/chat/completions',
      'https://user:pass@api.groq.com/openai/v1/chat/completions',
    ])
      expect(() =>
        parseAiConfiguration({ ...configured, SIPHON_AI_ENDPOINT: endpoint }),
      ).toThrow(AiConfigurationError);
    expect(() =>
      parseAiConfiguration({ ...configured, SIPHON_AI_PROVIDER: 'meta' }),
    ).toThrow(AiConfigurationError);
    expect(() =>
      parseAiConfiguration({ ...configured, SIPHON_AI_MODEL: 'bad\nmodel' }),
    ).toThrow(AiConfigurationError);
  });

  it('rejects requests that cannot fit a minute or exceed reviewed safety bounds', () => {
    for (const override of [
      { SIPHON_AI_MAX_INPUT_TOKENS: '6000' },
      { SIPHON_AI_REQUEST_TIMEOUT_MS: '60001' },
      { SIPHON_AI_MAX_INPUT_BYTES: '262145' },
      { SIPHON_AI_MAX_REQUEST_BYTES: '262145' },
      { SIPHON_AI_MAX_RESPONSE_BYTES: '524289' },
      { SIPHON_AI_MAX_OUTPUT_TOKENS: '4001' },
      { SIPHON_AI_MAX_OUTPUT_TOKENS: '15' },
      { SIPHON_AI_REQUESTS_PER_DAY: '1' },
      { SIPHON_AI_TOKENS_PER_DAY: '100' },
      { SIPHON_AI_TOKENS_PER_MINUTE: '8e3' },
      { SIPHON_AI_TOKENS_PER_DAY: '9007199254740992' },
    ])
      expect(() =>
        parseAiConfiguration({ ...configured, ...override }),
      ).toThrow(AiConfigurationError);
  });
});
