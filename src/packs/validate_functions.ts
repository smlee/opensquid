/**
 * Function-reference validation (Task 2.4) — walks every `rules[*].process[*].call`
 * in a `Pack` and confirms the referenced primitive exists in the runtime
 * `FunctionRegistry`. Missing references collected as `ValidationIssue[]` so
 * the setup UI / load orchestrator can surface them all at once (no
 * short-circuit) per design doc §"Pack validation checks".
 *
 * Suggestions: a Levenshtein-distance pass (≤ 2) finds the closest registered
 * name for a typo'd call (e.g. `match_commnd` → `match_command`). Inline
 * implementation — intentionally no extra dependency.
 *
 * Imports from: runtime/types.ts (Pack), functions/registry.ts (FunctionRegistry).
 * Imported by: packs/ index re-export; load orchestrator (Phase 3+).
 */

import type { FunctionRegistry } from '../functions/registry.js';
import type { Pack } from '../runtime/types.js';

// ---------------------------------------------------------------------------
// ValidationIssue — one entry per missing function reference
//
// Carries enough context for the setup UI to point at the exact YAML location:
// pack name, skill name, rule id, step index, the missing call name, and
// an optional `suggestion` if a Levenshtein-close match exists in the registry.
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  pack: string;
  skill: string;
  ruleId: string;
  step: number;
  missing: string;
  suggestion?: string;
}

// ---------------------------------------------------------------------------
// validatePackFunctions — pack × registry → ValidationIssue[]
//
// Walk every skill → rule → process step. For each step whose `call` is not
// in the registry, append a `ValidationIssue`. Never short-circuit — the
// caller wants the full set so the user can fix them all in one pass.
// ---------------------------------------------------------------------------

export function validatePackFunctions(pack: Pack, registry: FunctionRegistry): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const known = registry.list();
  for (const skill of pack.skills) {
    for (const rule of skill.rules) {
      // Phase 4: destination_check rules don't carry a `process` field —
      // they fire via the dedicated `check_destination` primitive on the
      // scheduler tick. There are no per-step `call` names to validate.
      if (rule.kind === 'destination_check') continue;
      rule.process.forEach((step, i) => {
        if (!registry.has(step.call)) {
          const suggestion = closest(step.call, known, 2);
          const issue: ValidationIssue = {
            pack: pack.name,
            skill: skill.name,
            ruleId: rule.id,
            step: i,
            missing: step.call,
          };
          if (suggestion !== undefined) issue.suggestion = suggestion;
          issues.push(issue);
        }
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// closest — nearest candidate by Levenshtein distance, capped at `maxDist`.
//
// Returns the candidate name with the smallest distance ≤ maxDist, or
// `undefined` if no candidate is within the cap. Ties broken by registry
// ordering (first wins) since `registry.list()` is already sorted.
// ---------------------------------------------------------------------------

function closest(target: string, candidates: string[], maxDist: number): string | undefined {
  let best: { name: string; d: number } | null = null;
  for (const c of candidates) {
    const d = levenshtein(target, c);
    if (d <= maxDist && (!best || d < best.d)) best = { name: c, d };
  }
  return best?.name;
}

// ---------------------------------------------------------------------------
// levenshtein — classic 2D dynamic-programming edit distance.
//
// Inline to avoid a dependency on `js-levenshtein` for one validator. With
// ~80 primitives in the registry and a handful of missing calls per pack,
// the O(m*n) cost is negligible. If the registry ever grows past a few
// hundred entries, swap in `js-levenshtein` (MIT) per the task risk callout.
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[m]![n]!;
}
