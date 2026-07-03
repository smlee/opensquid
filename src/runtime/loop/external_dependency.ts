/**
 * GFR.4 / E2 — the DIFF-DERIVED conditionality for the external-consultation rung.
 *
 * The 3rd-100% (design §4.1 source-ladder rung 5): the audit/verify climb from LOCAL to EXTERNAL — the tool's
 * OWN docs / an existing working solution — because local cannot supply authoritative external docs (they live
 * outside the repo by definition). The runtime enforces this as a deterministic "did the consultation happen"
 * signal (external_consult.ts), but ONLY WHEN NECESSARY (user, 2026-06-28): a genuinely
 * external-dependency-free change (a pure internal refactor / a docs-only edit) must NOT be forced to consult
 * the web — that would over-gate every trivial edit.
 *
 * This module is the SINGLE SOURCE OF TRUTH for "does this change reach OUTSIDE local knowledge?" — the
 * predicate all three facets (E2a code.audited · E2c code.consulted_before · E2d author.searched_existing)
 * gate their requirement on. It is DIFF-DERIVED, never agent-asserted: an agent-asserted exemption is a
 * self-report hole (the risk callout, T-v2-guess-free GFR.4). Two unambiguous signals, both read straight off
 * the uncommitted diff:
 *
 *   (a) a DEPENDENCY-MANIFEST change — package.json, a lockfile, requirements.txt, go.mod, Cargo.toml,
 *       Gemfile, pyproject.toml, build.gradle, … — a declared dependency edit ALWAYS touches an external fact.
 *   (b) a NEW THIRD-PARTY import ADDED in the diff — an `import … from '<bare>'` / `require('<bare>')` /
 *       `import('<bare>')` / `from <bare> import …` whose specifier is a BARE package (neither relative `./`
 *       nor a first-party alias) and not a language builtin (`node:*`). The newly-reached library whose
 *       authoritative docs are external.
 *
 * Everything else is EXEMPT (local knowledge suffices → no external consultation required): a pure internal
 * refactor, a docs-only edit, a test that exercises known internals. This is a deliberately CONSERVATIVE lower
 * bound — it flags the clear "definitely external" cases and exempts the rest, honoring the user's "only when
 * necessary." It does NOT try to detect a new method on an ALREADY-imported library (undecidable from a diff
 * without a symbol database, and the source of false positives); the qualitative content-audit (GFR.1/GFR.2)
 * still covers doc-use advisorily. `node:*` builtins are treated as local (foundational, universally known,
 * used pervasively — requiring a web consult to add `node:fs` would over-gate).
 *
 * A pure leaf — zero repo imports — so the hot guard-ctx layer can import it without dragging in a heavier
 * chain (mirrors `protected_paths.ts`). The git read lives in `external_dependency_evidence.ts`.
 *
 * Spec: docs/tasks/T-v2-guess-free.md GFR.4; docs/design/v2-enforcement-implementation.md §2 (E2a/E2c/E2d).
 */

/** Dependency-manifest basenames whose appearance in the changed-file set always touches an external fact. */
const DEP_MANIFESTS = new Set<string>([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'requirements.txt',
  'pyproject.toml',
  'poetry.lock',
  'pipfile',
  'pipfile.lock',
  'go.mod',
  'go.sum',
  'cargo.toml',
  'cargo.lock',
  'gemfile',
  'gemfile.lock',
  'build.gradle',
  'build.gradle.kts',
  'pom.xml',
  'composer.json',
  'composer.lock',
]);

/** True iff the file's basename is a known dependency manifest (case-insensitive — `Gemfile`, `Pipfile`). */
export function isDependencyManifest(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  return DEP_MANIFESTS.has(base.toLowerCase());
}

/**
 * True iff `spec` is a THIRD-PARTY (external) module specifier: not relative (`.`/`..`), not absolute (`/`),
 * not an alias root (`@/…`, `~/…` — first-party TS path aliases), and not a language builtin (`node:*`, `bun:*`).
 * A scoped package (`@scope/pkg`) IS external; a bare name (`zod`, `react`) IS external.
 */
export function isThirdPartySpecifier(spec: string): boolean {
  if (spec === '') return false;
  if (spec.startsWith('.') || spec.startsWith('/')) return false; // relative / absolute (first-party)
  if (spec.startsWith('@/') || spec.startsWith('~/') || spec.startsWith('~')) return false; // path alias
  if (spec.startsWith('node:') || spec.startsWith('bun:')) return false; // language builtin (local knowledge)
  return true;
}

// A single ADDED line that brings in a module. Matches JS/TS `from '<x>'` / `require('<x>')` / `import('<x>')`
// and Python `import <x>` / `from <x> import`. Non-greedy, quote-agnostic; the specifier is captured for the
// third-party test. Only ADDED (`+`, not `+++`) lines are scanned by `touchesExternalDependency`.
const JS_FROM = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
const PY_IMPORT = /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import\b|import\s+([A-Za-z_][\w.]*))/;

/** Extract every module specifier introduced on a single ADDED source line (JS/TS + Python forms). */
export function specifiersInLine(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(JS_FROM)) if (m[1] !== undefined) out.push(m[1]);
  const py = PY_IMPORT.exec(line);
  if (py !== null) {
    const mod = py[1] ?? py[2];
    // Python roots the package at the first dotted segment (`import a.b.c` → package `a`).
    if (mod !== undefined) out.push(mod.split('.')[0]!);
  }
  return out;
}

/**
 * DIFF-DERIVED: does the unified `git diff` touch an external fact? True iff a dependency manifest is among the
 * changed files OR an added line introduces a new third-party import. Empty/whitespace diff → false (nothing to
 * consult about). Never throws.
 *
 *   diff — a unified diff (e.g. `git diff HEAD`). File headers are `+++ b/<path>`; added content lines start
 *          with a single `+` (the `+++` header is skipped). Python roots the package at its first segment.
 */
export function touchesExternalDependency(diff: string): boolean {
  if (typeof diff !== 'string' || diff.trim() === '') return false;
  for (const raw of diff.split('\n')) {
    // Changed-file header (`+++ b/path`, `--- a/path`) → dependency-manifest check.
    if (raw.startsWith('+++ ') || raw.startsWith('--- ')) {
      const path = raw
        .slice(4)
        .replace(/^[ab]\//, '')
        .trim();
      if (path !== '' && path !== '/dev/null' && isDependencyManifest(path)) return true;
      continue;
    }
    // Added content line (single leading `+`, not the `+++` header) → new-third-party-import check.
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      const added = raw.slice(1);
      if (specifiersInLine(added).some(isThirdPartySpecifier)) return true;
    }
  }
  return false;
}
