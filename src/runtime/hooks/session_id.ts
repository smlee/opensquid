/**
 * Session-id resolution for hook binaries + the `.current-session` pointer.
 *
 * ROOT-CAUSE FIX (2026-05-26): the `stop` / `user-prompt-submit` /
 * `pre-tool-use` hooks previously read the session id ONLY from
 * `process.env.CLAUDE_SESSION_ID`, which Claude Code does not reliably set —
 * it delivers `session_id` in the hook's stdin JSON payload (per the CC hook
 * contract). The result: every session collapsed to the literal `'unknown'`
 * bucket, so per-session state (the automation flag, the per-turn tool ledger)
 * never keyed on the real session. `session-end.ts` was the only hook reading
 * stdin correctly. `extractSessionId` centralizes the correct precedence:
 * stdin `session_id` (snake) → `sessionId` (camel) → `CLAUDE_SESSION_ID` env
 * (last-resort) → `'unknown'`.
 *
 * `.current-session` (at `OPENSQUID_HOME()/.current-session`) lets an
 * out-of-band process — notably the `opensquid automation on|off` CLI run from
 * a terminal that never receives the hook stdin — discover the live session id.
 * The `user-prompt-submit` hook records it every turn (best-effort).
 *
 * Imports from: node:fs/promises, node:path, ../paths.js.
 * Imported by: hooks/{stop,user-prompt-submit,pre-tool-use}.ts (resolve +
 *   record); setup/cli/automation.ts (read).
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { OPENSQUID_HOME, projectCurrentSessionPath, resolveProjectUuid } from '../paths.js';

interface SessionIdCarrier {
  session_id?: unknown;
  sessionId?: unknown;
}

/**
 * Resolve the session id from a hook's raw stdin string. Precedence:
 * stdin `session_id` → stdin `sessionId` → `CLAUDE_SESSION_ID` env → `'unknown'`.
 * Never throws: a malformed/empty payload falls straight through to the env /
 * `'unknown'` fallback so the calling hook stays fail-open.
 */
export function extractSessionId(raw: string): string {
  let obj: SessionIdCarrier = {};
  try {
    obj = JSON.parse(raw) as SessionIdCarrier;
  } catch {
    // fall through to env / 'unknown'
  }
  if (typeof obj.session_id === 'string' && obj.session_id !== '') return obj.session_id;
  if (typeof obj.sessionId === 'string' && obj.sessionId !== '') return obj.sessionId;
  const env = process.env.CLAUDE_SESSION_ID;
  if (env !== undefined && env !== '') return env;
  return 'unknown';
}

/** Absolute path of the live-session pointer file. */
export const currentSessionPath = (): string => join(OPENSQUID_HOME(), '.current-session');

/**
 * Record the live session id so out-of-band processes (the automation CLI) can
 * target the session the hooks actually see. Best-effort: never throws, and
 * never records the `'unknown'` sentinel (that would mislead the CLI).
 */
export async function recordCurrentSession(sessionId: string, cwd?: string): Promise<void> {
  // GF.2 — never record the synthetic sentinels: `unknown`/`''` (no real session) and
  // `doctor-probe` (the id `opensquid doctor hooks` spawns its probe events with — it would
  // otherwise CLOBBER the live `.current-session` pointer the git gate resolves against).
  if (sessionId === 'unknown' || sessionId === '' || sessionId === 'doctor-probe') return;
  try {
    await mkdir(OPENSQUID_HOME(), { recursive: true });
    // Global pointer — back-compat for the automation CLI + lessons.ts (which
    // read it without a project context). Last-writer-wins across all sessions.
    await writeFile(currentSessionPath(), sessionId, 'utf-8');
    // FU.3: project-scoped pointer — the race-free authority the MCP server
    // reads. A concurrent session in ANOTHER project writes a different uuid's
    // pointer and can't clobber this one. Skipped (no error) for a cwd that
    // isn't inside a uuid-bound project (`.opensquid/project.json` absent).
    if (cwd !== undefined && cwd !== '') {
      const uuid = await resolveProjectUuid({ cwd });
      if (uuid !== null) {
        const scoped = projectCurrentSessionPath(uuid);
        await mkdir(dirname(scoped), { recursive: true });
        await writeFile(scoped, sessionId, 'utf-8');
      }
    }
  } catch {
    // best-effort: a write failure must never break the hook
  }
}

/** Read the global live session id, or `null` if absent/unreadable/empty. */
export async function readCurrentSession(): Promise<string | null> {
  try {
    const raw = (await readFile(currentSessionPath(), 'utf-8')).trim();
    return raw === '' ? null : raw;
  } catch {
    return null;
  }
}

