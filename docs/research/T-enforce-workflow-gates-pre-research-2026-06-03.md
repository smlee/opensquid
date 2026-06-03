# Pre-research — T-ENFORCE-WORKFLOW-GATES (make the workflow gates actually bite)

**Date:** 2026-06-03. **Repo:** opensquid. **Trigger:** the agent skipped the
7-phase workflow on the C2/C3 fix (no pre-research doc, no spec, no phase log) and
NOTHING blocked it — proving the enforcement layer does not enforce interactively.

## 1. Root cause (verified, file:line)

1. **Hooks ARE installed.** `~/.claude/settings.json` registers
   `opensquid-hook-pretooluse / -userpromptsubmit / -stop / -sessionend`
   (verified by grep). So every host event flows through `dispatchEvent`.
2. **The active workflow gates are AUTOMATION-MODE-ONLY → no-op interactively.**
   - `packs/builtin/scope-architect/skills/scope-before-code/skill.yaml:19-25` —
     gates on `is_automation_mode` (`if: auto.value == true && … contains(file_path,"src/")`).
   - `~/.opensquid/packs/sangmin-personal-rules/skills/workflow/skill.yaml:3-16` —
     header: _"automation OFF → dispatcher skips (interactive commits unaffected)."_
   - Confirmed gates that key on `is_automation_mode`: scope-before-code,
     task-list-generated, d9-guard (×2).
   - The live session is **interactive** (`is_automation_mode` false) → all of
     these are no-ops.
3. **The mode-INDEPENDENT FSM gates are NOT active.** `~/.opensquid/active.json`
   = `["sangmin-personal-rules","default-discipline","scope-architect","task-spec-author"]`.
   `workflow-fsm` and `scope-fsm` (built this session, no automation gate) are
   absent → dormant.
4. **The guess-audit can't run yet.** `scope-fsm`'s audit calls `subagent_call`
   with the `reasoning` alias; the user has **no `~/.opensquid/models.yaml`**
   (verified), so the alias is unmapped → the audit would error. The `claude`
   CLI exists at `~/.local/bin/claude` (verified) and `subscription/cli` mode
   needs no API key (`src/models/types.ts:13,23-44`).

**Net:** interactive sessions had ZERO research-before-code / spec / phase
enforcement, and the gates that would enforce regardless of mode were never
turned on.

## 2. Fix design (derived from the above)

- **D1 — Activate the mode-independent FSM gates.** Add `workflow-fsm` +
  `scope-fsm` to `~/.opensquid/active.json`. They have no `is_automation_mode`
  guard, so they enforce in BOTH modes.
- **D2 — Broaden research-before-code coverage.** `scope-fsm`'s gate blocks only
  `contains(file_path,"src/")`. Code lives in `src/`, `packs/`, and `test/` too —
  broaden the gate so implementation work of ANY kind is blocked pre-research.
  (Keep docs/research + docs/tasks writable — those ARE the workflow artifacts.)
- **D3 — Make the guess-audit runnable.** Write `~/.opensquid/models.yaml`
  mapping `reasoning` + `fast_classifier` → `{mode: subscription, impl: cli, cli:
claude}` (the user's subscription CLI, no key). Then the audit executes.
- **D4 — Keep the politeness gates automation-only.** d9-guard ("don't ask
  should-I-proceed") is legitimately interactive-OK per
  [[project_opensquid_automation_layer]] — only the WORKFLOW gates
  (research-before-code, spec-before-code, phase-before-commit) go
  mode-independent. Do NOT touch d9-guard's `is_automation_mode` gate.

## 3. Decisions (explicit; no unresolved guesses)

1. **Mode-independence applies to WORKFLOW gates only**, not the drift/politeness
   gates. Derived from the distinction the user locked in
   [[project_opensquid_automation_layer]] (d9-guard automation-only because a
   question is legit interactively; the scope/workflow discipline is the part
   that must always hold).
2. **Coverage = `src/` ∪ `packs/` ∪ `test/`.** Derived: these are the three
   implementation trees in opensquid; a gate that only catches `src/` lets pack
   - test work skip the workflow (exactly what happened — most C2/C3 edits were
     `packs/` + `test/`).
3. **`reasoning` → subscription/cli/claude.** Derived: the user has the `claude`
   CLI and no API key; subscription/cli is the only viable backend (verified
   `src/models/types.ts`). The user can re-map later; this is a working default.
4. **Live-config writes** (`active.json`, `models.yaml`) are in `~/.opensquid`
   (NOT a git repo — [[reference-user-pack-not-a-git-repo]]); reversible by edit.

## 4. Open questions — none that block. (The phase-before-commit gate's

mode-independence is a follow-up consideration: the personal-rules `workflow`
skill is user-pack-owned; broadening it interactively is the user's call to make
on their own pack. This task covers the research/spec-before-CODE enforcement,
which is the gap that let the C2/C3 fix proceed.)

### Key files

- `~/.opensquid/active.json`, `~/.opensquid/models.yaml` (live config).
- `packs/builtin/scope-fsm/skills/scope-lifecycle/skill.yaml` (the research-before-code gate to broaden).
- `src/functions/is_automation_mode.ts`, `src/models/types.ts` (the mode + model facts).

## 5. Deeper root cause found during verification (the activation no-op)

D1's `active.json` opt-in was necessary but NOT sufficient — after adding
`scope-fsm`/`workflow-fsm`, the hook still loaded only the 4 user-scope packs
(`[opensquid-dispatch] … packs=4`, EXIT=0; the gate never fired). Verified chain:

1. **Project scope resolves from `process.cwd()`, not the edited file's path.**
   `bootstrap.ts:289,302` — `loadActivePacks` does `resolveProjectScopeRoot(process.cwd())`.
   The session's cwd is the umbrella root `~/projects/loop` (the user starts Claude
   at the parent root, never a sub-repo), so an `active.json` placed only under
   `~/projects/opensquid/.opensquid` was off the resolution path. **Fix:** activate
   at the loop umbrella scope `~/projects/loop/.opensquid/active.json` (covers
   loop + opensquid + loop-engine work done from the umbrella session; RaumPilates
   is a separate cwd, untouched). Keep the opensquid-scope copy for direct sessions.
2. **`detected_by: [user_pinned]` gated the packs OFF even when opted in.**
   Both manifests carried `detected_by: [{kind: user_pinned}]`. But the
   `user_pinned` DetectionContext signal is never populated (`bootstrap.ts`
   `realPacksPromise` / `buildDetectionContext` leave `userPinned` false — its own
   comment says so). At `discovery.ts:241` the real loader passes a non-null `ctx`,
   so each pack must satisfy `matchesDetectedBy(detectedBy, ctx)`; with the only
   clause being an always-false `user_pinned`, the match fails and the pack is
   excluded. (`discovery.ts:194` — an EMPTY `detectedBy[]` always matches.) The
   `ctx === null` debug path masked this (null ctx skips the gate, returned 2 packs).
   **Fix:** remove the `detected_by` block from both manifests — opt-in via
   `active.json` IS the pin; no synthetic gate on an unimplemented signal.

**Net (verified live):** with the loop-scope `active.json` + the `detected_by`
removal, the next hook invocation loaded `scope-fsm` and its `research-before-code`
gate BLOCKED an attempted `packs/` edit (`🦑 BLOCKED: research before code`) — the
enforcement now bites interactively. No unresolved guess: every step above is a
cited file:line.
