/**
 * Plausibility probe for a session id resolved from a stale-prone source
 * (`.current-session` pointer). Stat-driven freshness check over the files
 * the live PreToolUse hook continuously updates — `<home>/sessions/<id>/
 * active-task.json` (mirror) and `state/tool-ledger.json` (per-tool append).
 * Either one modified within `FRESH_MS` = live; both absent / older = stale.
 *
 * Caller (`automation.ts:resolveSessionId`) hard-fails on stale unless the
 * user passes `--force` — the escape hatch for cases where the CLI is run
 * before the first hook fires (otherwise legitimate; the `automation on` /
 * `--session-id <id>` paths already bypass this probe entirely).
 *
 * The probe NEVER throws: an unreadable file is treated as "absent" so the
 * loud-warn path catches a corrupted state dir too. It is also pure —
 * no writes, no side effects, no env reads beyond `FRESH_MS()`.
 *
 * Imports from: node:fs/promises, ../paths.js.
 * Imported by: src/setup/cli/automation.ts (the gate that uses it).
 */

import { stat } from 'node:fs/promises';

import { activeTaskFile, sessionStateFile } from '../paths.js';

/** Default freshness window: 30 minutes (`1_800_000` ms). */
export const DEFAULT_FRESH_MS = 1_800_000;

/**
 * Resolve the freshness threshold from env, falling back to `DEFAULT_FRESH_MS`
 * for unset / non-positive / non-numeric values. Read on every call (cheap,
 * lets a wrapper script tune the window mid-session without re-import).
 */
export function FRESH_MS(): number {
  const raw = process.env.OPENSQUID_SESSION_FRESH_MS;
  if (raw === undefined || raw === '') return DEFAULT_FRESH_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FRESH_MS;
}

export interface PlausibilityResult {
  /** `true` iff at least one probed file was modified within the window. */
  plausible: boolean;
  /** Most-recent mtime ms across probed files, or `null` if none readable. */
  newestMtimeMs: number | null;
  /** Absolute paths probed — surfaced in the CLI's stderr for actionability. */
  probedFiles: string[];
}

export interface PlausibilityOpts {
  /** Injected clock (tests). Defaults to `Date.now`. */
  nowMs?: () => number;
  /** Override the freshness window for one call (tests). Defaults to `FRESH_MS()`. */
  freshMs?: number;
}

/**
 * "Was this session id alive within the freshness window?" — yes iff any of
 * the probed files has mtime within `freshMs` of `now`. Files missing or
 * unreadable count as absent (NOT as errors); they just don't contribute a
 * mtime.
 */
export async function isSessionPlausible(
  sessionId: string,
  opts: PlausibilityOpts = {},
): Promise<PlausibilityResult> {
  const now = (opts.nowMs ?? Date.now)();
  const fresh = opts.freshMs ?? FRESH_MS();
  // `tool-ledger` is written via `sessionStateFile` (suffix `.json`) per
  // `runtime/session_state.ts:50,88` (LEDGER_KEY). It is NOT a JSONL log —
  // do not reach for `sessionLogFile`, that would resolve to `.jsonl` and
  // miss the real file.
  const probedFiles = [activeTaskFile(sessionId), sessionStateFile(sessionId, 'tool-ledger')];

  let newestMtimeMs: number | null = null;
  for (const f of probedFiles) {
    try {
      const st = await stat(f);
      const m = st.mtimeMs;
      if (newestMtimeMs === null || m > newestMtimeMs) newestMtimeMs = m;
    } catch {
      // ENOENT / EACCES / etc. — treat as absent.
    }
  }
  const plausible = newestMtimeMs !== null && now - newestMtimeMs < fresh;
  return { plausible, newestMtimeMs, probedFiles };
}