/** Read the project-scoped live session id, or `null` if absent/unreadable/empty. */
export async function readProjectCurrentSession(projectUuid: string): Promise<string | null> {
  try {
    const raw = (await readFile(projectCurrentSessionPath(projectUuid), 'utf-8')).trim();
    return raw === '' ? null : raw;
  } catch {
    return null;
  }
}

/**
 * FU.7 — does `sessions/<id>/` exist? The existence of the per-session dir
 * (created by the session's own hooks when they first write state) is the
 * signal that an id is a REAL persisted session, not a stale/`--resume` env id.
 * Fail-false on any stat error (absent dir → ENOENT → false).
 */
async function sessionDirExists(id: string): Promise<boolean> {
  try {
    return (await stat(join(OPENSQUID_HOME(), 'sessions', id))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Session resolution for MCP tools (the MCP server is a separate process from
 * the hooks, so it can't read hook stdin).
 *
 * T-RJ-FOLLOWUPS FU.3 (2026-06-01) — CORRECTION to MS.1. MS.1 assumed Claude
 * Code sets `CLAUDE_SESSION_ID` in the MCP server's env; it does NOT — that
 * exact name is never set, so the env step never fired and resolution always
 * fell through to the GLOBAL `.current-session`, which any concurrent session in
 * any project clobbers (last-writer-wins) — silently breaking this session's
 * `log_phase` mid-task.
 *
 * FU.4 correction: CC DOES expose a session-id env var to stdio MCP servers —
 * `CLAUDE_CODE_SESSION_ID` (plus `CLAUDE_PROJECT_DIR`). But it is NOT safe to key
 * on: under `--resume` it holds a NEW id that differs from the persisted /
 * transcript / hook-stdin id the state actually lives under (observed live:
 * env `6c7527de…` while state + transcript were under `1200bc00…`, whose
 * `sessions/<id>/` dir is the real one). So resolving by the env session id
 * would point at an EMPTY session under resume. The project-scoped pointer is
 * correct precisely because the UPS hook writes it with the hook-stdin id — the
 * same id the state uses. (Using `CLAUDE_CODE_SESSION_ID` *guarded by
 * `sessions/<id>/` existence* to also kill the same-project race is FU.7.)
 *
 * Fix: resolve via the PROJECT-SCOPED pointer, keyed by `CLAUDE_PROJECT_DIR`
 * (which CC DOES provide) → `resolveProjectUuid`. A concurrent session in
 * another repo writes a different project's pointer and can't clobber this one.
 *
 * ⚠️ Residual (documented, not solved here): two concurrent CC sessions in the
 * SAME project still share one project pointer and race. Rare; a
 * most-recently-active-task tiebreak is a follow-up.
 *
 * Precedence:
 *   1. `process.env.CLAUDE_SESSION_ID` (kept — harmless if CC ever sets it)
 *   2. `process.env.OPENSQUID_SESSION_ID` (override / test seam)
 *   3. `process.env.CLAUDE_CODE_SESSION_ID` GUARDED by `sessions/<id>/` existence
 *      (FU.7) — CC's per-process id. When its session dir exists it is a real
 *      persisted session, which disambiguates two concurrent sessions in the
 *      SAME repo (distinct per-process ids → distinct dirs). Under `--resume`
 *      the env id is NEW and has no dir → the guard fails → fall through (safe).
 *   4. project-scoped pointer via `CLAUDE_PROJECT_DIR`→`resolveProjectUuid`
 *      (race-free across projects — the real fix)
 *   5. global `.current-session` (back-compat: single-session / no-project cwd)
 */
export async function resolveMcpSessionId(): Promise<string | null> {
  const env = process.env;
  const fromClaudeEnv = env.CLAUDE_SESSION_ID;
  if (fromClaudeEnv !== undefined && fromClaudeEnv.length > 0) return fromClaudeEnv;
  const fromOpensquidEnv = env.OPENSQUID_SESSION_ID;
  if (fromOpensquidEnv !== undefined && fromOpensquidEnv.length > 0) return fromOpensquidEnv;
  // FU.7 — CC's per-process id, but ONLY when its session dir exists on disk
  // (proves it's the id state actually lives under). Dir-less → --resume's new
  // id → ignore, fall through to the project pointer.
  const ccEnv = env.CLAUDE_CODE_SESSION_ID;
  if (ccEnv !== undefined && ccEnv.length > 0 && (await sessionDirExists(ccEnv))) return ccEnv;
  const projectDir = env.CLAUDE_PROJECT_DIR;
  if (projectDir !== undefined && projectDir.length > 0) {
    const uuid = await resolveProjectUuid({ cwd: projectDir, env });
    if (uuid !== null) {
      const scoped = await readProjectCurrentSession(uuid);
      if (scoped !== null) return scoped;
    }
  }
  return readCurrentSession();
}
