/**
 * Runtime bootstrap (STUB — Task 1.19 wires real loading).
 *
 * This module exposes the two entry points every hook binary needs:
 *
 *   - `buildRegistry()` — assemble a `FunctionRegistry` with all primitives
 *     registered. Phase 1 ships three primitive families: event-inspection,
 *     state I/O, and verdict construction (Tasks 1.4 / 1.5 / 1.6).
 *
 *   - `loadActivePacks(sessionId)` — return the packs that should be active
 *     for this hook invocation. The real implementation (Task 1.19) reads
 *     `~/.opensquid/active.json`, resolves codex sources, parses YAML, and
 *     respects per-skill load modes. Until then this stub returns `[]` so
 *     every hook invocation passes through cleanly.
 *
 * Why a stub now: hook binaries (Task 1.7) need a stable import surface
 * before the loader exists. Shipping `loadActivePacks` as `async () => []`
 * lets the hooks run end-to-end against the real dispatcher without
 * fabricating a parallel "for testing" path. Task 1.19 replaces ONLY the
 * function body — the signature stays.
 *
 * The unused `_sessionId` parameter is deliberate: the future signature
 * uses it to scope per-project pack activation, and pinning the shape now
 * prevents a breaking refactor when 1.19 lands.
 *
 * Imports from: functions/.
 * Imported by: runtime/hooks/*.ts (per-hook binaries), runtime/index.ts (re-export).
 */

import { registerEventFunctions } from '../functions/event.js';
import { FunctionRegistry } from '../functions/registry.js';
import { registerStateFunctions } from '../functions/state.js';
import { registerVerdictFunctions } from '../functions/verdict.js';

import type { Pack } from './types.js';

export function buildRegistry(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerEventFunctions(r);
  registerStateFunctions(r);
  registerVerdictFunctions(r);
  return r;
}

// Stub: Task 1.19 replaces the body with real (genuinely async) filesystem +
// YAML loading. The async signature is pinned now so call sites don't need a
// refactor later. The trivial `await` below satisfies @typescript-eslint/
// require-await without adding misleading runtime overhead — the Promise
// resolves synchronously in the microtask queue.
export async function loadActivePacks(_sessionId: string): Promise<Pack[]> {
  await Promise.resolve();
  // Task 1.19 wires real pack loading (active.json → YAML → Pack[]).
  // Phase 1 hook bindings return [] so every hook invocation passes through.
  return [];
}
