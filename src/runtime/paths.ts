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

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
// `packs/` are active. `discoverActivePacks(scopeRoot)` consumes the result
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
 * BPDISC — Returns the built-in pack scope root: the directory whose
 * `<root>/<name>/manifest.yaml` paths hold the packs that ship inside the
 * opensquid npm install (`packs/builtin/`). When a user's `active.json`
 * names a pack not found under user or project scope, the loader falls back
 * to this root. Mirrors the OPENSQUID_HOME pattern: `OPENSQUID_BUILTIN_PACKS_ROOT`
 * env var wins for test isolation; otherwise the path is computed relative
 * to the dist file location at module import time.
 *
 * From a dist file at `<npm-root>/dist/runtime/paths.js`, the built-in
 * packs sit at `<npm-root>/packs/builtin/` — three dirs up + `packs/builtin`.
 * Works for both the local checkout layout (`src/runtime/paths.ts` → up to
 * `opensquid/packs/builtin/`) and the npm-install layout (`node_modules/opensquid/dist/...`).
 */
export const resolveBuiltinScopeRoot = (): string => {
  const envOverride = process.env.OPENSQUID_BUILTIN_PACKS_ROOT;
  if (envOverride !== undefined && envOverride.length > 0) return envOverride;
  const here = fileURLToPath(import.meta.url);
  // dist/runtime/paths.js → dist/runtime → dist → <npm-root> → <npm-root>/packs/builtin
  return resolve(dirname(here), '..', '..', 'packs', 'builtin');
};

/**
 * Walks up from `cwd` looking for a `.opensquid/` directory. Returns its
 * absolute path on first hit, or `null` if the walk reaches the filesystem
 * root without finding one (no project scope in effect).
 *
 * The 64-level cap protects against pathological symlink cycles. Real
 * project trees bottom out well before 64 levels.
 *
 * Important: this probes for the `.opensquid/` DIRECTORY's existence, NOT
 * the `.opensquid/project.json` FILE. The two walks have different purposes
 * (this one answers "is there pack config here?"; `walkForProjectUuid`
 * below answers "is there a UUID-bound project here?"). Both share the
 * 64-level cap discipline.
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

// ---------------------------------------------------------------------------
// Project-UUID resolution (T-PUC)
//
// The `.opensquid/project.json` file (legacy schema `{ version: 1, id, uuid }`)
// is how opensquid identifies a "UUID-bound project" — the unit of per-project
// state (chat inbox, chat-routing.json, agent-bridge daemon binding). The
// resolution chain is uniform across every consumer: env override
// (OPENSQUID_PROJECT_UUID) takes precedence over the cwd-walk; if neither
// returns, the caller reports "no project" and exits.
//
// Three exports — lower-level helpers + a combinator — so callers that need
// just one stage (e.g. `chat watch` layers a CLI-flag override on top of the
// env stage) compose without re-implementing.
// ---------------------------------------------------------------------------

/** The `.opensquid/project.json` schema. `version` is the on-disk discriminator. */
export interface ProjectCard {
  version: 1;
  id: string;
  uuid: string;
}

/**
 * Env-only project-UUID lookup. Returns the value of `OPENSQUID_PROJECT_UUID`
 * if set + non-empty, else `null`. Synchronous — no I/O.
 *
 * Defaults to `process.env` when called without an argument; the optional
 * `env` parameter exists for test injection.
 */
export function resolveProjectUuidFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.OPENSQUID_PROJECT_UUID;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return null;
}

/**
 * Walks up from `startDir` looking for `.opensquid/project.json`. Returns
 * the parsed `uuid` on first hit (strict schema check: `version === 1 &&
 * uuid && id`), or `null` when the walk exhausts the 64-level cap or
 * reaches the filesystem root without a valid card.
 *
 * Malformed JSON, missing fields, and version mismatches all silently
 * continue the walk — a bad ancestor card must not mask a good descendant
 * one, and the same file might be valid under a different `version`-future
 * revision that this consumer doesn't recognize.
 */
