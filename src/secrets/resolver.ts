/**
 * URI parser + dispatcher for the secrets resolver.
 *
 * URI shapes:
 *   - `env:MY_VAR`            scheme=env,      ref=MY_VAR
 *   - `env://MY_VAR`          scheme=env,      ref=MY_VAR        (strip leading `//`)
 *   - `op://vault/item/field` scheme=op,       ref=vault/item/field
 *   - `keychain:TEST_KEY`     scheme=keychain, ref=TEST_KEY
 *
 * Cache semantics: positive resolutions are memoized for the lifetime of the
 * resolver instance. Null results are NOT cached so a later-populated source
 * (e.g. user adds the secret) can still be picked up.
 *
 * Imports from: ./types.ts.
 * Imported by: src/secrets/index.ts.
 */

import type { SecretBackend, SecretResolver } from './types.js';

export function createResolver(backends: SecretBackend[]): SecretResolver {
  const map = new Map<string, SecretBackend>(backends.map((b) => [b.scheme, b]));
  const cache = new Map<string, string>();

  return {
    async resolve(uri: string): Promise<string | null> {
      const cached = cache.get(uri);
      if (cached !== undefined) return cached;

      const colon = uri.indexOf(':');
      if (colon < 0) return null;

      const scheme = uri.slice(0, colon);
      const ref = uri.slice(colon + 1).replace(/^\/\//, '');

      const backend = map.get(scheme);
      if (!backend) return null;

      const value = await backend.resolve(ref);
      if (value !== null) cache.set(uri, value);
      return value;
    },
  };
}
