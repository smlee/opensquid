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
  config)_. Add `scope-fsm` + `workflow-fsm` to `<opensquid>/.opensquid/active.json`
  and `<loop>/.opensquid/active.json` — **NOT** user scope (user scope would gate
  RaumPilates; "don't touch RaumPilates"). The existing user-scope discipline
  packs stay as-is.

### Locked decisions

1. Workflow gates go mode-independent; the politeness gates (d9-guard) stay
   automation-only (they're legitimately interactive-OK).
2. Coverage = `src/ ∪ packs/ ∪ test/`.
3. `reasoning` → subscription/cli/`claude`.
4. PROJECT-scope activation (opensquid + loop), not user scope — RaumPilates
   untouched.

### Consequence (intended)

After EWG.3, an opensquid/loop session that tries to Write/Edit `src/`, `packs/`,
or `test/` while the workflow FSM is pre-`researched` is BLOCKED with a deny
message pointing at the pre-research artifact. Writing the artifact advances the
FSM to `researched`; the capable-model guess-audit then either passes (code
allowed) or loops back to `researching` until the artifact is guess-free. This is
the agent being unable to skip the workflow — by construction.
