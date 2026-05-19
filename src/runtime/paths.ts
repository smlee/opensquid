/**
 * Path resolution helpers for opensquid's filesystem layout.
 *
 * Layout (per `docs/opensquid-real-design.md` §"Phase 1 — Runtime skeleton"):
 *
 *   ~/.opensquid/
 *     sessions/<session-id>/
 *       state/
 *         <key>.json      — `write_state` / `read_state` primitives
 *         <name>.jsonl    — `append_log` primitive
 *
 * `OPENSQUID_HOME` env-var override is intentional: tests point it at
 * `os.tmpdir()` for filesystem isolation, and self-hosting deployments
 * may relocate state to a non-`$HOME` data directory.
 *
 * Always `path.join` — never raw string concat — so Windows backslashes
 * stay sane.
 *
 * Imported by: src/functions/state.ts.
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
