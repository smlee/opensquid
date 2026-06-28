/**
 * T2.7 — the deterministic CODE readiness surfacers (zero LLM), the result-gated half of the CODE gate.
 *
 * The design's "mandatory readiness" (design §3.4, `design:169-174`): before authoring code a task must run the
 * three surfacers, and the gate predicates on their RESULTS — not merely that they ran:
 *   affected     — REVERSE-DEP: the files that reach a SYMBOL the target exports (who depends on what the target
 *                  provides). `index.importGraph.reaches(from, symbol)` (check.ts:64 — the 2nd arg is a SYMBOL,
 *                  NOT a file). Surfaced INFORMATIONALLY.
 *   existingDefs — the exports already present in the target file (don't re-declare). Surfaced INFORMATIONALLY.
 *   deprecated   — a scan of the target's CURRENT text for known-deprecated calls. This is the BLOCKING result:
 *                  a hit ⇒ `deprecated_clean=false` ⇒ the gate BLOCKS. An agent cannot pass the gate by merely
 *                  calling `recordReadiness` with deprecated present.
 *
 * `recordReadiness` persists `{ ran:true, deprecated }` per task; `readinessResult` reads it back and computes
 * the two gate facets (`ran`, `deprecatedClean`). FAIL-CLOSED: a never-run / unreadable record reads as
 * `{ ran:false, deprecatedClean:false }` — an un-run readiness BLOCKS the gate.
 *
 * Persistence reuses the runtime session-state primitives (`atomicWriteFile` + `sessionStateFile`), the same
 * substrate `session_state.ts` writes — the spec's `writeState`/`readState` names are not exports in this repo
 * (DIVERGENCE noted in the task report); the storage semantics (per-key JSON, atomic tmp+rename, null-safe read)
 * are identical.
 *
 * Spec: docs/tasks/T-v2-track2-discipline.md T2.7 ("Key code shapes" / "Test fixtures").
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { atomicWriteFile } from '../atomic_write.js';
import { sessionStateFile } from '../paths.js';

const execFileP = promisify(execFile);

import type { CodeIndex } from '../coverage/check.js';

export interface Readiness {
  /** REVERSE-DEP: files that reach a symbol the target exports (informational). */
  affected: string[];
  /** Exports already present in the target file — don't re-declare (informational). */
  existingDefs: string[];
  /** Known-deprecated call patterns found in the target's current text — the BLOCKING result. */
  deprecated: string[];
}

/** Known-deprecated call patterns scanned in the target's text. Extend per project. */
const DEPRECATED: RegExp[] = [/\bsubstr\(/, /\bnew Buffer\(/, /\.componentWillMount\b/];

/** The session-state key holding the per-task readiness RESULT the CODE gate reads. */
const readinessKey = (taskId: string): string => `fsf-readiness-${taskId}`;

/**
 * Run the three readiness surfacers for `targetFile` against the (already-built) `CodeIndex`. Deterministic
 * given the index + the target's on-disk text. A missing/unreadable target text → no deprecated hits (the
 * affected/existingDefs facets still derive from the pure index).
 */
export async function runReadiness(targetFile: string, index: CodeIndex): Promise<Readiness> {
  // affected = files that reach a SYMBOL the target exports (reaches(from: string[], symbol), check.ts:64 — the
  // 2nd arg is a symbol, NOT a file). Reverse-dep: who depends on what the target provides.
  const targetSymbols = index.exports.filter((e) => e.file === targetFile).map((e) => e.name);
  const affected = index.exports
    .filter(
      (e) =>
        e.file !== targetFile && targetSymbols.some((s) => index.importGraph.reaches([e.file], s)),
    )
    .map((e) => e.file);
  // existingDefs = exports already present in the target (don't re-declare).
  const existingDefs = index.exports.filter((e) => e.file === targetFile).map((e) => e.name);
  // deprecated = scan the target's CURRENT text for known-deprecated calls.
  const text = await readFile(targetFile, 'utf8').catch(() => '');
  const deprecated = DEPRECATED.filter((re) => re.test(text)).map((re) => re.source);
  return { affected: [...new Set(affected)], existingDefs, deprecated };
}

/** Pure deprecated-pattern scan of a file's text (the BLOCKING facet, no CodeIndex needed). */
export function scanDeprecated(text: string): string[] {
  return DEPRECATED.filter((re) => re.test(text)).map((re) => re.source);
}

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|vue|svelte|astro)$/i;

/**
 * CHEAP readiness (no CodeIndex) — the live-wiring scanner: read the STAGED source files via fixed-argv git and
 * scan each for deprecated patterns. The `affected`/`existingDefs` informational facets need the CodeIndex
 * (`runReadiness`) and are intentionally left empty here; the gate blocks on `deprecated` only (T2.7). FAIL
 * toward EMPTY (a non-repo / git error → no deprecated hits → never a false block); the caller still records
 * `ran:true` so the gate's `readiness_ran` facet reflects that the scan happened.
 */
export async function gatherReadiness(cwd: string): Promise<Readiness> {
  const deprecated = new Set<string>();
  try {
    const { stdout } = await execFileP('git', ['diff', '--cached', '--name-only'], { cwd });
    const files = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((p) => p !== '' && SOURCE_EXT.test(p));
    for (const f of files) {
      try {
        const { stdout: content } = await execFileP('git', ['show', `:${f}`], {
          cwd,
          maxBuffer: 8_000_000,
        });
        for (const d of scanDeprecated(content)) deprecated.add(d);
      } catch {
        // a deleted/binary staged path → skip (cannot scan)
      }
    }
  } catch {
    // not a repo / git error → empty (never a false block)
  }
  return { affected: [], existingDefs: [], deprecated: [...deprecated] };
}

/**
 * Record the RESULTS the CODE gate reads (deterministic; gates on results, not just "ran"). Persists
 * `{ ran:true, deprecated }` per task — a deprecated hit survives here so the gate can block on it.
 */
export async function recordReadiness(sid: string, taskId: string, r: Readiness): Promise<void> {
  await atomicWriteFile(
    sessionStateFile(sid, readinessKey(taskId)),
    JSON.stringify({ ran: true, deprecated: r.deprecated }),
  );
}

/**
 * The two CODE-gate facets, read from the persisted readiness RESULT. FAIL-CLOSED: a never-run / unreadable /
 * malformed record → `{ ran:false, deprecatedClean:false }` (the gate blocks — readiness not run ⇒ not ready).
 */
export async function readinessResult(
  sid: string,
  taskId: string,
): Promise<{ ran: boolean; deprecatedClean: boolean }> {
  try {
    const p = JSON.parse(await readFile(sessionStateFile(sid, readinessKey(taskId)), 'utf8')) as {
      ran?: unknown;
      deprecated?: unknown;
    };
    const deprecated = Array.isArray(p.deprecated) ? p.deprecated : [];
    return { ran: p.ran === true, deprecatedClean: deprecated.length === 0 };
  } catch {
    return { ran: false, deprecatedClean: false }; // fail-closed: not run ⇒ block
  }
}
