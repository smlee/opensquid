# Track T-CODING-FLOW-GAP-FIXES — close the 10 audit gaps in coding-flow

**Pre-research:** `docs/research/T-coding-flow-gap-fixes-pre-research-2026-06-04.md`
(4-agent adversarial audit + dogfooding; 10 verified findings F1–F10; the EXECUTE
boundary moves from a leaky matcher to git-owned pre-commit/pre-push hooks).

**Governing principles** (`docs/lexicon.md`): Simplicity (the EXECUTE gate becomes a total
function at an owned boundary, not a denylist heuristic); no-implicit-state (gate
primitives become total — every path returns a defined verdict, never an `err` the
dispatcher silently skips).

Execution order: **GF.7 → GF.1 → GF.4 → GF.5 → GF.6 → GF.2 → GF.3.** GF.7 re-arms the FSM
first so the SCOPE gate re-engages for the rest; the big GF.2 (git-hook subsystem) lands
after the small pack/primitive fixes are green.

---

### Task GF.7: Re-arm the flow for a new track (F10)

**Required skills:** opensquid FSM author; total-transition-FSM expert; Vitest expert; Audit / code review expert
**Deliverable:** a new scope-authoring prompt after a run has reached `phases_complete` re-arms the SCOPE gate (FSM `phases_complete --scope_start--> scoping`), so a new track in a live session is gated. Totality preserved; the existing `idle → scoping` path and mid-run no-op semantics are unchanged.
**Depends on:** None (unblocks gated execution of the rest).

**Files affected:**

- `packs/builtin/coding-flow/fsm.yaml` (modify) — add the re-arm transition.
- `test/builtin/coding-flow.test.ts` (modify) — re-arm coverage.

**Key code shapes:**

```yaml
# fsm.yaml — after the CODE region. A completed run re-arms on a fresh scope intent.
# scope_start stays a no-op from every other non-idle state (already true), so this
# ONLY affects the terminal state — you cannot reset mid-authoring.
- { from: phases_complete, on: scope_start, to: scoping }
```

**Test fixtures:** seed the FSM to `phases_complete` (via the advanceFsmState chain), dispatch a `prompt_submit` whose prompt matches a scope keyword (`enter-scoping`), assert the FSM advances to `scoping`. A second case: from `spec_authored`, `scope_start` stays `spec_authored` (mid-run no-op unchanged).

**Acceptance criteria:**

- [ ] `step(fsm, 'phases_complete', 'scope_start') == 'scoping'`
- [ ] `idle → scoping` unchanged; `spec_authored --scope_start--> spec_authored` (no-op)
- [ ] `validateFsm` totality passes on the merged machine
- [ ] full gate chain green

**Risk callouts:** do NOT make `scope_start` valid from arbitrary mid-run states (would let a stray scope keyword reset an in-flight authoring run). ONLY `phases_complete` re-arms. Confirm the `loopback_gate` flow still merges before `validateFsm`.
**References:** `packs/builtin/coding-flow/fsm.yaml:25,44`; `src/runtime/fsm.ts:71` (validateFsm), `:104-112` (step).
**Verification commands:** `pnpm vitest run test/builtin/coding-flow.test.ts && pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run && pnpm build`.
**7-phase steps:** 1 pre-research DONE (F10 mechanism). 2 learn: lock "only phases_complete re-arms". 3 code: the one transition. 4 test: re-arm + mid-run no-op. 5 audit: totality, no mid-run reset. 6 post-research: n/a. 7 fix.

---

### Task GF.1: Restore cross-pack profession wiring (F1 + F9)

