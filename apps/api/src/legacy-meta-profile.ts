/** Frozen identity for pre-migration records and explicit compatibility tests.
 * Production provider selection comes only from parseAiConfiguration; these
 * constants are never a missing-configuration fallback or a current allocation. */
export const LEGACY_META_MODEL = 'muse-wonder-1.0';
export const LEGACY_META_RESPONSES_ENDPOINT =
  'https://api.meta.ai/v1/responses';
export const LEGACY_META_COUNT_ENDPOINT = `${LEGACY_META_RESPONSES_ENDPOINT}/input_tokens`;
