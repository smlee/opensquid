# Pre-research — FC.1b: migrate the default-discipline cluster to manifest `guards:`

**Date:** 2026-06-03. **Repo:** opensquid. **Spec origin:** `docs/tasks/T-fsm-completion.md:43-60`.
**Research this turn:** `recall`; Read of `src/packs/guards_compiler.ts`, the `Guard` schema
(`src/packs/schemas/manifest.ts:451-478` + `guards` field `:547`), `loader.ts:130` (wiring),
all 5 cluster skills + `drift_response.yaml`, and the 3 test files; grep of adopters.

## 1. Mechanism (verified)

`manifest.guards: Guard[]` (`manifest.ts:547`) → `compileGuards` (`loader.ts:130`) → one
synthetic skill `default-discipline/guards` whose rules are `guard:<name>` with process
`[detect?, verdict(level,message,if:when)]`. A `Guard` = `{name, on∈{tool_call,
prompt_submit,stop,session_end} (default tool_call), detect?{call,args?}, as (default
'hit'), when, level∈{warn,block}, message}`. **No manifest uses `guards:` today** —
FC.1b is the first real adopter (FC.1a never shipped); the mechanism is proven by
`guards_compiler.test.ts`.

## 2. The 21 migratable rules (all shape-perfect: single detect → one warn|block verdict)

- **git** (on: tool_call): `never-amend` (block), `no-force-push-main` (block) —
  `match_command{pattern, target: tool_args.command}` as hit, when `hit`.
- **engine-vocab** (tool_call): `substrate-purity` (warn).
- **versioning** (tool_call): `versioning-pre1-patch-only` (block).
- **honesty-ledger** (prompt_submit): 14 — `text_pattern_match{text_field:
priorAssistantText, patterns:[…]}` as claimed, when `len(claimed.matched) > 0`, warn.
- **phase-logging** (prompt_submit): 3 — `version-slot-assignment`,
  `phase-claim-forward`, `session-no-task` (same text_pattern_match shape, warn).

`d9-guard` (prompt-type) and `workflow` (multi-detect/state rules) are NOT migrated.

## 3. The delicate part — drift_response.yaml re-prefix (the spec's silent-fallthrough risk)

Every migrated rule id becomes `guard:<name>`, so `dispatch.ts:475` `default:
full_stop_and_redo` swallows any per_rule key NOT re-prefixed. Re-prefix these 21:
`never-amend, no-force-push-main, substrate-purity, version-slot-assignment,
versioning-pre1-patch-only` + the 14 honesty + `phase-claim-forward, session-no-task`.
**LEAVE un-prefixed** (they belong to the non-migrated `workflow` skill):
`workflow-phases-required`, `phase-logged-before-commit`. (`version-slot-assignment` IS
phase-logging's — re-prefix it; it is NOT workflow's.)

## 4. Test impact (3 files, atomic)

- `test/builtin/default-discipline.test.ts`: skill-name list drops the 5, adds
  `default-discipline/guards`; the git/honesty(14)/phase-logging(3) per-skill assertions
  rewrite to find the guards skill + assert the `guard:<name>` rule ids.
- `src/packs/command_boundary.skill.test.ts`: the git + versioning CASES + the
  no-force-push test move skill→`default-discipline/guards`, rule→`guard:<id>`
  (`patternOf` resolves by skill-name+rule-id). The `workflow` CASE is unchanged.
- Add a resolution assertion: load the pack, confirm each migrated `guard:<name>` resolves
  to its intended drift policy (NOT the default) — the spec's required proof.

## 5. Behavior-preservation note

The synthetic skill carries BOTH triggers (tool_call + prompt_submit, deduped by the
compiler); cross-firing is safe (match_command no-ops on prompt_submit; text_pattern_match
no-ops on tool_call). Verdict level + message + policy are byte-preserved; only audit
attribution changes (`<skill>/<rule>` → `default-discipline/guards/guard:<name>`),
accepted by the spec. Net ≈ −150 LOC. Open questions: none that block.
