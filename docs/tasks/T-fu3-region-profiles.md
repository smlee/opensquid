# Track T-FU3-REGION-PROFILES — track-type profiles (fix/doc/trivial skip AUTHOR)

**Pre-research:** `docs/research/T-fu3-region-profiles-pre-research-2026-06-04.md`
(§1.4 `TRACK_PROFILES`; only AUTHOR is profile-dependent; string-equality gate — no
list-membership; reset-on-entry for fail-safe-strictest). Spec origin: `T-fsm-unify.md:459`.

### Task FU.3: Classify the track-type at scope entry and let fix/doc/trivial skip AUTHOR

**Required skills:** opensquid skill.yaml author expert; FSM/state primitive expert; drift-gate design expert; Vitest fixtures expert; Audit / code review expert

**Deliverable:** `enter-scoping` records a `coding-flow-track` (feature default, reset on every scope entry, downgraded to fix/doc/trivial on keyword match); the AUTHOR gate `taskcreate-spec-required` fires only when the track is NOT fix/doc/trivial. SCOPE (scope-before-code) and EXECUTE (commit gate) stay universal. Default + stale = feature (strictest); fix/doc/trivial skip task-authoring they don't need.

**Depends on:** None (the FSM + guards shipped in FU.1–FU.12).

**Files affected:**

- `packs/builtin/coding-flow/skills/entry-and-handoffs/skill.yaml` (modify) — reset + classify in `enter-scoping`.
- `packs/builtin/coding-flow/skills/scope-lifecycle/skill.yaml` (modify) — `taskcreate-spec-required` reads the track.
- `packs/builtin/coding-flow/PROFILES.md` (new) — the profile table as single source.
- `test/builtin/coding-flow.test.ts` (modify) — feature-fires / fix-skips / stale-resets fixtures.

**Key code shapes:**

```yaml
# entry-and-handoffs enter-scoping — after `advance_fsm scope_start`, reset to the
# strict default then downgrade on a fix/doc/trivial keyword (later writes win; all
# three skip AUTHOR equally, so ambiguity among them is harmless).
- call: write_state
  if: 'len(intent.matched) > 0'
  args: { key: coding-flow-track, value: feature }
- call: text_pattern_match
  args: { text_field: prompt, patterns: ['\b(?:fix|bug|patch|de-?flake|hotfix|regression)\b'] }
  as: fixm
- call: write_state
  if: 'len(intent.matched) > 0 && len(fixm.matched) > 0'
  args: { key: coding-flow-track, value: fix }
# …doc patterns → value: doc … trivial patterns → value: trivial (same shape)
```

```yaml
# scope-lifecycle taskcreate-spec-required — read the track; the block gains the
# track guard. read_state of an absent key is null → null != "fix" is true → fires
# (strictest default). fix/doc/trivial → block never fires (AUTHOR skipped).
- call: read_state
  args: { key: coding-flow-track }
  as: track
- call: verdict
  if: '(tool == "TaskCreate") && track != "fix" && track != "doc" && track != "trivial" && st != "spec_complete" && st != "tasks_loaded" && st != "phases_in_flight" && st != "phases_complete"'
  args: { level: block, message: 'BLOCKED: task authoring incomplete …' }
```

**Test fixtures:** dispatch a `prompt_submit` "add a new task/feature" → `coding-flow-track` == feature → a `TaskCreate` at `st=researched` is BLOCKED. A `prompt_submit` "fix the flaky test" → track == fix → the same `TaskCreate` is ALLOWED. Seed `coding-flow-track=fix` then a feature prompt → reset to feature → `TaskCreate` BLOCKED again (stale-track fail-safe).

**Acceptance criteria:**

- [ ] track recorded on scope entry; `taskcreate-spec-required` consults it
- [ ] fix/doc/trivial → AUTHOR gate skips; scope-before-code (SCOPE) + commit gate (EXECUTE) still fire for all tracks
- [ ] unset/stale track → feature (strictest); reset-on-entry proven
- [ ] no list-membership added to the `if:` allow-list (string equality only)
- [ ] `pnpm typecheck && pnpm lint && pnpm vitest run && pnpm build` all green

**Risk callouts:** fail-safe is STRICTEST — a stale fix-track must NOT leak into a later feature task, so reset to feature on every scope entry BEFORE any downgrade. Use string equality, not `contains(list,…)` (Simplicity; the allow-list need not grow). The AUTHOR gate is the ONLY profile-dependent one — do not touch scope-before-code or the commit gate.

**References:** `T-fsm-unify.md:459-504` (§1.4 + FU.3 spec); `packs/builtin/coding-flow/skills/entry-and-handoffs/skill.yaml:14` (enter-scoping); `.../scope-lifecycle/skill.yaml:146` (taskcreate-spec-required); `src/functions/state.ts` (read_state/write_state).

**Verification commands:** `pnpm vitest run test/builtin/coding-flow.test.ts && pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run && pnpm build`.

**7-phase steps:** 1 pre-research: DONE (allow-list string-equality + reset-on-entry fail-safe). 2 learn: lock reset→downgrade order + the track-guard predicate. 3 code: enter-scoping reset+classify, taskcreate-spec-required read_state+guard, PROFILES.md. 4 test: feature-fires / fix-skips / stale-resets. 5 audit: strictest default, no allow-list growth, SCOPE+EXECUTE untouched. 6 post-research: n/a. 7 fix.