**Required skills:** opensquid pack-manifest author; profession-resolver expert; skill.yaml author; Vitest cross-pack-dispatch expert; Audit expert
**Deliverable:** the SCOPE→AUTHOR handoff fires (`task-spec-author` is `usage: profession`, so `handoff-research-to-spec` resolves instead of being dropped `wrong-usage`), and the re-scope nudge surfaces (moved to a `prompt_submit` handoff on the `scoping` state; the dead `tool_call` directive in `task-start` is removed, its FSM reset kept).
**Depends on:** [GF.7](#task-gf7-re-arm-the-flow-for-a-new-track-f10).

**Files affected:**

- `packs/builtin/task-spec-author/manifest.yaml` (modify) — add `usage: profession`.
- `packs/builtin/coding-flow/skills/entry-and-handoffs/skill.yaml` (modify) — add a `scoping`-state nudge handoff.
- `packs/builtin/coding-flow/skills/task-start/skill.yaml` (modify) — drop the dropped directive, keep `advance_fsm task_unscoped`.
- `test/builtin/coding-flow.test.ts` (modify).

**Key code shapes:**

```yaml
# task-spec-author/manifest.yaml — mirror scope-architect/manifest.yaml:30.
usage: profession
```

```yaml
# entry-and-handoffs/skill.yaml — a prompt_submit nudge on the re-armed scoping state.
- id: handoff-rescope-nudge
  process:
    - call: read_fsm_state
      as: st
    - call: verdict
      if: 'st == "scoping"'
      args:
        level: directive
        next_action:
          profession: scope-architect
          rationale: >-
            SCOPE re-armed (state: scoping). Author the pre-research artifact to
            teach-back depth before any code — hand off to the scope-architect persona.
```

**Test fixtures:** (a) load coding-flow + task-spec-author, drive to `researched`, dispatch `prompt_submit`, assert the `handoff-research-to-spec` directive resolves (NOT `wrong-usage`) — i.e. `r.directives` carries the task-spec-author profession action. (b) FSM at `scoping`, `prompt_submit` → the scope nudge directive surfaces.

**Acceptance criteria:**

- [ ] `task-spec-author` manifest has `usage: profession`; pack loads with its team
- [ ] the SCOPE→AUTHOR handoff resolves across packs (not dropped)
- [ ] a `scoping`-state prompt_submit surfaces the scope-architect nudge
- [ ] `task-start` no longer emits a directive on tool_call; its FSM reset still fires
- [ ] full gate chain green

**Risk callouts:** confirm `loadPack` loads `task-spec-author`'s `team.yaml` once `usage: profession` is set (`loader.ts:215`). Do not break the existing 4 handoffs in entry-and-handoffs.
**References:** `packs/builtin/task-spec-author/manifest.yaml`; `scope-architect/manifest.yaml:30`; `entry-and-handoffs/skill.yaml:75-95,137-155`; `task-start/skill.yaml:13-40`; `src/runtime/hooks/profession_resolver.ts:59-63`; `dispatch.ts:432,444-450`.
**Verification commands:** `pnpm vitest run test/builtin/coding-flow.test.ts && pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run && pnpm build`.
**7-phase steps:** 1 pre-research DONE (F1/F9 + resolver path). 2 learn: lock usage + nudge-on-scoping. 3 code: manifest + two skills. 4 test: cross-pack resolve + nudge. 5 audit: handoff resolves, no dropped directive. 6 post-research: n/a. 7 fix.

---

### Task GF.4: Fail CLOSED + require an audited spec (F6 + F7)

**Required skills:** opensquid runtime/functions expert; total-function/error-handling expert; dispatch-semantics expert; Vitest expert; Audit expert
**Deliverable:** the three gate primitives fail CLOSED — on a caught exception they return the conservative `ok` (block fires), not `err` (silently skipped). `scope-before-code` requires an AUTHOR-audited spec (state ∈ {spec_complete,tasks_loaded,phases_in_flight,phases_complete}), not mere spec-file existence at `researched`.
**Depends on:** [GF.7](#task-gf7-re-arm-the-flow-for-a-new-track-f10).

**Files affected:**

- `src/functions/active_task.ts` (modify) — `has_generated_spec`, `has_active_task`, `workflow_phases_complete` catch → conservative `ok`.
- `packs/builtin/coding-flow/skills/scope-lifecycle/skill.yaml` (modify) — tighten the allow set.
- `src/functions/active_task.test.ts` + `test/builtin/coding-flow.test.ts` (modify).

**Key code shapes:**

```ts
// active_task.ts — fail CLOSED: a thrown read becomes the conservative ALLOW-NOTHING
// verdict, never an err the dispatcher skips (dispatch.ts:462). Total contract.
} catch {
  return ok({ present: false, generated: false }); // has_generated_spec
}
// has_active_task   catch → ok({ present: false, id: '', task_id: '' })
// workflow_phases_complete catch → ok({ active: false, complete: false })
```

```yaml
# scope-lifecycle/skill.yaml scope-before-code — drop researched + spec_authored from the
# code-allow set: code requires a spec_complete-audited spec.
if: '… && (spec.generated == false || (st != "spec_complete" && st != "tasks_loaded" && st != "phases_in_flight" && st != "phases_complete"))'
```

**Test fixtures:** force each primitive to throw (e.g. point OPENSQUID_HOME at an unreadable path / stub the reader to throw) and assert it returns the conservative `ok` (not `err`); dispatch a code-write with the FSM at `researched` + a stub spec on disk and assert exit 2 (BLOCKED).

**Acceptance criteria:**

- [ ] each of the 3 primitives returns conservative `ok` on a thrown internal read
- [ ] a code-write at `researched` (spec file present, not audited) → BLOCKED
- [ ] the existing scope-before-code pass cases (spec_complete+) stay green
- [ ] full gate chain green

**Risk callouts:** do not swallow real logic errors silently elsewhere — only the outer catch becomes conservative-`ok`; keep the value paths intact. Update the header comment (`active_task.ts:11-14`) to state the now-true fail-closed contract.
**References:** `src/functions/active_task.ts:49-57,76-89,126-143`; `src/runtime/hooks/dispatch.ts:462,554`; `scope-lifecycle/skill.yaml:177-188`.
**Verification commands:** `pnpm vitest run src/functions/active_task.test.ts test/builtin/coding-flow.test.ts && pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run && pnpm build`.
**7-phase steps:** 1 pre-research DONE (F6/F7 + dispatch skip). 2 learn: conservative-ok contract. 3 code: 3 catches + allow-set. 4 test: forced-throw + researched-block. 5 audit: no fail-open path remains. 6 post-research: n/a. 7 fix.

---

### Task GF.5: Scope the track downgrade per-intent (F5)

**Required skills:** opensquid skill.yaml author; regex/intent-classification expert; Vitest expert; Audit expert
**Deliverable:** the fix/doc/trivial downgrade applies ONLY when a fix/doc/trivial keyword is present AND no feature-intent keyword is — a mixed-intent prompt stays `feature` (strictest), so one stray "fix" can no longer disable the AUTHOR gate for a whole session.
**Depends on:** [GF.7](#task-gf7-re-arm-the-flow-for-a-new-track-f10).

**Files affected:**

- `packs/builtin/coding-flow/skills/entry-and-handoffs/skill.yaml` (modify) — guard the downgrade with a feature-intent negative.
- `packs/builtin/coding-flow/PROFILES.md` (modify) — document the mixed-intent rule.
- `test/builtin/coding-flow.test.ts` (modify).

**Key code shapes:**

```yaml
# entry-and-handoffs/skill.yaml — add a feature-intent probe; gate each downgrade on its absence.
- call: text_pattern_match
  args:
    text_field: prompt
    patterns: ['\b(?:build|add|feature|implement|refactor|new\s+(?:feature|module|endpoint))\b']
  as: featm
# each downgrade write now: if: 'len(intent.matched) > 0 && len(fixm.matched) > 0 && len(featm.matched) == 0'
```

**Test fixtures:** "build the export feature and fix the header" → track stays `feature` → TaskCreate BLOCKED until spec_complete; "fix the flaky transport test" → `fix` → AUTHOR skipped (unchanged); "update the changelog" → `doc`.

**Acceptance criteria:**

- [ ] mixed feature+fix prompt → track `feature` (AUTHOR gate fires)
- [ ] pure fix/doc/trivial prompt → downgraded (unchanged behavior)
- [ ] the per-scope-entry reset to `feature` still precedes the probes
- [ ] full gate chain green

**Risk callouts:** keep the reset-to-feature FIRST so a prior track can't leak. The feature-keyword list must not be so broad it blocks legitimate pure-fix tracks (no `change|update|edit`).
**References:** `entry-and-handoffs/skill.yaml:31-74`; `scope-lifecycle/skill.yaml:206-213`; `PROFILES.md`.
**Verification commands:** `pnpm vitest run test/builtin/coding-flow.test.ts && pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run && pnpm build`.
**7-phase steps:** 1 pre-research DONE (F5). 2 learn: mixed-intent → strictest. 3 code: probe + guarded downgrades. 4 test: mixed/pure/doc. 5 audit: reset-first preserved. 6 post-research: n/a. 7 fix.

---

### Task GF.6: Pause-gates hard-block + widen coverage (F8)

**Required skills:** opensquid skill.yaml author; dispatch verdict-level expert; pause-lifecycle expert; Vitest expert; Audit expert
**Deliverable:** the three pause verdicts hard-block (`block`, exit 2) instead of `warn`; `no-stop-mid-run` also fires at `researched` and at `phases_complete` when `open_task_count > 0`, while preserving the depletion auto-OFF (idle OR phases_complete∧0-open → allowed).
**Depends on:** [GF.7](#task-gf7-re-arm-the-flow-for-a-new-track-f10).

**Files affected:**

- `packs/builtin/coding-flow/skills/pause-stop-guard/skill.yaml` (modify) — block + widen states.
- `packs/builtin/coding-flow/skills/pause-prevention/skill.yaml` (modify) — block.
- `test/builtin/coding-flow.test.ts` (modify).

**Key code shapes:**

```yaml
# pause-stop-guard/skill.yaml — block, and include researched + phases_complete∧open.
- call: read_fsm_state
  as: st
- call: open_task_count
  as: open
- call: verdict
  if: 'st == "researched" || st == "spec_authored" || st == "spec_complete" || st == "tasks_loaded" || st == "phases_in_flight" || (st == "phases_complete" && open.count > 0)'
  args: { level: block, message: 'DRIFT: you stopped mid-run …' }
```

**Test fixtures:** `stop` at `researched` / `phases_in_flight` / `phases_complete`+1-open → exit 2; `stop` at `idle` and `phases_complete`+0-open → exit 0; `AskUserQuestion` after scope (FSM past researched) → exit 2.

**Acceptance criteria:**

- [ ] the three verdicts are `level: block`
- [ ] stop at researched / mid-run / phases_complete+open → BLOCK
- [ ] stop at idle / phases_complete+0-open → ALLOW (depletion auto-OFF preserved)
- [ ] full gate chain green

**Risk callouts:** the `open_task_count > 0` condition is load-bearing — without it a finished, depleted run would be blocked from ever stopping. On the `stop` event `open_task_count` falls back to the harness store read (no `event.openTasks`); confirm that path returns the real count.
**References:** `pause-stop-guard/skill.yaml:8-20`; `pause-prevention/skill.yaml:18-50`; `src/functions/active_task.ts:208-227` (open_task_count); `dispatch.ts:489-547`.
**Verification commands:** `pnpm vitest run test/builtin/coding-flow.test.ts && pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run && pnpm build`.
**7-phase steps:** 1 pre-research DONE (F8). 2 learn: block + depletion-preserving widen. 3 code: two skills. 4 test: block/allow matrix. 5 audit: depletion auto-OFF intact. 6 post-research: n/a. 7 fix.

---

### Task GF.2: Owned-boundary EXECUTE gate — git pre-commit + pre-push (F2 + F3 + F4-core)

**Required skills:** opensquid CLI/setup-wizard author; git-hook integration expert; out-of-band session-resolution expert; Vitest + child-process test expert; Audit expert
**Deliverable:** opensquid installs managed `pre-commit` + `pre-push` git hooks into gated repos; each resolves the live session out-of-band, reads the real staged/pushed diff + FSM/phase/active-task state, and blocks unless the active task is `phases_complete` with a `spec_complete`-audited spec AND a complete 7-phase ledger. `opensquid doctor git-hooks` verifies installation. The doctor probe no longer clobbers `.current-session`.
**Depends on:** [GF.4](#task-gf4-fail-closed--require-an-audited-spec-f6--f7) (the state-read primitives the gate logic mirrors).

**Files affected:**

- `src/setup/cli/gate.ts` (new) — the `opensquid gate commit|push` logic (resolve session, read diff + state, exit 0/2). Reuses `resolveMcpSessionId`, `readActiveTask`, `readPhaseState`/`isComplete`, `readFsmState`.
- `src/setup/wizard/git-hooks.ts` (new) — installer writing `pre-commit`/`pre-push` (with the `@opensquid` marker) into a repo's `.git/hooks`.
- `src/setup/cli/doctor.ts` (modify) — add `git-hooks` subcommand; SKIP `recordCurrentSession` on the probe path.
- bin wiring (`package.json` bin / `src/cli.ts`) for the hook entrypoints.
- `src/setup/cli/gate.test.ts` + `src/setup/wizard/git-hooks.test.ts` (new).

**Key code shapes:**

```ts
// gate.ts — total, fail-CLOSED in a gated repo, no-op in a non-gated repo.
const sid = await resolveMcpSessionId();
const gated = await isGatedRepo(cwd); // .opensquid active + coding-flow on
if (!gated) return 0; // unrelated repo: allow
if (sid === null) return blockExit('no resolvable opensquid session — cannot prove the flow ran');
const active = await readActiveTask(sid);
const fsm = await readFsmState(sid, 'coding-flow');
const phases = await readPhaseState(sid);
const ok =
  active !== null &&
  fsm === 'phases_complete' &&
  hasAuditedSpec(active) &&
  isComplete(phases, active.id);
return ok ? 0 : blockExit('staged change has not completed SCOPE→AUTHOR→7-phase');
```

```sh
# pre-commit (installed) — marker line lets `doctor git-hooks` recognize it.
#!/bin/sh
# @opensquid managed hook
exec opensquid gate commit
```

**Test fixtures:** a temp git repo with an opensquid `.opensquid/active.json` + a seeded session at `phases_complete` with a complete ledger → `gate commit` exits 0; the same with FSM `researched` → exits 2; a repo with NO `.opensquid` → exits 0 (non-gated). Installer writes both hooks with the marker; doctor reports green/red; the doctor probe leaves `.current-session` untouched.

**Acceptance criteria:**

- [ ] `opensquid gate commit|push` exits 2 in a gated repo whose session isn't flow-complete; 0 when complete; 0 in a non-gated repo
- [ ] the installer writes `pre-commit` + `pre-push` carrying the `@opensquid` marker; idempotent re-install
- [ ] `opensquid doctor git-hooks` reports installed/missing with remediation
- [ ] `opensquid doctor` no longer overwrites `.current-session` with its probe id
- [ ] full gate chain green

**Risk callouts:** FAIL CLOSED on session-resolution failure ONLY in a gated repo; NEVER block in a non-gated repo (would break every unrelated commit on the machine). Do not auto-install into arbitrary repos — install only on explicit `setup wizard git-hooks` (and document it). Hooks must be POSIX-sh + fast (a slow pre-commit pains every commit). Honor an existing non-opensquid hook (chain, don't clobber).
**References:** `src/runtime/hooks/session_id.ts:163-183` (resolveMcpSessionId); `src/runtime/session_state.ts` (readActiveTask/readFsmState); `src/runtime/workflow_phases.ts:55-111`; `src/setup/wizard/settings-writer.ts` (marker idiom + `OPENSQUID_BIN_FOR_EVENT`); `src/setup/cli/doctor.ts` (hooks check); `session_id.ts:63-85` (the clobber).
**Verification commands:** `pnpm vitest run src/setup/cli/gate.test.ts src/setup/wizard/git-hooks.test.ts && pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run && pnpm build`.
**7-phase steps:** 1 pre-research DONE (boundary thesis + session bridge). 2 learn: lock fail-closed-in-gated / no-op-in-nongated + marker idiom. 3 code: gate.ts + git-hooks.ts + doctor + bin. 4 test: gated/non-gated/installer/doctor. 5 audit: never blocks unrelated repos; chains existing hooks; probe doesn't clobber. 6 post-research: n/a. 7 fix.

---

### Task GF.3: Demote the PreToolUse code gate to a best-effort nudge + `--no-verify` detector (F4-nudge + F3-accepted)

**Required skills:** opensquid skill.yaml author; git tracked-ness expert; Vitest expert; Audit expert
**Deliverable:** `scope-before-code` becomes a best-effort `warn` nudge (fast pre-write feedback) that decides "tracked source" via git rather than substrings, with an explicit accepted-limitation note that Bash-mediated writes are caught at the commit boundary (GF.2). A narrow PreToolUse `block` catches `git commit/push --no-verify|-n` — the single closed opt-out token for the git hooks.
**Depends on:** [GF.2](#task-gf2-owned-boundary-execute-gate--git-pre-commit--pre-push-f2--f3--f4-core).

**Files affected:**

- `packs/builtin/coding-flow/skills/scope-lifecycle/skill.yaml` (modify) — `scope-before-code` → warn nudge + accepted-limitation prose; add the `--no-verify` block rule.
- `test/builtin/coding-flow.test.ts` (modify).

**Key code shapes:**

```yaml
# scope-lifecycle/skill.yaml — the no-verify detector (the one sound matcher: a closed token).
- id: no-verify-block
  process:
    - call: tool_name
      as: tool
    - call: match_command
      args:
        { pattern: 'git\b.*\bcommit\b.*(--no-verify|(^|\s)-[a-zA-Z]*n)', target: tool_args.command }
      as: skipping
    - call: verdict
      if: 'tool == "Bash" && skipping'
      args: { level: block, message: 'BLOCKED: --no-verify bypasses the opensquid git gate.' }
```

**Test fixtures:** a pre-scope `Write` to a tracked `src` file → `warn` (exit 0, surfaced), not block; `git commit --no-verify` → exit 2; a plain `git commit` → not matched by this rule (GF.2's hook governs it).

**Acceptance criteria:**

- [ ] `scope-before-code` emits `warn` (nudge), not `block`
- [ ] a `--no-verify` / `-n` commit or push is BLOCKED
- [ ] `docs/` writes are never nudged (SCOPE artifacts/specs)
- [ ] full gate chain green

**Risk callouts:** the `-n` regex must not catch unrelated short flags on other commands — anchor it to `git … commit`. The nudge being `warn` is intentional (the guarantee is GF.2); document that so a future reader doesn't "restore" it to block.
**References:** `scope-lifecycle/skill.yaml:164-188`; `execute-gate/skill.yaml:16-30` (the matcher being retired in favor of GF.2); `dispatch.ts:489-504` (warn semantics).
**Verification commands:** `pnpm vitest run test/builtin/coding-flow.test.ts && pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run && pnpm build`.
**7-phase steps:** 1 pre-research DONE (nudge vs guarantee split). 2 learn: warn nudge + closed-token block. 3 code: demote + no-verify rule. 4 test: nudge/no-verify/docs. 5 audit: docs excluded, guarantee is GF.2. 6 post-research: n/a. 7 fix.
