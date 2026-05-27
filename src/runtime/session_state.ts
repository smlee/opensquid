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
 * tool-call. Concurrent writes to the same session ledger are rare (the
 * host serializes its own tool calls). We use mkdir-then-writeFile, no
 * atomic rename — same trade-off the destination scheduler makes.
 *
 * Imports from: node:fs/promises, node:path, ./paths.js.
 * Imported by: src/functions/session_tool_history.ts (read path);
 *   src/runtime/hooks/pre-tool-use.ts (append path);
 *   src/runtime/hooks/user-prompt-submit.ts (turn-reset path).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { sessionStateFile } from './paths.js';

/** Max number of session-wide entries retained; trimmed on every write. */
export const SESSION_LEDGER_CAP = 200;

/** Well-known session-state key for the tool-call ledger. */
const LEDGER_KEY = 'tool-ledger';

export interface ToolLedger {
  turn: string[];
  session: string[];
}

function emptyLedger(): ToolLedger {
  return { turn: [], session: [] };
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
      return { turn, session };
    }
    return emptyLedger();
  } catch {
    return emptyLedger();
  }
}

async function writeLedger(sessionId: string, ledger: ToolLedger): Promise<void> {
  const path = sessionStateFile(sessionId, LEDGER_KEY);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(ledger, null, 2), 'utf8');
}

/**
 * Append a tool name to both the current-turn list and the session-wide
 * list. Session list is trimmed to the most-recent `SESSION_LEDGER_CAP`
 * entries on every write so it never grows unbounded.
 */
export async function appendTool(sessionId: string, toolName: string): Promise<void> {
  const ledger = await readLedger(sessionId);
  ledger.turn.push(toolName);
  ledger.session.push(toolName);
  if (ledger.session.length > SESSION_LEDGER_CAP) {
    ledger.session = ledger.session.slice(-SESSION_LEDGER_CAP);
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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, cwd, 'utf8');
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

/**
 * Read the tool ledger for the given scope. `current_turn` returns names
 * since the last `UserPromptSubmit`; `session` returns up to the most-recent
 * 200 names across the whole session. Returns `{ tools: [] }` on missing
 * or unreadable state.
 */
export async function readSessionToolLedger(
  sessionId: string,
  scope: 'current_turn' | 'session',
): Promise<{ tools: string[] }> {
  const ledger = await readLedger(sessionId);
  return { tools: scope === 'current_turn' ? [...ledger.turn] : [...ledger.session] };
}
