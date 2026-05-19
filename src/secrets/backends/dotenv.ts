/**
 * env: + .env file backend for the secrets resolver.
 *
 * Resolution order on first call (lazy + cached for the process lifetime):
 *   1. Snapshot `process.env`.
 *   2. If `opts.path` provided, parse the .env file and merge MISSING keys.
 *      Existing process.env keys WIN — never overwritten by .env.
 *   3. ENOENT on the .env file is silently OK (file is optional).
 *
 * Parse format (intentionally minimal — sufficient for Phase 1):
 *   - Match `^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$`
 *   - Strip a single pair of surrounding double-quotes.
 *   - Skip blank lines, comments (`#`), and any non-matching line.
 *   - dotenv v16 multiline `KEY="line1\nline2"` is NOT expanded here
 *     (see Phase 1 post-research note in src/secrets/resolver.test.ts).
 *
 * Imports from: node:fs/promises, ../types.js.
 * Imported by: src/secrets/index.ts.
 */

import { readFile } from 'node:fs/promises';
import type { SecretBackend } from '../types.js';

export interface DotenvBackendOptions {
  /** Optional absolute path to a .env file. If unset, only process.env is consulted. */
  path?: string;
}

export function dotenvBackend(opts: DotenvBackendOptions = {}): SecretBackend {
  let cached: Record<string, string> | null = null;

  async function load(): Promise<Record<string, string>> {
    if (cached) return cached;

    // Start with a snapshot of process.env. Filter out undefined values so the
    // record type matches Record<string, string> strictly.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v;
    }

    if (opts.path) {
      try {
        const raw = await readFile(opts.path, 'utf8');
        for (const line of raw.split('\n')) {
          const match = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
          if (!match) continue;
          const key = match[1];
          const rawValue = match[2];
          if (key === undefined || rawValue === undefined) continue;
          // process.env wins — only fill keys that aren't already set.
          if (env[key] !== undefined) continue;
          env[key] = rawValue.replace(/^"(.*)"$/, '$1');
        }
      } catch {
        // ENOENT or unreadable .env — file is optional.
      }
    }

    cached = env;
    return cached;
  }

  return {
    scheme: 'env',
    async resolve(name: string): Promise<string | null> {
      const env = await load();
      return env[name] ?? null;
    },
  };
}
