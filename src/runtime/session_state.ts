/**
 * Session-state helpers — per-session structured state that lives alongside
 * the `read_state` / `write_state` JSON files but is owned by the runtime
 * (not authored by packs).
 *
 * G.5 introduces the per-turn `tool_ledger`: an append-only list of tool
 * names observed by the `PreToolUse` hook during the current turn. The
 * ledger is the data source for the `session_tool_history` primitive
 * (`src/functions/session_tool_history.ts`), which feeds the freshness /
 * state-verification drift rule.
 *
 * Persistence model:
 *
 *   - Storage key: `sessionStateFile(sessionId, 'tool-ledger')`.
 *   - JSON shape: `{ turn: string[]; session: string[] }` where
 *     `turn` = tool names since the last `UserPromptSubmit` (reset on every
 *     prompt arrival) and `session` = up to 200 most-recent tool names
 *     across the whole session (sliding window).
 *   - ENOENT / malformed JSON → fresh empty ledger (eventual-consistency
 *     model lifted from `destination_scheduler.ts` — losing a few entries
 *     never blocks a tool call, which is the priority inside a hook bin).
 *
 * Trim policy: `session.length` is capped at 200 via a sliding window
 * applied on every `appendTool` write. This bounds the disk + parse cost
 * for long-running sessions without coordinating a separate trim job.
 *
 * Concurrency: hook bins run as short-lived subprocesses, one per host
 * tool-call. FC.1 (2026-06-01): all session-state writes publish atomically via
 * `atomicWriteFile` (tmp + rename) so concurrent writers (e.g. the active-task
 * mirror touched on overlapping events) can never tear/lose state — readers see
 * old-or-new, never partial.
 *
 * Imports from: node:fs/promises, node:path, ./atomic_write.js, ./paths.js.
 * Imported by: src/functions/session_tool_history.ts (read path);
 *   src/runtime/hooks/pre-tool-use.ts (append path);
 *   src/runtime/hooks/user-prompt-submit.ts (turn-reset path).
 */

import { readFile, rename, unlink } from 'node:fs/promises';

import { atomicWriteFile } from './atomic_write.js';

import { activeTaskArchiveFile, activeTaskFile, sessionStateFile } from './paths.js';
import type { RequestTypeRecord } from './request_type.js';
import { advanceTick, createTick } from './tick.js';
import type { Event } from './types.js';
import type { TickState } from './unload_conditions.js';

/** Max number of session-wide entries retained; trimmed on every write. */
export const SESSION_LEDGER_CAP = 200;

/** Well-known session-state key for the tool-call ledger. */
const LEDGER_KEY = 'tool-ledger';

export interface ToolLedger {
  turn: string[];
  session: string[];
  /** wg-3e241144f441: per-track research window. Reset at scope_start (the re-arm,
   *  via reset_scope_track_state), SURVIVES turn resets — so the SCOPE depth gate
   *  counts research across all of a track's scoping turns, not just the write-turn. */
  sinceScope: string[];
}

function emptyLedger(): ToolLedger {
  return { turn: [], session: [], sinceScope: [] };
}

async function readLedger(sessionId: string): Promise<ToolLedger> {
  try {
    const raw = await readFile(sessionStateFile(sessionId, LEDGER_KEY), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'turn' in parsed &&
      'session' in parsed &&
      Array.isArray((parsed as { turn: unknown }).turn) &&
      Array.isArray((parsed as { session: unknown }).session)
    ) {
      const turn = (parsed as { turn: unknown[] }).turn.filter(
        (x): x is string => typeof x === 'string',
      );
      const session = (parsed as { session: unknown[] }).session.filter(
        (x): x is string => typeof x === 'string',
      );
      // Backward-compatible: a pre-upgrade ledger has no `sinceScope` → default [].
      const rawSince = (parsed as { sinceScope?: unknown }).sinceScope;
      const sinceScope = Array.isArray(rawSince)
        ? rawSince.filter((x): x is string => typeof x === 'string')
        : [];
      return { turn, session, sinceScope };
    }
    return emptyLedger();
  } catch {
    return emptyLedger();
  }
}

async function writeLedger(sessionId: string, ledger: ToolLedger): Promise<void> {
  const path = sessionStateFile(sessionId, LEDGER_KEY);
  await atomicWriteFile(path, JSON.stringify(ledger, null, 2));
}

// Verbs whose every invocation only READS — the basis for crediting Bash research
// toward the SCOPE depth floor. Conservative allowlist; anything not here → not counted.
const READ_ONLY_VERBS = new Set<string>([
  'grep',
  'rg',
  'cat',
  'sed',
  'awk',
  'find',
  'head',
  'tail',
  'ls',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'jq',
  'stat',
  'file',
  'echo',
  'pwd',
]);

