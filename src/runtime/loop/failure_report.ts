/**
 * §5.4b — FAILURE REPORTS (loop/docs/design/opensquid-reporting-model.md).
 *
 * On ANY failure — a wedge, a gate that holds, a crash — the agent MUST emit a FAILURE REPORT that
 * states the REASON, not just the fact. It is a first-class SAVED record (durably filed under the active
 * project's `<project>/.opensquid/reports/`) whose rendered content ALSO feeds the escalation interrupt,
 * so the failure is EXPLAINED, not merely flagged. The renderer is PURE — `iso` is injected, never
 * `Date.now()`.
 *
 * CRITICAL FORMAT RULE: failure reports NEVER use the `🦑` emoji. That mark is reserved for drift / gate
 * notices; a failure report leads with a PLAIN header so the two are never confused.
 *
 * STANDARDIZED FORMAT (one shape for every failure kind, so reports are recognizable):
 *   Failure report — <kind> · <taskId> · <date>
 *   Reason: …             (the one-line why)
 *   Failing criterion: …  (the `file:line` or gate name that held)
 *   Evidence: …           (the evidence that failed it)
 *   Resolving action: …   (the action needed to resolve it)
 *
 * The caller decides the directory (`<project>/.opensquid/reports/`); this renderer returns only the
 * root-relative filename + the rendered markdown body.
 *
 * Imports: none (pure — no filesystem, no clock).
 */

export type FailureKind = 'wedge' | 'held_gate' | 'crash';

export interface FailureReport {
  taskId: string;
  kind: FailureKind;
  reason: string; // one-line why
  criterion: string; // the failing criterion / gate — a `file:line` or a gate name
  evidence: string; // the evidence that failed it
  resolvingAction: string; // the action needed to resolve it
}

/**
 * Render the failure report body + its dated file path. Pure (no `Date.now()`): the date is derived from
 * the injected `iso` via `iso.slice(0, 10)`. The body leads with a PLAIN header (NO `🦑`) and ends with a
 * trailing newline. `path` is the root-relative filename only — the caller supplies the directory.
 */
export function renderFailureReport(r: FailureReport, iso: string): { path: string; body: string } {
  const date = iso.slice(0, 10);
  const lines: string[] = [
    `Failure report — ${r.kind} · ${r.taskId} · ${date}`,
    '',
    `Reason: ${r.reason}`,
    `Failing criterion: ${r.criterion}`,
    `Evidence: ${r.evidence}`,
    `Resolving action: ${r.resolvingAction}`,
  ];
  const body = lines.join('\n') + '\n';
  return {
    path: `failure-${r.taskId}-${date}.md`,
    body,
  };
}
