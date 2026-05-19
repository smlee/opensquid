/**
 * Secrets backend + resolver interfaces.
 *
 * A `SecretBackend` owns one URI scheme (e.g. `env`, `op`, `keychain`).
 * A `SecretResolver` dispatches a full URI to the appropriate backend
 * and memoizes the result for the lifetime of the process.
 *
 * NEVER log resolved secret values. NEVER persist resolved values to disk.
 *
 * Imports from: nothing.
 * Imported by: src/secrets/resolver.ts, src/secrets/backends/*.
 */

export interface SecretBackend {
  /** URI scheme handled by this backend (e.g. 'env', 'op', 'keychain'). */
  scheme: string;
  /** Resolve a backend-scoped reference (already stripped of `scheme:` and any `//`). */
  resolve(ref: string): Promise<string | null>;
  /** Optional self-check (e.g. CLI binary present). */
  validate?(): Promise<{ ok: boolean; error?: string }>;
}

export interface SecretResolver {
  /** Resolve a full URI like `env:NAME`, `env://NAME`, `op://vault/item/field`. */
  resolve(uri: string): Promise<string | null>;
}
