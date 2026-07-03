/**
 * GFR.4 / E2 — the deterministic EXTERNAL-CONSULTATION signal (zero LLM), the "did the audit reach outside
 * local?" half of the external rung. Mirrors `readiness.ts`: a recorded fact per task the gate predicates on,
 * NOT a quality judgment (whether it was the RIGHT source stays advisory — that part is inference, design §4.1).
 *
 * A consultation is a recorded external-source tool call — `WebSearch` / `WebFetch` / an intranet/docs fetch
 * exposed via MCP (`isExternalConsultTool`). It is bucketed by WINDOW, derived from the 7-phase ledger so the
 * "second research run" (design §2 E2a) is genuinely distinct from the pre-code read (E2c):
 *   before — a consult recorded BEFORE the `code` phase was logged for the task. Satisfies E2d
 *            (AUTHOR find-existing) + E2c (CODE·before read the task's docs) — you consulted before writing.
 *   after  — a consult recorded AFTER the `code` phase (the `post_research` AUDIT window). Satisfies E2a
 *            (CODE·after = a second research run: alignment · doc-use · existing double-check).
 * The window is decided by the RECORDER'S caller (v2_supply live wiring reads the phase ledger), so a consult
 * cannot be retroactively re-bucketed: once `code` is logged, a new consult can only land in `after` — which is
 * what forces the pre-code consult to genuinely precede coding.
 *
 * Persistence reuses the runtime session-state primitives (`atomicWriteFile` + `sessionStateFile`), exactly as
 * `recordReadiness` does. FAIL-CLOSED: a never-run / unreadable / malformed record reads as
 * `{ before:false, after:false }` — an unproven consultation BLOCKS the gate (when the change needs one; the
 * CONDITIONALITY that decides "needs one" is `external_dependency.ts`, evaluated separately in the guard).
 *
 * Spec: docs/tasks/T-v2-guess-free.md GFR.4; docs/design/v2-enforcement-implementation.md §2 (E2a/E2c/E2d).
 */
import { readFile } from 'node:fs/promises';

import { atomicWriteFile } from '../atomic_write.js';
import { sessionStateFile } from '../paths.js';

/** The consultation window, keyed off whether the `code` phase has been logged (external_consult.ts docstring). */
export type ConsultWindow = 'before' | 'after';

/** The two gate facets: was an external consult recorded before / after the CODE phase. */
export interface ExternalConsult {
  before: boolean;
  after: boolean;
}

/** External-source tool names whose invocation counts as an external consultation (design §2 E2a). */
const CORE_EXTERNAL_TOOLS = new Set<string>(['WebSearch', 'WebFetch']);

/**
 * True iff `toolName` is an external-source consultation tool: the two core harness tools (`WebSearch`,
 * `WebFetch`) OR an MCP-exposed web/intranet fetcher whose name ends in a `web_fetch` / `web_search` / `fetch`
 * shape (e.g. `mcp__fetch__fetch`, `mcp__docs__web_fetch`). A codebase-only search (Grep/Read) is NOT external.
 */
export function isExternalConsultTool(toolName: string): boolean {
  if (typeof toolName !== 'string' || toolName === '') return false;
  if (CORE_EXTERNAL_TOOLS.has(toolName)) return true;
  // MCP fetchers: `mcp__<server>__web_fetch` / `__webfetch` / `__web_search` / a bare `__fetch` leaf.
  return /(?:^|_)(?:web_?fetch|web_?search|fetch)$/i.test(toolName);
}

/** The session-state key holding the per-task external-consultation buckets the gate reads. */
const consultKey = (taskId: string): string => `fsf-external-consult-${taskId}`;

/**
 * Record that an external consultation happened in `window` for `taskId`. IDEMPOTENT + MONOTONIC per bucket:
 * merges with the existing record so a later window never clears an earlier one (once `before` is true it stays
 * true even after `code` is logged). Best-effort persistence; a write error surfaces to the caller (the live
 * wiring swallows it — observe-never-breaks).
 */
export async function recordExternalConsult(
  sid: string,
  taskId: string,
  window: ConsultWindow,
): Promise<void> {
  const cur = await externalConsultResult(sid, taskId);
  const next: ExternalConsult = {
    before: cur.before || window === 'before',
    after: cur.after || window === 'after',
  };
  await atomicWriteFile(sessionStateFile(sid, consultKey(taskId)), JSON.stringify(next));
}

/**
 * The two consult facets, read from the persisted record. FAIL-CLOSED: a never-run / unreadable / malformed
 * record → `{ before:false, after:false }` (the gate blocks when a consult is required).
 */
export async function externalConsultResult(sid: string, taskId: string): Promise<ExternalConsult> {
  try {
    const p = JSON.parse(await readFile(sessionStateFile(sid, consultKey(taskId)), 'utf8')) as {
      before?: unknown;
      after?: unknown;
    };
    return { before: p.before === true, after: p.after === true };
  } catch {
    return { before: false, after: false }; // fail-closed: unproven ⇒ block (when required)
  }
}
