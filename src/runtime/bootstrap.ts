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
 * `OPENSQUID_TEST_PACK` env var (Phase 1 test seam):
 *   When the runtime is launched as a subprocess (e.g. the e2e smoke test
 *   spawning `dist/runtime/hooks/pre-tool-use.js`), the parent test process
 *   cannot reach the child's `activePacks` module state. Setting
 *   `OPENSQUID_TEST_PACK` to a JSON-encoded `Pack` object lets the child
 *   self-seed at module-load time. Malformed JSON is silently ignored
 *   (returns `[]`) — the seam is test-only, fail-safe, and removed in
 *   Phase 2 alongside `setActivePacks`. NEVER document this in user-facing
 *   docs — it is a temporary scaffold, not API.
 *
 * Imports from: functions/.
 * Imported by: runtime/hooks/*.ts (per-hook binaries), runtime/index.ts (re-export).
 */

import { registerEventFunctions } from '../functions/event.js';
import { registerLlmFunctions } from '../functions/llm.js';
import { FunctionRegistry } from '../functions/registry.js';
import { registerStateFunctions } from '../functions/state.js';
import { registerVerdictFunctions } from '../functions/verdict.js';

import type { Pack } from './types.js';

export function buildRegistry(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerEventFunctions(r);
  registerStateFunctions(r);
  registerVerdictFunctions(r);
  registerLlmFunctions(r);
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

let activePacks: Pack[] = loadFromEnv();

export function setActivePacks(packs: Pack[]): void {
  activePacks = packs;
}

// Async signature pinned for Phase 2 — see header. The trivial `await`
// satisfies @typescript-eslint/require-await without adding real overhead.
export async function loadActivePacks(_sessionId: string): Promise<Pack[]> {
  await Promise.resolve();
  return activePacks;
}