export async function walkForProjectUuid(startDir: string): Promise<string | null> {
  let dir = resolve(startDir);
  for (let i = 0; i < 64; i++) {
    const candidate = join(dir, '.opensquid', 'project.json');
    try {
      const raw = await readFile(candidate, 'utf8');
      const parsed = JSON.parse(raw) as ProjectCard;
      if (parsed?.version === 1 && parsed.uuid && parsed.id) return parsed.uuid;
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Canonical combinator: env-first then cwd-walk. The pattern 5 call sites
 * reimplemented before T-PUC consolidated them.
 *
 * Returns the first non-null source, else `null`. `env` defaults to
 * `process.env` when omitted; `cwd` is required (callers always know which
 * directory to walk from — there is no sensible default).
 */
export async function resolveProjectUuid(opts: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string | null> {
  const fromEnv = resolveProjectUuidFromEnv(opts.env);
  if (fromEnv !== null) return fromEnv;
  return walkForProjectUuid(opts.cwd);
}

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
// Chat-transport daemon side-files (T-CHAT-AS-TERMINAL CAT.1b).
//
// The rebuilt chat-transport daemon (src/channels/daemon/) owns three
// side-files inside `OPENSQUID_HOME()`, mirroring the SCHED.1 daemon helpers
// above but namespaced `chat-daemon.*` so the two daemons never collide on a
// pidfile/socket:
//
//   - `chat-daemon.sock`  Unix-socket the outbound `send` JSON-RPC listens on.
//                         Consumed live by src/mcp/chat-bridge-server.ts +
//                         src/runtime/agent_bridge/tools/chat_send.ts — the
//                         path must stay byte-identical to those callers'
//                         `join(root, 'chat-daemon.sock')`. Windows uses a
//                         named pipe instead (no filesystem residue); the
//                         protocol module derives it.
//   - `chat-daemon.pid`   worker pid, written on boot + removed on clean exit.
//   - `chat-daemon.log`   detached-spawn stdout/stderr target.
//
// All three honor the `OPENSQUID_HOME` override so tests boot a daemon in an
// `mkdtemp` without touching the developer's home dir.
// ---------------------------------------------------------------------------

export const chatDaemonSockPath = (): string => join(OPENSQUID_HOME(), 'chat-daemon.sock');
export const chatDaemonPidPath = (): string => join(OPENSQUID_HOME(), 'chat-daemon.pid');
export const chatDaemonLogPath = (): string => join(OPENSQUID_HOME(), 'chat-daemon.log');

// ---------------------------------------------------------------------------
// Per-project chat inbox. The chat-daemon appends one inbound message per line
// to `<home>/projects/<uuid>/inbox/<platform>.jsonl` (the on-disk contract the
// agent_bridge + `chat watch` both consume). Honors OPENSQUID_HOME so tests
// and self-hosting relocate it with the rest of the layout.
// ---------------------------------------------------------------------------

export const inboxFile = (projectUuid: string, platform: string): string =>
  join(OPENSQUID_HOME(), 'projects', projectUuid, 'inbox', `${platform}.jsonl`);

// LL.1 (2026-05-30) — sibling helpers for the inbox directory + ack ledger.
// `inboxDir` is the parent of the per-platform JSONL files; `inboxAckedPath`
// is the per-project append-only ack ledger consumed by LL.4's UPS hook.
export const inboxDir = (projectUuid: string): string =>
  join(OPENSQUID_HOME(), 'projects', projectUuid, 'inbox');

export const inboxAckedPath = (projectUuid: string): string =>
  join(OPENSQUID_HOME(), 'projects', projectUuid, 'inbox', 'acked.jsonl');

// Live-session lease: while `chat watch` runs for a project, it heartbeats this
// file so the always-on agent-bridge daemon can tell a live interactive session
// is handling the project and stay silent (cross-session arbitration, T-DEL).
export const liveSessionLease = (projectUuid: string): string =>
  join(OPENSQUID_HOME(), 'projects', projectUuid, 'live-session.lease');

// T-RJ-FOLLOWUPS FU.3 (2026-06-01) — project-scoped live-session pointer. The
// UPS hook writes the real session id here (keyed by project), and the MCP
// server reads it via `CLAUDE_PROJECT_DIR`→`resolveProjectUuid`. Race-free
// across projects: a concurrent session in ANOTHER repo writes a DIFFERENT
// project's pointer and can't clobber this one (the global `.current-session`
// is last-writer-wins across all sessions; this is not).
export const projectCurrentSessionPath = (projectUuid: string): string =>
  join(OPENSQUID_HOME(), 'projects', projectUuid, '.current-session');

// ---------------------------------------------------------------------------
// Umbrella chat inbox (T-CHAT-AS-TERMINAL CAT.1b/1c). The rebuilt chat-daemon
// keys the inbox + lease by UMBRELLA id (`loop`, `raumpilates-fe`, the reserved
// `general`) instead of per-cwd project_uuid — one umbrella ↔ one chat session
// (invariants #2/#4), which also retires the da96≡0742 mirror. Same on-disk row
// + lease shapes as the project-keyed helpers above; only the key changes.
// Orphan (unrouted-at-transport) messages keep the legacy top-level location.
// ---------------------------------------------------------------------------

export const umbrellaInboxFile = (umbrellaId: string, platform: string): string =>
  join(OPENSQUID_HOME(), 'umbrellas', umbrellaId, 'inbox', `${platform}.jsonl`);

export const umbrellaInboxDir = (umbrellaId: string): string =>
  join(OPENSQUID_HOME(), 'umbrellas', umbrellaId, 'inbox');

export const umbrellaInboxAckedPath = (umbrellaId: string): string =>
  join(OPENSQUID_HOME(), 'umbrellas', umbrellaId, 'inbox', 'acked.jsonl');

export const umbrellaLiveSessionLease = (umbrellaId: string): string =>
  join(OPENSQUID_HOME(), 'umbrellas', umbrellaId, 'live-session.lease');

export const umbrellaCurrentSessionPath = (umbrellaId: string): string =>
  join(OPENSQUID_HOME(), 'umbrellas', umbrellaId, '.current-session');

// Transport-level orphan inbox: a message that resolves to no umbrella
// (`resolveInboundUmbrella` → null). Kept at the legacy top-level path so the
// existing orphan-audit tooling keeps working.
export const orphanInboxFile = (platform: string): string =>
  join(OPENSQUID_HOME(), 'inbox', 'orphan', `${platform}.jsonl`);
