/**
 * select_phase_bundle (GI.3) — the shared, pure phase→instruction-bundle selector for the coding-flow
 * gate's per-gate injection. Both delivery channels use it: channel (a) `phase_inject` (turn boundary,
 * refresh + orientation) and channel (b) the PreToolUse rule (mid-turn transition catch).
 *
 * A bundle = the ALWAYS-ON sections (§0 flow-picker + §On-a-BLOCK protocol — by their SPECIFIC headings,
 * NOT "all numbered") + the ONE phase-routed numbered section (§1 SCOPE | §2 AUTHOR | §3 CODE) + the
 * phase's audit rubric (SCOPE→scope, AUTHOR→author, CODE→none). `procedure.md` and the rubrics are read by
 * the caller and passed in (this stays a pure function — no I/O — for testability).
 *
 * Spec: loop/docs/tasks/T-coding-flow-gate-push-injection.md §GI.3. The FSM-state→phase map is total over
 * the nine declared coding-flow states (packs/builtin/coding-flow/fsm.yaml:14–22); `step` is total over
 * that set (runtime/fsm.ts:98–113 + validateFsm 63–79), so no other state can occur.
 */

export type Phase = 'SCOPE' | 'AUTHOR' | 'CODE';

/** The nine declared coding-flow states → the phase the agent is about to act in. TOTAL over the set. */
const STATE_PHASE: Record<string, Phase> = {
  idle: 'SCOPE',
  phases_complete: 'SCOPE', // a finished track re-arms into a new SCOPE
  scoping: 'SCOPE',
  researching: 'SCOPE',
  researched: 'AUTHOR', // SCOPE passed; the spec is authored here
  spec_authored: 'AUTHOR',
  spec_complete: 'CODE', // AUTHOR passed; about to load tasks + run phases
  tasks_loaded: 'CODE',
  phases_in_flight: 'CODE',
};

export interface PhaseBundle {
  phase: Phase;
  /** The injectable instruction text for `phase` (already joined; empty only if every input is empty). */
  text: string;
}

/** The phase the agent is about to act in for an FSM `state`, WITHOUT building the bundle. `null`/unknown/
 *  initial coalesces to `idle` → SCOPE. The cheap discriminator channel (b) uses to dedup a tool_call
 *  against `last-injected-phase` before paying the procedure-split + rubric reads. */
export function phaseForState(state: string | null): Phase {
  return STATE_PHASE[state ?? 'idle'] ?? 'SCOPE';
}

/** Key a `## ` heading: a numbered heading `## N. …` → the digit `N`; any other heading → its text after
 *  `## ` (e.g. `## On a BLOCK` → `On a BLOCK`). This is the explicit always-on-vs-routed discriminator —
 *  §0 is numbered yet always-on, so we key by identity, never by "is-numbered". */
function headingKey(heading: string): string {
  const numbered = /^##\s+(\d+)\./.exec(heading);
  return numbered ? numbered[1]! : heading.replace(/^##\s+/, '').trim();
}

/** Split a `procedure.md`-shaped doc into its `## ` sections, keyed by `headingKey`. Each section's text
 *  includes its heading line + body up to (not including) the next `## ` heading. Content before the first
 *  `## ` (a title/preamble) is dropped. */
export function splitByHeading(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  let key: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (key !== null) out[key] = buf.join('\n').trimEnd();
  };
  for (const line of md.split('\n')) {
    if (/^##\s+/.test(line)) {
      flush();
      key = headingKey(line);
      buf = [line];
    } else if (key !== null) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/**
 * Select the instruction bundle for the coding-flow FSM `state`. `null`/an unknown/initial state coalesces
 * to `idle` → SCOPE (about-to-scope). Always-on = §0 + §On-a-BLOCK; routed = the §1|§2|§3 matching the
 * phase; + the phase rubric. Pure.
 */
export function selectPhaseBundle(
  state: string | null,
  procedureMd: string,
  rubrics: { scope: string | null; author: string | null },
): PhaseBundle {
  const phase = phaseForState(state);
  const sections = splitByHeading(procedureMd);
  const numbered = phase === 'SCOPE' ? '1' : phase === 'AUTHOR' ? '2' : '3';
  const rubric = phase === 'SCOPE' ? rubrics.scope : phase === 'AUTHOR' ? rubrics.author : null;
  const text = [sections['0'], sections[numbered], sections['On a BLOCK'], rubric]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join('\n\n');
  return { phase, text };
}
