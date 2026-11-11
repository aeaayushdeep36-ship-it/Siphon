import type { AiConfiguration } from './ai-config.js';
import { canonicalJson, sha256 } from './hashing.js';

/** Bind public provider settings without persisting credentials. */
export async function groqConfigurationDigest(config: AiConfiguration) {
  const { apiKey: _secret, ...publicConfig } = config;
  void _secret;
  return sha256(canonicalJson(publicConfig));
}
