/**
 * Path resolution helpers for opensquid's filesystem layout.
 *
 * Layout (per `docs/opensquid-real-design.md` §"Phase 1 — Runtime skeleton"
 * + §"Phases 2–7 summary" Phase 5):
 *
 *   ~/.opensquid/
 *     sessions/<session-id>/
 *       state/
 *         <key>.json      — `write_state` / `read_state` primitives
 *         <name>.jsonl    — `append_log` primitive
 *     packs/<pack-id>/
 *       state/
 *         <key>.json      — per-pack state (Task 5.3)
 *         <name>.jsonl    — per-pack logs (e.g. drift-catalog.jsonl)
 *
 * `OPENSQUID_HOME` env-var override is intentional: tests point it at
 * `os.tmpdir()` for filesystem isolation, and self-hosting deployments
 * may relocate state to a non-`$HOME` data directory.
 *
 * Always `path.join` — never raw string concat — so Windows backslashes
 * stay sane.
 *
 * Imported by: src/functions/state.ts, src/runtime/drift_catalog.ts.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export const OPENSQUID_HOME = (): string =>
  process.env.OPENSQUID_HOME ?? join(homedir(), '.opensquid');

export const sessionStateDir = (sessionId: string): string =>
  join(OPENSQUID_HOME(), 'sessions', sessionId, 'state');

export const sessionStateFile = (sessionId: string, key: string): string =>
  join(sessionStateDir(sessionId), `${key}.json`);

export const sessionLogFile = (sessionId: string, name: string): string =>
  join(sessionStateDir(sessionId), `${name}.jsonl`);

// ---------------------------------------------------------------------------
// Per-pack state paths (Task 5.3)
//
// Isolates each pack's `read_state` / `write_state` namespace under
// `~/.opensquid/packs/<id>/state/`. Pack id is sanitized to block path
// traversal: every non-`[a-zA-Z0-9_-]` character is replaced with `_`, so
// `../etc/passwd` resolves to `___etc_passwd` and stays inside the pack
// state root. The sanitization is intentionally aggressive — even `.` (no
// hidden dirs) and `/` (no nested subpaths) collapse to `_`. Pack ids that
// validate as plain identifiers in the manifest schema are unaffected.
//
// Trade-off: two distinct pack ids that differ only in non-safe characters
// (e.g. `foo.bar` and `foo_bar`) collide on the filesystem. The validation
// layer should reject such conflicts at load time; this helper is the
// last-line defense against traversal, not the first.
// ---------------------------------------------------------------------------

const sanitizePackId = (packId: string): string => packId.replace(/[^a-zA-Z0-9_-]/g, '_');

export const packStateDir = (packId: string): string =>
  join(OPENSQUID_HOME(), 'packs', sanitizePackId(packId), 'state');

export const packStateFile = (packId: string, key: string): string =>
  join(packStateDir(packId), `${key}.json`);

export const packLogFile = (packId: string, name: string): string =>
  join(packStateDir(packId), `${name}.jsonl`);