// An allowlisted verb can still mutate via a flag (`sed -i`, `find -delete/-exec`); reject those.
function segmentMutates(argv: string[]): boolean {
  const verb = argv[0];
  if (verb === 'sed' && argv.some((a) => a === '-i' || a.startsWith('-i'))) return true;
  if (
    verb === 'find' &&
    argv.some(
      (a) => a === '-delete' || a === '-exec' || a === '-execdir' || a.startsWith('-fprint'),
    )
  )
    return true;
  return false;
}

/**
 * Conservative, fail-closed: true only if EVERY pipeline/sequence segment is an allowlisted
 * read-only verb with no mutating flag AND the command has no output redirection. Anything
 * unrecognized → false (it simply doesn't count toward the SCOPE depth floor).
 */
export function isReadOnlyBash(command: string): boolean {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (trimmed === '') return false;
  if (/>>?/.test(trimmed)) return false; // any output redirection (incl. awk/tee writes)
  const segments = trimmed
    .split(/\|\||&&|;|\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  for (const seg of segments) {
    const argv = seg.split(/\s+/);
    const verb = argv[0];
    if (verb === undefined || !READ_ONLY_VERBS.has(verb)) return false;
    if (segmentMutates(argv)) return false;
  }
  return true;
}

/**
 * Append a tool name to both the current-turn list and the session-wide list. For a
 * read-only Bash command, an ADDITIVE `Bash:read-only` token is recorded alongside the
 * `Bash` token — the SCOPE depth filter counts it while every `Bash`-filtering consumer is
 * unaffected (the `Bash` token is still emitted). Session list is trimmed to the most-recent
 * `SESSION_LEDGER_CAP` entries on every write so it never grows unbounded.
 */
export async function appendTool(
  sessionId: string,
  toolName: string,
  command?: string,
): Promise<void> {
  const ledger = await readLedger(sessionId);
  const push = (name: string): void => {
    ledger.turn.push(name);
    ledger.session.push(name);
    ledger.sinceScope.push(name);
  };
  push(toolName);
  if (toolName === 'Bash' && typeof command === 'string' && isReadOnlyBash(command)) {
    push('Bash:read-only');
  }
  if (ledger.session.length > SESSION_LEDGER_CAP) {
    ledger.session = ledger.session.slice(-SESSION_LEDGER_CAP);
  }
  if (ledger.sinceScope.length > SESSION_LEDGER_CAP) {
    ledger.sinceScope = ledger.sinceScope.slice(-SESSION_LEDGER_CAP);
  }
  await writeLedger(sessionId, ledger);
}

// ---------------------------------------------------------------------------
// Session cwd pointer (MAU.3)
//
// The SessionEnd hook carries only the session id, but the memory reconcile it
// triggers needs the project cwd to resolve the auto-memory dir
// (`~/.claude/projects/<encoded-cwd>/memory/`). The PreToolUse hook DOES carry
// `cwd` on tool_call events, so it records the cwd here per session; SessionEnd
// reads it back. Best-effort, same eventual-consistency model as the ledger.
// ---------------------------------------------------------------------------

const CWD_KEY = 'cwd';

/** Record the session's working directory (called by PreToolUse on tool_call). */
export async function recordSessionCwd(sessionId: string, cwd: string): Promise<void> {
  const path = sessionStateFile(sessionId, CWD_KEY);
  await atomicWriteFile(path, cwd);
}

/** Read the session's recorded cwd, or `null` if absent/unreadable/empty. */
export async function readSessionCwd(sessionId: string): Promise<string | null> {
  try {
    const raw = (await readFile(sessionStateFile(sessionId, CWD_KEY), 'utf8')).trim();
    return raw === '' ? null : raw;
  } catch {
    return null;
  }
}

// wg-3d175ec06767: the per-prompt request-type classification, written once at the
// pre-dispatch chokepoint and read by enter-scoping + the stop guards. Keyed
// `'request-type'` so pack rules read it via read_state(key:'request-type').
const REQUEST_TYPE_KEY = 'request-type';

/** Persist the per-prompt request-type record (called by UPS before dispatch). */
export async function writeRequestType(sessionId: string, rec: RequestTypeRecord): Promise<void> {
  await atomicWriteFile(
    sessionStateFile(sessionId, REQUEST_TYPE_KEY),
    JSON.stringify(rec, null, 2),
  );
}

/** Read the current request-type record, or `null` if absent/unreadable. */
export async function readRequestType(sessionId: string): Promise<RequestTypeRecord | null> {
  try {
    return JSON.parse(
      await readFile(sessionStateFile(sessionId, REQUEST_TYPE_KEY), 'utf8'),
    ) as RequestTypeRecord;
  } catch {
    return null;
  }
}

/**
 * Generic reader for a pack-written session-state value (the JSON value a `write_state(key,value)`
 * primitive persisted), or `null` when absent/unreadable. Used by runtime code (e.g. RTC.4) to
 * check whether a pack record exists without going through the function registry.
 */
export async function readSessionStateValue(sessionId: string, key: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(sessionStateFile(sessionId, key), 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Write a session-state value (JSON-encoded, matching the `write_state` primitive's format). */
export async function writeSessionStateValue(
  sessionId: string,
  key: string,
  value: unknown,
): Promise<void> {
  await atomicWriteFile(sessionStateFile(sessionId, key), JSON.stringify(value, null, 2));
}

/**
 * Reset the current-turn list on `UserPromptSubmit`. The session-wide list
 * carries forward across turn boundaries — only the turn slice resets.
 * A missing ledger is created with an empty `turn` (no-op semantically).
 */
export async function resetTurnLedger(sessionId: string): Promise<void> {
  const ledger = await readLedger(sessionId);
  ledger.turn = [];
  await writeLedger(sessionId, ledger);
}

/** wg-3e241144f441: zero the per-track research window at scope_start (the re-arm).
 *  Called by reset_scope_track_state — `sinceScope` survives turn resets but resets
 *  when a NEW track begins, so the SCOPE depth gate measures research for THIS track. */
export async function resetScopeWindow(sessionId: string): Promise<void> {
  const ledger = await readLedger(sessionId);
  ledger.sinceScope = [];
  await writeLedger(sessionId, ledger);
}

/**
 * Read the tool ledger for the given scope. `current_turn` returns names
 * since the last `UserPromptSubmit`; `session` returns up to the most-recent
 * 200 names across the whole session. Returns `{ tools: [] }` on missing
 * or unreadable state.
 */
export async function readSessionToolLedger(
  sessionId: string,
  scope: 'current_turn' | 'session' | 'since_scope_start',
): Promise<{ tools: string[] }> {
  const ledger = await readLedger(sessionId);
  const tools =
    scope === 'current_turn'
      ? ledger.turn
      : scope === 'since_scope_start'
        ? ledger.sinceScope
        : ledger.session;
  return { tools: [...tools] };
}

// ---------------------------------------------------------------------------
// Active-task signal (AP.2)
//
// `active-task.json` is the "tasks-loaded" trigger the whole automation
// gate-set keys off (design rules #1/#8/#16). It is WRITTEN by the AP.1
// PreToolUse mirror (which reads the harness task store) — these helpers are
// the I/O lifecycle that the mirror, the SessionEnd archive, and the gate's
// read-side all share. Present file ⟺ an in-progress task exists. Same
// best-effort, no-throw-on-read model as the ledger/cwd above: a malformed or
// absent signal reads as `null` (no active task), never an exception inside a
// hook bin.
// ---------------------------------------------------------------------------

export interface ActiveTask {
  /** Harness numeric id (e.g. "15"). */
  id: string;
  subject: string;
  /** ISO timestamp the task became active. */
  started_at: string;
  /** Track id from the harness `metadata.taskId` (e.g. "AP.1"); Gate A (AP.5) keys on this. */
  taskId?: string;
  /** `docs/tasks` spec ref from `metadata.spec`, if the generator stamped it. */
  spec?: string;
}

/** Write the active-task signal (called by the AP.1 PreToolUse mirror). */
export async function writeActiveTask(sessionId: string, task: ActiveTask): Promise<void> {
  const path = activeTaskFile(sessionId);
  await atomicWriteFile(path, JSON.stringify(task, null, 2));
}

/** Read the active-task signal, or `null` if absent/unreadable/malformed (no throw). */
export async function readActiveTask(sessionId: string): Promise<ActiveTask | null> {
  try {
    const parsed = JSON.parse(await readFile(activeTaskFile(sessionId), 'utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { id: unknown }).id === 'string' &&
      typeof (parsed as { subject: unknown }).subject === 'string' &&
      typeof (parsed as { started_at: unknown }).started_at === 'string'
    ) {
      const o = parsed as Record<string, unknown>;
      return {
        id: o.id as string,
        subject: o.subject as string,
        started_at: o.started_at as string,
        ...(typeof o.taskId === 'string' ? { taskId: o.taskId } : {}),
        ...(typeof o.spec === 'string' ? { spec: o.spec } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Clear the active-task signal (task completed / none in progress). Ignores ENOENT. */
export async function clearActiveTask(sessionId: string): Promise<void> {
  try {
    await unlink(activeTaskFile(sessionId));
  } catch {
    /* already absent — nothing to clear */
  }
}

/**
 * Archive the active-task signal on SessionEnd (rule #16): rename rather than
 * delete, so an abandoned/in-progress task at session close leaves a trace
 * instead of vanishing. No-op when there is no active task. Best-effort.
 */
export async function archiveActiveTask(sessionId: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    await rename(activeTaskFile(sessionId), activeTaskArchiveFile(sessionId, stamp));
  } catch {
    /* absent (nothing to archive) or unreadable — never block session close */
  }
}

// ---------------------------------------------------------------------------
// Per-skill tick state (CU.1)
//
// `unloads_when` is evaluated against a per-skill `TickState` (turns since
// activation + task/session-end latches). The hooks that drive ticks
// (`PreToolUse`, `UserPromptSubmit`, `Stop`, `SessionEnd`) each run as a
// SEPARATE short-lived process per host event — so the tick map cannot live in
// an in-memory `Map`; it must persist between processes exactly like the
// tool-ledger / active-task signal above. We store it at
// `sessionStateFile(sessionId, 'skill-ticks')` as `Record<skillId, TickState>`.
//
// Same eventual-consistency model as the ledger: a malformed or absent file
// reads as `{}` (no ticks), never an exception inside a hook bin. The single
// source of truth for `TickState` is `unload_conditions.ts`; the advance
// transition is `tick.ts`'s `advanceTick` — both imported, never redefined.
// ---------------------------------------------------------------------------

/** Well-known session-state key for the per-skill tick map. */
const TICKS_KEY = 'skill-ticks';

/** Per-skill tick map: skill name → its current `TickState`. */
export type SkillTicks = Record<string, TickState>;

/** Narrow an unknown value to a `TickState` (all three fields present + typed). */
function isTickState(v: unknown): v is TickState {
  return (
    v !== null &&
    typeof v === 'object' &&
    typeof (v as TickState).turnsSinceActivation === 'number' &&
    typeof (v as TickState).taskCompleted === 'boolean' &&
    typeof (v as TickState).sessionEnded === 'boolean'
  );
}

/**
 * Read the per-skill tick map. Returns `{}` on an absent/unreadable/malformed
 * file (no throw — same best-effort model as the ledger). Each entry is
 * shape-validated; a malformed per-skill value is dropped (the others survive).
 */
export async function readSkillTicks(sessionId: string): Promise<SkillTicks> {
  try {
    const parsed = JSON.parse(
      await readFile(sessionStateFile(sessionId, TICKS_KEY), 'utf8'),
    ) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: SkillTicks = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isTickState(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Advance every CURRENTLY-LOADED skill's tick by one `event` and persist the
 * new map. The map after this call holds EXACTLY the skills in
 * `loadedSkillIds` — any skill no longer loaded (dropped from the set this
 * event, e.g. it unloaded or went out of scope) is removed.
 *
 * Per-skill base state:
 *   - no prior tick OR id ∈ `reactivated` → `createTick()` (fresh activation),
 *   - otherwise the prior persisted tick (carried forward),
 * then `advanceTick(base, event)` applies the event transition.
 *
 * `reactivated` = ids whose `when_to_load` freshly matched this event (CU.2
 * supplies the set); a re-activated skill restarts its idle counter from zero.
 */
export async function advanceSkillTicks(
  sessionId: string,
  event: Event,
  loadedSkillIds: readonly string[],
  reactivated: ReadonlySet<string> = new Set(),
): Promise<SkillTicks> {
  const prev = await readSkillTicks(sessionId);
  const next: SkillTicks = {};
  for (const id of loadedSkillIds) {
    const base = prev[id] === undefined || reactivated.has(id) ? createTick() : prev[id];
    next[id] = advanceTick(base, event);
  }
  const path = sessionStateFile(sessionId, TICKS_KEY);
  await atomicWriteFile(path, JSON.stringify(next, null, 2));
  return next;
}

/** Clear the per-skill tick map (e.g. on SessionEnd). Ignores ENOENT. */
export async function clearSkillTicks(sessionId: string): Promise<void> {
  try {
    await unlink(sessionStateFile(sessionId, TICKS_KEY));
  } catch {
    /* already absent — nothing to clear */
  }
}
