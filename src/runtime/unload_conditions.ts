/**
 * `unloads_when` condition evaluator.
 *
 * Skills declare exit conditions as a list of `UnloadCondition` entries. The
 * runtime walks the list per `TickState` snapshot and asks: "should this
 * skill leave context now?" Like `when_to_load`, semantics are OR — any
 * condition fires → unload. The evaluator is pure: tick state in, boolean
 * out, no I/O.
 *
 * Authoritative source: `docs/opensquid-real-design.md` §"Skill format" +
 * §"Skill properties" + spec the phase-3 dynamic-loading planning notes [not retained — this header is the authority] task 3.2.
 *
 * Three condition kinds:
 *
 *   active_task_completes — fires when the wrapping task closes (Stop event).
 *   session_ends          — fires when the host session terminates.
 *   idle_n_turns          — fires after `n` UserPromptSubmit cycles without
 *                           skill activation. "Turn" is locked to a
 *                           UserPromptSubmit cycle (see `tick.ts`) — NOT a
 *                           tool call. Definition pinned per memory
 *                           `feedback_workflow_cycle`.
 *
 * Shorthand surface — pack authors write the no-arg conditions as bare
 * strings:
 *
 *   unloads_when:
 *     - active_task_completes        # canonical: { kind: active_task_completes }
 *     - session_ends                 # canonical: { kind: session_ends }
 *     - idle_n_turns: 5              # canonical: { kind: idle_n_turns, n: 5 }
 *
 * `normalizeUnloadCondition` accepts either form; canonical form passes
 * through unchanged.
 *
 * Imports from: zod.
 * Imported by: src/packs/schemas/skill.ts, src/runtime/index.ts, src/runtime/tick.ts.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// UnloadCondition — canonical discriminated form. Shorthand strings/single-key
// objects are normalized to this shape before parsing.
// ---------------------------------------------------------------------------

export const UnloadConditionCanonical = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('active_task_completes') }),
  z.object({ kind: z.literal('session_ends') }),
  z.object({ kind: z.literal('idle_n_turns'), n: z.number().int().positive() }),
]);
export type UnloadCondition = z.infer<typeof UnloadConditionCanonical>;

// ---------------------------------------------------------------------------
// Shorthand normalizer.
//
// Bare-string form: 'session_ends' / 'active_task_completes' → {kind: <name>}.
// Single-key object: {idle_n_turns: 5} → {kind: 'idle_n_turns', n: 5}.
// Canonical (already-has-kind) form: passes through.
// Anything else falls through to the discriminated union for a precise Zod
// error.
// ---------------------------------------------------------------------------

const NO_ARG_KINDS = ['active_task_completes', 'session_ends'] as const;
type NoArgKind = (typeof NO_ARG_KINDS)[number];

function isNoArgKind(s: string): s is NoArgKind {
  return (NO_ARG_KINDS as readonly string[]).includes(s);
}

export function normalizeUnloadCondition(raw: unknown): unknown {
  if (typeof raw === 'string') {
    if (isNoArgKind(raw)) return { kind: raw };
    return raw;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) return raw;
  const k = keys[0];
  if (k === 'idle_n_turns' && typeof obj[k] === 'number') {
    return { kind: 'idle_n_turns', n: obj[k] };
  }
  return raw;
}

export const UnloadCondition = z.preprocess(normalizeUnloadCondition, UnloadConditionCanonical);

// ---------------------------------------------------------------------------
// TickState — per-skill activation context the dispatcher feeds the evaluator.
//
// `turnsSinceActivation` — count of UserPromptSubmit cycles observed since the
//                          skill last activated. Bumped only by the tick
//                          driver (`tick.ts`) on `prompt_submit` events.
// `taskCompleted`        — set true when a Stop event arrives (task boundary).
// `sessionEnded`         — set true on SessionEnd (host shutdown).
//
// Each active skill gets its own TickState. Fields are mutated by the tick
// driver; the evaluator reads them.
// ---------------------------------------------------------------------------

export interface TickState {
  turnsSinceActivation: number;
  taskCompleted: boolean;
  sessionEnded: boolean;
}

// ---------------------------------------------------------------------------
// shouldUnload — OR-walk the condition list. Returns true on first hit.
//
// Empty list never fires (a skill with no `unloads_when` stays loaded until
// the session ends, at which point the dispatcher tears down all skills).
// ---------------------------------------------------------------------------

export function shouldUnload(
  conditions: readonly UnloadCondition[],
  tick: Readonly<TickState>,
): boolean {
  for (const c of conditions) {
    if (c.kind === 'session_ends' && tick.sessionEnded) return true;
    if (c.kind === 'active_task_completes' && tick.taskCompleted) return true;
    if (c.kind === 'idle_n_turns' && tick.turnsSinceActivation >= c.n) return true;
  }
  return false;
}
