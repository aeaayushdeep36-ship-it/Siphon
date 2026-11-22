import { z } from 'zod';

const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6_PATTERN = /^\[?[0-9a-fA-F:]+\]?$/;

/** Server-owned control-plane origin. Paths are forbidden because the REST
 * verifier and E2B SDK construct their endpoint paths differently. */
export const E2bApiUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      const hasExplicitPort =
        Boolean(url.port) || value.slice('https://'.length).includes(':');
      const isIp =
        IPV4_PATTERN.test(host) ||
        IPV6_PATTERN.test(host) ||
        host.startsWith('[');
      const isLocalhost =
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host === 'localhost.' ||
        host.endsWith('.localhost.');

      return (
        /^https:\/\/[^/?#\\\s]+\/?$/.test(value) &&
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === '/' &&
        value === value.trim() &&
        !hasExplicitPort &&
        !isIp &&
        !isLocalhost
      );
    } catch {
      return false;
    }
  }, 'E2B API endpoint must be a clean HTTPS origin')
  .transform((value) => new URL(value).origin);

export function e2bApiUrl(value = 'https://api.e2b.app'): string {
  const result = E2bApiUrl.safeParse(value);
  // Never include the supplied endpoint in errors: malformed URLs can carry
  // embedded credentials, query tokens or other private configuration.
  if (!result.success)
    throw new Error('E2B API endpoint must be a clean HTTPS origin');
  return result.data;
}
