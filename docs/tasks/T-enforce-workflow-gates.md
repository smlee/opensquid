# Track T-ENFORCE-WORKFLOW-GATES — the workflow gates must bite interactively

**Pre-research:** `docs/research/T-enforce-workflow-gates-pre-research-2026-06-03.md`
(root cause verified file:line — the workflow gates are automation-mode-only, so
interactive sessions had zero research-before-code/spec/phase enforcement; the
mode-independent FSM gates were never activated).

**Deliverable:** the agent CANNOT do implementation work before a guess-free
pre-research artifact exists — enforced in interactive mode, not just automation.

### Tasks

- **EWG.1 — Broaden the research-before-code gate** _(code; shipped)_.
  `scope-fsm`'s gate blocked only `src/`; broaden to `src/ ∪ packs/ ∪ test/` (all
  implementation), keeping `docs/research` + `docs/tasks` writable (the workflow
  artifacts). + test that packs/ and test/ writes are blocked pre-research.
- **EWG.2 — Make the guess-audit runnable** _(live config)_. Write
  `~/.opensquid/models.yaml` mapping `reasoning` + `fast_classifier` →
  `{mode: subscription, impl: cli, cli: claude}` (the user's CLI; no API key).
- **EWG.3 — Activate the mode-independent FSM gates at PROJECT scope** _(live
  config + manifest fix)_. Add `scope-fsm` + `workflow-fsm` to
  `<loop>/.opensquid/active.json` (the umbrella root the session runs from —
  project scope resolves from `process.cwd()`, `bootstrap.ts:289,302`, so the loop
  scope is what an umbrella session sees; the opensquid-scope copy stays for direct
  opensquid sessions) — **NOT** user scope (user scope would gate RaumPilates;
  "don't touch RaumPilates"). The existing user-scope discipline packs stay as-is.
- **EWG.3.1 — Remove the dead `detected_by: [user_pinned]` gate** _(code; the
  activation no-op fix)_. Opt-in alone was insufficient: both FSM manifests gated
  load on `user_pinned`, a DetectionContext signal that is never populated
  (`bootstrap.ts` `buildDetectionContext` leaves it false), so the real non-null
  `ctx` path (`discovery.ts:241`) excluded them despite the opt-in. Remove the
  `detected_by` block from both manifests — opt-in via `active.json` IS the pin; an
  empty `detectedBy[]` always matches (`discovery.ts:194`). Verified live: the gate
  then loaded (`packs=6`) and DENIED a fresh-session `src/`/`packs/` write.

### Locked decisions

1. Workflow gates go mode-independent; the politeness gates (d9-guard) stay
   automation-only (they're legitimately interactive-OK).
2. Coverage = `src/ ∪ packs/ ∪ test/`.
3. `reasoning` → subscription/cli/`claude`.
4. PROJECT-scope activation at the LOOP umbrella root (where the session's
   `process.cwd()` resolves) + an opensquid-scope copy, not user scope —
   RaumPilates untouched.
5. The FSM packs carry NO `detected_by` (opt-in via active.json is the pin);
   `user_pinned` is unimplemented and would silently disable them.

### Consequence (intended)

After EWG.3, an opensquid/loop session that tries to Write/Edit `src/`, `packs/`,
or `test/` while the workflow FSM is pre-`researched` is BLOCKED with a deny
message pointing at the pre-research artifact. Writing the artifact advances the
FSM to `researched`; the capable-model guess-audit then either passes (code
allowed) or loops back to `researching` until the artifact is guess-free. This is
the agent being unable to skip the workflow — by construction.
