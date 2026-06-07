/**
 * RAG backend configuration resolver.
 *
 * Decides which backend `buildRegistry()` instantiates for the host
 * runtime. Resolution chain (first match wins):
 *
 *   1. `OPENSQUID_RAG_BACKEND` env var — explicit override (test seam +
 *      user pinning). Accepts: `loop-engine` | `libsql-qwen3` |
 *      `libsql-lexical` | `claude-auto-memory`. Unknown values surface
 *      as an error at boot rather than silently selecting a default.
 *   2. `~/.opensquid/rag-config.json` — persisted user choice. Same kind
 *      vocabulary. Phase 1 ships read-only; setup wizard writes it.
 *   3. Default: `loop-engine` when the engine binary is discoverable
 *      via `resolveEngineBin()`; else `libsql-qwen3` (the historical
 *      Phase-1 default — same Qwen3 embedder either way, so users
 *      without an engine binary still get hybrid recall).
 *
 * The discoverability check is non-blocking — if the engine binary
 * lookup throws, we fall back to libsql-qwen3 with a stderr note. This
 * keeps boot resilient to a half-migrated engine path while still
 * preferring the engine when it's wired up correctly.
 *
 * Each variant's tunable opts (`dbUrl`, `ollamaUrl`, `mode`) accept
 * config-file overrides. Sensible defaults baked in so a missing
 * config file produces a working backend without any user setup.
 *
 * Imports from: ../engine/config.js, ./backend_factory.js.
 * Imported by: src/runtime/bootstrap.ts.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveEngineBin } from '../engine/config.js';

import type { BackendConfig } from './backend_factory.js';

const RAG_CONFIG_FILENAME = 'rag-config.json';

function opensquidHome(): string {
  const env = process.env.OPENSQUID_HOME?.trim();
  return env && env.length > 0 ? env : join(homedir(), '.opensquid');
}

function ragConfigPath(): string {
  return join(opensquidHome(), RAG_CONFIG_FILENAME);
}

// File schema is permissive — only `kind` is required; everything else
// has a default. Same shape as `BackendConfig`, but we parse defensively
// (unknown kinds error early; missing optional fields fill from defaults).
interface PersistedConfig {
  kind?: string;
  dbUrl?: string;
  ollamaUrl?: string;
  embedderModel?: string;
  mode?: 'semantic' | 'text' | 'hybrid';
}

/**
 * Resolve the backend config for `buildRegistry()`. Always returns a
 * usable config — never null. Logs to stderr when falling back to the
 * libsql default after an engine binary lookup miss so users see why
 * their preferred backend isn't active.
 */
export async function resolveBackendConfig(): Promise<BackendConfig> {
  const fromEnv = process.env.OPENSQUID_RAG_BACKEND?.trim();
  const persisted = await loadPersisted();

  // Order: env > persisted > default. Each layer can supply opts the
  // others don't (env picks kind; persisted supplies dbUrl/ollamaUrl).
  const kind = fromEnv ?? persisted.kind ?? (await pickDefaultKind());

  switch (kind) {
    case 'loop-engine':
      return {
        kind: 'loop-engine',
        ...(persisted.mode === undefined ? {} : { mode: persisted.mode }),
        ...(persisted.ollamaUrl === undefined ? {} : { ollamaUrl: persisted.ollamaUrl }),
      };
    case 'libsql-qwen3':
      return {
        kind: 'libsql-qwen3',
        dbUrl: persisted.dbUrl ?? defaultLibsqlUrl(),
        ollamaUrl: persisted.ollamaUrl ?? 'http://localhost:11434',
        ...(persisted.embedderModel === undefined
          ? {}
          : { embedderModel: persisted.embedderModel }),
      };
    case 'libsql-lexical':
      return { kind: 'libsql-lexical', dbUrl: persisted.dbUrl ?? defaultLibsqlUrl() };
    case 'libsql-fastembed':
      return { kind: 'libsql-fastembed', dbUrl: persisted.dbUrl ?? defaultLibsqlUrl() };
    case 'claude-auto-memory':
      return { kind: 'claude-auto-memory' };
    default:
      throw new Error(
        `Unknown RAG backend kind: ${kind}. ` +
          `Expected one of: loop-engine, libsql-qwen3, libsql-fastembed, libsql-lexical, claude-auto-memory.`,
      );
  }
}

async function loadPersisted(): Promise<PersistedConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(ragConfigPath(), 'utf8');
  } catch (e) {
    // Missing file is the common-case (no user override) — silent. Any
    // other read error (EACCES, EIO, etc.) is unusual — warn so users
    // know why their persisted backend choice isn't being picked up.
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      process.stderr.write(
        `[opensquid] rag-config read failed at ${ragConfigPath()} (${String(e)}); ` +
          `using defaults.\n`,
      );
    }
    return {};
  }
  try {
    return JSON.parse(raw) as PersistedConfig;
  } catch (e) {
    // Parse-error path is loud — a typo silently downgrading the user's
    // chosen backend was the bug A.04 addresses. Return {} to keep boot
    // resilient but surface the cause so users can fix the file.
    process.stderr.write(
      `[opensquid] rag-config parse failed at ${ragConfigPath()} (${String(e)}); ` +
        `using defaults — fix or delete the file to silence this warning.\n`,
    );
    return {};
  }
}

async function pickDefaultKind(): Promise<'loop-engine' | 'libsql-qwen3'> {
  try {
    const bin = await resolveEngineBin();
    if (bin) return 'loop-engine';
  } catch (e) {
    // Engine resolver failed unexpectedly — surface to stderr so users
    // can correlate "why is libsql active instead of the engine?" with
    // the underlying cause (corrupted engine-config.json, broken
    // executable, etc.) rather than guessing at the silent downgrade.
    process.stderr.write(
      `[opensquid] engine binary lookup failed (${String(e)}); ` +
        `falling back to libsql-qwen3.\n`,
    );
  }
  return 'libsql-qwen3';
}

function defaultLibsqlUrl(): string {
  return `file:${join(opensquidHome(), 'rag.sqlite')}`;
}
