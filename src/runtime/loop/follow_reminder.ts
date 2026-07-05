// follow_reminder — the "follow-instructions reminder": a standing anti-drift NUDGE.
//
// Design-of-record: loop/docs/design/opensquid-reporting-model.md §5.4c.
//
// This is the anti-drift mechanism applied to the lap ITSELF. An agent driving a
// stage can drift off the procedure it was handed — start improvising, widen scope,
// or forget the rubric it is graded against. The follow-reminder re-asserts the
// CURRENT stage's procedure + rubric so the agent stays ON the injected instructions
// rather than drifting away from them.
//
// It fires at a stage boundary and/or when a drift signal is observed. Unlike a stage
// report, it is SURFACED (ephemeral) — a momentary nudge shown to the agent, never a
// saved artifact. It carries no gate/drift authority of its own: it does not use the
// 🦑 marker (reserved for drift/gate notices); it is a plain, imperative reminder to
// follow the instructions already in force.
//
// PURE: no I/O, no clock, no globals. Output is a deterministic function of the input.

export interface FollowReminderInput {
  stage: string; // the current FSM stage (e.g. 'author')
  procedure: string; // the stage's procedure text (what to do this stage)
  rubric?: string; // the stage's rubric/criteria text, if any
  drift?: string; // an optional drift signal that triggered the nudge
}

/**
 * Render the follow-instructions reminder as a short plain-text nudge.
 *
 * Always includes the stage and the procedure. A leading drift note is included only
 * when `drift` is provided (non-empty). A "Rubric:" section is included only when
 * `rubric` is provided (non-empty). The literal string "undefined" is never emitted,
 * and the 🦑 marker is never used. Ends with a trailing newline.
 */
export function renderFollowReminder(r: FollowReminderInput): string {
  const lines: string[] = [];

  const drift = r.drift?.trim();
  if (drift) {
    lines.push(`Drift noticed: ${drift}`);
  }

  lines.push(`Stay on the ${r.stage} procedure. Follow these instructions:`);
  lines.push(`Procedure: ${r.procedure}`);

  const rubric = r.rubric?.trim();
  if (rubric) {
    lines.push(`Rubric: ${rubric}`);
  }

  return `${lines.join('\n')}\n`;
}
