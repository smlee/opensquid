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

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const OPENSQUID_HOME = (): string =>
  process.env.OPENSQUID_HOME ?? join(homedir(), '.opensquid');

// ---------------------------------------------------------------------------
// Scope-root resolvers (G.1)
//
// opensquid pack discovery has two installation scopes (per G.1 spec
// §"Pre-verified facts" pack-architecture-is-2D bullet):
//
//   - user scope    = `OPENSQUID_HOME()`           (`~/.opensquid/` by default)
//   - project scope = `<project>/.opensquid/`      (walked from cwd upward)
//
// Each scope root may contain an `active.json` declaring which folders under
// `codexes/` are active. `discoverActivePacks(scopeRoot)` consumes the result
// of these resolvers; null means "this scope is not in effect (no project
// root found walking up from cwd)".
//
// `resolveUserScopeRoot()` is a thin alias around `OPENSQUID_HOME()` for
// naming symmetry with the project-scope helper. The `OPENSQUID_HOME` env
// override remains the single way tests redirect user-scope I/O — do NOT
// duplicate the env-override logic here.
// ---------------------------------------------------------------------------

/**
 * Returns the user-scope opensquid root (`~/.opensquid/` by default; honors
 * `OPENSQUID_HOME` env override). Always returns a path; the directory may
 * not exist yet (`discoverActivePacks` treats absent active.json as empty).
 */
export const resolveUserScopeRoot = (): string => OPENSQUID_HOME();

/**
 * Walks up from `cwd` looking for a `.opensquid/` directory. Returns its
 * absolute path on first hit, or `null` if the walk reaches the filesystem
 * root without finding one (no project scope in effect).
 *
 * 64-level cap mirrors the cwd walk in
 * `src/runtime/agent_bridge/cli.ts:walkForProjectUuid` — protects against
 * pathological symlink cycles. In practice, real project trees bottom out
 * well before 64 levels.
 *
 * Important: this probes for the `.opensquid/` DIRECTORY's existence, NOT
 * the agent_bridge's `.opensquid/project.json` file. The two walks have
 * different purposes (G.1 walks for "is there pack config here?";
 * agent_bridge walks for "is there a UUID-bound project here?").
 */
export const resolveProjectScopeRoot = async (cwd: string): Promise<string | null> => {
  let dir = resolve(cwd);
  for (let i = 0; i < 64; i++) {
    const candidate = join(dir, '.opensquid');
    try {
      const st = await stat(candidate);
      if (st.isDirectory()) return candidate;
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

export const sessionStateDir = (sessionId: string): string =>
  join(OPENSQUID_HOME(), 'sessions', sessionId, 'state');

export const sessionStateFile = (sessionId: string, key: string): string =>
  join(sessionStateDir(sessionId), `${key}.json`);

export const sessionLogFile = (sessionId: string, name: string): string =>
  join(sessionStateDir(sessionId), `${name}.jsonl`);

/**
 * The active-task signal file (AP.2). Lives at the session ROOT, deliberately
 * NOT under `state/`: `state/` holds pack-authored `read_state`/`write_state`
 * keys, and the active-task signal is runtime-owned — keeping it at the root
 * prevents a pack's `write_state` from clobbering the gate's trigger. Absent
 * file = no active task (the "tasks-loaded" signal is off).
 */
export const activeTaskFile = (sessionId: string): string =>
  join(OPENSQUID_HOME(), 'sessions', sessionId, 'active-task.json');

/** Archive destination for the active-task file on SessionEnd (rule #16 — archive, never silently drop). */
export const activeTaskArchiveFile = (sessionId: string, stamp: string): string =>
  join(OPENSQUID_HOME(), 'sessions', sessionId, `active-task.${stamp}.archived.json`);

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

// ---------------------------------------------------------------------------
// Daemon paths (SCHED.1)
//
// The unified daemon process (`OpenSquidDaemon`) owns three side-files inside
// `OPENSQUID_HOME()`:
//
//   - `daemon.lock`     proper-lockfile target. We hand `realpath: false`
//                       to the lock call so the file itself doesn't need to
//                       exist on disk — only the `${path}.lock` directory
//                       that proper-lockfile creates atomically via mkdir.
//
//   - `daemon.pid`      ASCII process id written by `start()`, removed by
//                       `stop()`. The CLI's `daemon status` verb reads this
//                       to report PID + uptime without needing IPC.
//
//   - `daemon.log`      stdout/stderr rotation target (wired by SCHED.x UI
//                       integration; the path helper is here for symmetry).
//
// All three sit under `OPENSQUID_HOME()` so the `OPENSQUID_HOME` env-var
// override extends to daemon state — tests point `OPENSQUID_HOME` at an
// `mkdtemp` and a fresh daemon can boot in isolation without polluting the
// developer's home directory.
// ---------------------------------------------------------------------------

export const daemonLockPath = (): string => join(OPENSQUID_HOME(), 'daemon.lock');
export const daemonPidPath = (): string => join(OPENSQUID_HOME(), 'daemon.pid');
export const daemonLogPath = (): string => join(OPENSQUID_HOME(), 'daemon.log');

// ---------------------------------------------------------------------------
// Per-project chat inbox. The chat-daemon appends one inbound message per line
// to `<home>/projects/<uuid>/inbox/<platform>.jsonl` (the on-disk contract the
// agent_bridge + `chat watch` both consume). Honors OPENSQUID_HOME so tests
// and self-hosting relocate it with the rest of the layout.
// ---------------------------------------------------------------------------

export const inboxFile = (projectUuid: string, platform: string): string =>
  join(OPENSQUID_HOME(), 'projects', projectUuid, 'inbox', `${platform}.jsonl`);
