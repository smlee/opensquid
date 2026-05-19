/**
 * Runtime bootstrap — function registry + active-pack source for hook binaries.
 *
 * Two entry points every hook binary imports:
 *
 *   - `buildRegistry()` — assembles a `FunctionRegistry` with all primitive
 *     families registered: event / state / verdict / llm. RAG is NOT
 *     registered here (see "RAG omission" below).
 *
 *   - `loadActivePacks(sessionId)` — Phase 1 test seam. Returns whatever was
 *     last `setActivePacks(...)`'d in-process, or — for subprocess-launched
 *     hooks — packs serialized via the `OPENSQUID_TEST_PACK` env var. Phase 2
 *     replaces this with a real YAML loader that reads `~/.opensquid/active.json`,
 *     resolves codex sources, parses pack YAML, and respects per-skill load
 *     modes. The `Promise<Pack[]>` signature is pinned now so the Phase 2
 *     swap is body-only — call sites do not refactor.
 *
 * RAG omission rationale (Phase 1):
 *   `registerRagFunctions(registry, backend)` requires a `RagBackend`
 *   instance (Task 1.10). Phase 1's smoke test pack (`neverAmendPack`) uses
 *   only `match_command` + `verdict` — no `recall` / `embed` / `store_lesson`
 *   calls — so no backend is needed. Wiring a default backend here would
 *   force Phase 1 to either (a) instantiate a real libsql backend at every
 *   hook invocation (boot cost, file I/O) or (b) ship a no-op stub that
 *   silently returns empty hits (hides misconfigured packs). Both are worse
 *   than just not registering rag until the loader (Phase 2) knows whether
 *   any active pack actually needs it. If a Phase 1 pack DOES try to call a
 *   rag primitive, the evaluator surfaces `unknown_function` cleanly via the
 *   normal error path — not a silent miss.
 *
 * Two env-var test seams (subprocess hook bridge):
 *
 *   `OPENSQUID_TEST_PACK` (Phase-1 legacy seam, kept for backward compat):
 *     A JSON-encoded `Pack` object the child self-seeds at module-load.
 *     Phase 2.7 keeps this so existing call sites and any in-flight tests
 *     that hand-build a pack still work. Malformed JSON is silently ignored
 *     (returns `[]`) — fail-safe, test-only. NEVER document in user docs.
 *
 *   `OPENSQUID_TEST_PACK_DIR` (Phase-2.7 seam, preferred):
 *     An absolute path to an on-disk YAML pack folder (`manifest.yaml` +
 *     `skills/*\/skill.yaml`). The child invokes the real `loadPack` from
 *     `src/packs/loader.ts` synchronously at module load via a promise +
 *     `await` chain handed to `loadActivePacks`. Errors are swallowed at
 *     the same fail-safe contract as the JSON seam — a missing folder or
 *     malformed YAML yields `[]`, surfacing as the empty-active-packs
 *     "allow everything" path. That keeps the seam a strict superset of
 *     Phase-1 behavior so tests can flip from inline → on-disk without
 *     changing assertions.
 *
 *   Both seams compose: if `OPENSQUID_TEST_PACK_DIR` is set, its loaded
 *   pack is appended to whatever `OPENSQUID_TEST_PACK` produced. In
 *   practice tests use exactly one of the two.
 *
 * Imports from: functions/, packs/loader.
 * Imported by: runtime/hooks/*.ts (per-hook binaries), runtime/index.ts (re-export).
 */

import { registerDestinationCheckFunction } from '../functions/destination_check.js';
import { registerEventFunctions } from '../functions/event.js';
import { registerLlmFunctions } from '../functions/llm.js';
import { FunctionRegistry } from '../functions/registry.js';
import { registerStateFunctions } from '../functions/state.js';
import { registerVerdictFunctions } from '../functions/verdict.js';
import { loadPack } from '../packs/loader.js';

import type { Pack } from './types.js';

export function buildRegistry(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerEventFunctions(r);
  registerStateFunctions(r);
  registerVerdictFunctions(r);
  registerLlmFunctions(r);
  // Phase 4: `check_destination` is the destination-side anti-drift
  // primitive. It composes `llm_classify` (registered just above) so the
  // ordering matters — register it last among the LLM-dependent primitives.
  // Future destination_check rules and the Phase-4.3 scheduler call into
  // this primitive name.
  registerDestinationCheckFunction(r);
  // RAG primitives intentionally not registered in Phase 1 — see header.
  return r;
}

// ---------------------------------------------------------------------------
// Active packs — Phase 1 test seam (replaced by YAML loader in Phase 2).
// ---------------------------------------------------------------------------

function loadFromEnv(): Pack[] {
  const raw = process.env.OPENSQUID_TEST_PACK;
  if (raw === undefined || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    // Trust shape at this seam — the test pack is opensquid-authored, and
    // mis-shaped input surfaces immediately as the evaluator rejects rules
    // it can't parse. A full Zod parse here would force a circular import
    // (types.ts -> bootstrap.ts -> types.ts) for zero Phase-1 benefit.
    return [parsed as Pack];
  } catch {
    return [];
  }
}

// Sync constant — the JSON env-var path is read at module load (no I/O).
const envPacks: Pack[] = loadFromEnv();

// Async future-state — the on-disk YAML path requires fs reads. Resolved at
// module load too; `loadActivePacks` awaits the same promise on every call
// so the load happens exactly once per hook subprocess. Errors are swallowed
// per the seam contract (see header) — a broken fixture yields the empty
// "allow everything" path rather than crashing the hook binary mid-tool-call.
const diskPacksPromise: Promise<Pack[]> = (async () => {
  const dir = process.env.OPENSQUID_TEST_PACK_DIR;
  if (dir === undefined || dir === '') return [];
  try {
    return [await loadPack(dir)];
  } catch {
    return [];
  }
})();

let activePacks: Pack[] = envPacks;

export function setActivePacks(packs: Pack[]): void {
  activePacks = packs;
}

// Async signature pinned for Phase 2 — see header. `setActivePacks` always
// wins (in-process tests override env-var seams); on top of that the env-var
// JSON path and the on-disk YAML path compose (concatenated).
export async function loadActivePacks(_sessionId: string): Promise<Pack[]> {
  const disk = await diskPacksPromise;
  return [...activePacks, ...disk];
}
