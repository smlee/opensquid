/**
 * RD.3 — the higher-scope before/after report renderers (task / session / system).
 *
 * Design-of-record: loop/docs/design/opensquid-reporting-model.md §4 (the before/after spine) + §5
 * (the per-scope vocabularies). A report is a before/after COMMUNICATION pair DISPLAYED live at every
 * scope boundary; these renderers produce the §4 spine for the three scopes ABOVE the FSM stage, whose
 * stage-level bodies live in `stage_report.ts`.
 *
 * Kept a SEPARATE module from `stage_report.ts` on purpose: the CODE-after stage body is a hard
 * byte-freeze (RD.2 — the ask locks "the 7 phase is correct"), so folding the scope spine into
 * `renderStageReport` would risk that freeze. A small shared-shape duplication across two pure functions
 * is the correct trade. Both functions are PURE — `iso` is injected, never `Date.now()`.
 */

/** One line of the after-report checklist — the commitment resolved (§4 after). `note` annotates a ✗. */
export interface ScopeChecklistItem {
  item: string;
  done: boolean;
  note?: string;
}

/**
 * Before-`<scope>`: the intent/commitment (§4 before — subject + a "Will:" list). Surfaced-only,
 * DISPLAYED live, never saved. `will` is the set of things this scope is about to do.
 */
export function renderScopeBefore(
  scope: string,
  subject: string,
  will: string[],
  iso: string,
): { body: string } {
  const date = iso.slice(0, 10);
  const lines = [`Before-${scope} · ${subject} · ${date}`, '', 'Will:'];
  for (const w of will) lines.push(`  - ${w}`);
  return { body: lines.join('\n') + '\n' };
}

/**
 * After-`<scope>`: the same commitment resolved (§4 after — each ✓/✗, an optional `Produced:` line, an
 * optional `Next:` line). DISPLAYED live, never saved. PURE (`iso` injected), mirroring `stage_report.ts`.
 */
export function renderScopeAfter(
  scope: string,
  subject: string,
  resolved: ScopeChecklistItem[],
  produced: string | undefined,
  next: string | undefined,
  iso: string,
): { body: string } {
  const date = iso.slice(0, 10);
  const lines = [`After-${scope} · ${subject} · ${date}`, ''];
  for (const r of resolved)
    lines.push(`  ${r.done ? '✓' : '✗'} ${r.item}${r.note !== undefined ? ` — ${r.note}` : ''}`);
  if (produced !== undefined) lines.push('', `Produced: ${produced}`);
  if (next !== undefined) lines.push(`Next: ${next}`);
  return { body: lines.join('\n') + '\n' };
}
