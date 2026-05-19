/**
 * Destination-check scheduler — periodic tick counter for destination_check
 * rules.
 *
 * Per `docs/opensquid-real-design.md` §"Destination-check" + §"Phases 2–7
 * summary": destination_check rules fire every N tool calls (not every
 * tool call). The scheduler maintains a per-rule counter in session-scoped
 * state, increments it on each tool_call event, and reports which rules
 * are "due" so the caller (the pre-tool-use hook in a later wiring task)
 * can invoke `check_destination` on just those rules.
 *
 * Counting semantics:
 *
 *   - Only `tool_call` events should drive the counter. Other event kinds
 *     (`prompt_submit`, `stop`, `session_end`) do NOT tick. Callers must
 *     gate their invocation on event kind; this module trusts that and
 *     unconditionally ticks every time it's called.
 *
 *   - A rule with `interval.every_n_tool_calls = N` fires on the Nth tool
 *     call after a fresh start (or after the previous fire). On fire, the
 *     counter resets to 0 so the next firing requires another N ticks.
 *
 *   - Rules are keyed `${pack.name}::${skill.name}::${rule.id}` so multiple
 *     packs / skills / rules with the same `id` stay isolated. The key is
 *     also the value returned in the `dueRules` list, so callers can index
 *     back into their pack tree.
 *
 * Persistence:
 *
 *   - Counters live at `sessionStateFile(sessionId, 'destination-counters')`
 *     — a JSON file inside the session's state dir. ENOENT on first read
 *     yields a fresh `{ byRule: {} }`.
 *
 *   - Writes use mkdir-then-writeFile (no atomic rename in Phase 4 —
 *     concurrent hook invocations against the same session are rare in
 *     practice, and `proper-lockfile` is deferred per the task spec's risk
 *     callout). If a corrupted JSON ever surfaces, the read swallows it
 *     and re-initialises the counter to zero, accepting the eventual-
 *     consistency cost.
 *
 *   - JSON.parse failures (corrupted file) fall through the same catch
 *     as ENOENT — the safer behaviour is "reset rather than crash the
 *     hook binary mid-tool-call". Callers don't see the difference.
 *
 * Imports from: node:fs/promises, node:path, ./paths.js, ./types.js.
 * Imported by: src/runtime/index.ts (re-export); future pre-tool-use hook
 * wiring (call sites land alongside the in-process registry dispatch).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { sessionStateFile } from './paths.js';
import type { Pack } from './types.js';

// ---------------------------------------------------------------------------
// CounterState — JSON shape persisted to disk.
//
// `byRule[key]` is the count of tool_call events SINCE the last fire (or
// since session start). On fire, the entry resets to 0. Missing keys
// (never-ticked rules) read as 0 — `??` guard below.
// ---------------------------------------------------------------------------

interface CounterState {
  byRule: Record<string, number>;
}

// ---------------------------------------------------------------------------
// COUNTERS_KEY — the well-known key used with `sessionStateFile`. Hoisted to
// a constant so it's a single point of change if the layout ever migrates
// (e.g., per-pack subdirectories in Phase 5).
// ---------------------------------------------------------------------------

const COUNTERS_KEY = 'destination-counters';

// ---------------------------------------------------------------------------
// readCounters — load the persisted counter map for this session.
//
// Any error (ENOENT, malformed JSON, permission) yields a fresh empty map.
// This is intentional: the scheduler runs inside a hook binary that should
// never crash mid-tool-call. Losing a few counters is preferable to
// crashing the host agent. Disk corruption is also self-healing — the next
// successful write replaces the bad file.
// ---------------------------------------------------------------------------

async function readCounters(sessionId: string): Promise<CounterState> {
  try {
    const raw = await readFile(sessionStateFile(sessionId, COUNTERS_KEY), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'byRule' in parsed &&
      typeof parsed.byRule === 'object' &&
      parsed.byRule !== null
    ) {
      // Cast `parsed.byRule` to a `Record<string, number>` view — the
      // structural check above confirms it's a non-null object; per-key
      // value validation is deferred to read sites (which `?? 0`-guard
      // non-number entries).
      return { byRule: { ...(parsed.byRule as Record<string, number>) } };
    }
    return { byRule: {} };
  } catch {
    return { byRule: {} };
  }
}

// ---------------------------------------------------------------------------
// writeCounters — persist the counter map. mkdir-then-writeFile, no atomic
// rename (see header — Phase 4 accepts eventual consistency).
// ---------------------------------------------------------------------------

async function writeCounters(sessionId: string, c: CounterState): Promise<void> {
  const path = sessionStateFile(sessionId, COUNTERS_KEY);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(c, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// ruleKey — composite key. Exported for tests and for future hook wiring
// that needs to index from the `dueRules` list back into a specific rule.
// ---------------------------------------------------------------------------

export function destinationRuleKey(packName: string, skillName: string, ruleId: string): string {
  return `${packName}::${skillName}::${ruleId}`;
}

// ---------------------------------------------------------------------------
// maybeRunDestinationChecks — tick the counter for every destination_check
// rule across the active packs, return the rule keys whose counters hit
// their interval this call.
//
// Algorithm:
//
//   1. Read the counter map (or start fresh).
//   2. For each destination_check rule in `packs`:
//        - bump counter by 1
//        - if counter >= interval.every_n_tool_calls → mark due + reset to 0
//        - else → save the new counter
//   3. Write the counter map.
//   4. Return the list of due-rule keys.
//
// The caller is responsible for actually invoking `check_destination` on
// each due key. This module is pure scheduling — it doesn't touch the
// function registry or the LLM. Keeping those concerns separate means the
// scheduler is trivially testable without a stub registry.
//
// Idempotency caveat: each `maybeRunDestinationChecks` call increments the
// counter by 1, so callers must invoke it EXACTLY once per `tool_call`
// event. Double-invocation would double-count and fire prematurely; non-
// invocation would silently skip events. The pre-tool-use hook (future
// wiring) is the single source of truth for that invariant.
// ---------------------------------------------------------------------------

export async function maybeRunDestinationChecks(
  sessionId: string,
  packs: Pack[],
): Promise<string[]> {
  const c = await readCounters(sessionId);
  const dueRules: string[] = [];
  for (const pack of packs) {
    for (const skill of pack.skills) {
      for (const rule of skill.rules) {
        if (rule.kind !== 'destination_check') continue;
        const key = destinationRuleKey(pack.name, skill.name, rule.id);
        // `?? 0` defends against a missing key OR a non-number value from
        // a corrupted JSON read that slipped past readCounters' guard.
        const prev = typeof c.byRule[key] === 'number' ? c.byRule[key] : 0;
        const cur = prev + 1;
        if (cur >= rule.interval.every_n_tool_calls) {
          dueRules.push(key);
          c.byRule[key] = 0;
        } else {
          c.byRule[key] = cur;
        }
      }
    }
  }
  await writeCounters(sessionId, c);
  return dueRules;
}
