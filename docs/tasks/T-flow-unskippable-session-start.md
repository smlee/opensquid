# Track T-FLOW-UNSKIPPABLE — make the coding-flow structurally unskippable

**Pre-research:** `docs/research/T-flow-unskippable-session-start-pre-research-2026-06-05.md`.

**Principle:** Simplicity / fail-closed — gates must COMPOSE (closing one entry must not open
another) and never silently run un-gated. The primary hole: blocking `TaskCreate` reroutes work to
the un-gated ad-hoc-commit path. Order: FU.1 → FU.2 → FU.3 → FU.4.

---

### Task FU.1: the EXECUTE gate composes — a mid-flow code commit is NOT ad-hoc (D1)

**Required skills:** opensquid coding-flow gate expert; git-owned gate expert; FSM-state expert; Vitest dispatcher-integration expert; Audit expert.
**Deliverable:** a code commit made while the session FSM is MID-FLOW (a track is open but not
authored: `scoping`/`researching`/`researched`/`spec_authored`) is no longer waved through as
"ad-hoc" — it BLOCKS. A genuine ad-hoc commit (FSM `idle` or `phases_complete` with no open track)
still passes. Closes the seam where a blocked `TaskCreate` leaks code out via the ad-hoc path.
**Depends on:** None.

**Files affected:**

- `packs/builtin/coding-flow/skills/execute-gate/skill.yaml` (modify) — the commit-gate rule: add a
  `read_fsm_state` consult; the "no active task ⇒ allow" branch becomes "no active task AND FSM not
  mid-flow ⇒ allow"; mid-flow ⇒ block.
- `src/setup/cli/gate.ts` (modify) — the git-owned `opensquid gate commit` predicate reads session
  FSM state; mid-flow + staged code ⇒ exit non-zero (fail-closed, the real boundary).
- `src/functions/active_task.ts` (modify, if needed) — expose an `fsm_mid_flow` read (or reuse
  `read_fsm_state` in the rule) returning whether the FSM is in an open-but-unauthored region.
- `test/builtin/coding-flow.test.ts` (modify) — both branches.
- `src/setup/cli/gate.test.ts` (modify) — the git-gate predicate mid-flow vs ad-hoc.

**Key code shapes** (real — the execute-gate rule predicate):

```yaml
- id: commit-needs-phases-or-adhoc
  process:
    - call: tool_name
      as: tool
    - call: match_command
      args: { pattern: '\bgit\s+commit\b', target: tool_args.command }
      as: committing
    - call: has_active_task
      as: active
    - call: workflow_phases_complete
      as: phases
    - call: read_fsm_state
      as: st
    # MID-FLOW = a track is open but not yet authored/executing. A code commit here is NOT
    # ad-hoc — it is blocked-authoring leaking out (the F1 seam). Block it. (idle /
    # phases_complete with no active task = genuine ad-hoc, still allowed below.)
    - call: verdict
      if: '(tool == "Bash") && committing && (st == "scoping" || st == "researching" || st == "researched" || st == "spec_authored")'
      args:
        level: block
        message: >-
          BLOCKED: a code commit while the flow is MID-FLOW (state: {{st}}) is not "ad-hoc" — it is
          authoring-incomplete work. Complete SCOPE→AUTHOR (pass the spec-audit, TaskCreate) before
          committing code. Do NOT route around a blocked TaskCreate via an ad-hoc commit.
    # the existing active-task-with-incomplete-phases block stays as-is below.
```

```ts
// gate.ts — the git pre-commit predicate gains the mid-flow check (fail-closed):
const st = await readFsmStateForSession(sessionId); // 'scoping' | … | 'phases_complete'
const midFlow = ['scoping', 'researching', 'researched', 'spec_authored'].includes(st);
if (stagedHasCode && midFlow) {
  process.stderr.write(
    'opensquid gate: mid-flow code commit blocked (complete SCOPE→AUTHOR first)\n',
  );
  process.exit(1);
}
```

**Test fixtures:**

```ts
it('FU.1: a code commit while FSM is mid-flow (scoping) is BLOCKED (not ad-hoc)', async () => {
  /* drive FSM to scoping, no active task; gitCommit on staged code → exit 2 / git gate exit 1 */
});
it('FU.1: a genuine ad-hoc commit at idle / phases_complete (no open track) still passes', async () => {
  /* FSM idle or phases_complete + 0 open tasks → gitCommit allowed (exit 0) */
});
```

**Acceptance criteria:**

- [ ] mid-flow (`scoping`/`researching`/`researched`/`spec_authored`) + code commit → BLOCK
- [ ] `idle`/`phases_complete` + no open track + commit → ALLOW (ad-hoc preserved)
- [ ] active task with incomplete phases → still BLOCK (existing behavior intact)
- [ ] the git `opensquid gate commit` predicate enforces the same, fail-closed
- [ ] full gate chain green

**Risk callouts:** do NOT remove the ad-hoc allowance (legitimate for typo/unrelated commits) — only
exclude the mid-flow overlap. Keep the rule's existing `git commit` matcher; the git hook is the
hard boundary (the in-session rule is best-effort). `phases_in_flight`/`tasks_loaded` are NOT
mid-flow-blocked (they're past AUTHOR — code is expected there).
**References:** `packs/builtin/coding-flow/skills/execute-gate/skill.yaml`; `src/setup/cli/gate.ts`;
`src/functions/active_task.ts`; `test/builtin/coding-flow.test.ts:638-720` (EXECUTE gate tests).
**Verification commands:** `pnpm vitest run test/builtin/coding-flow.test.ts src/setup/cli/gate.test.ts && pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm format:check`.
**7-phase steps:** 1 pre-research DONE. 2 learn: read the exact execute-gate rule + gate.ts predicate + how readFsmState is reached from the hook. 3 code: add the mid-flow predicate to both the rule and the git gate. 4 test: both branches + no-regression on the existing EXECUTE tests. 5 audit: ad-hoc preserved; mid-flow blocked; git gate fail-closed. 6 post-research: n/a. 7 fix.

---

### Task FU.2: scope-sprawl escalation directive (D2)

**Required skills:** opensquid pack-skill expert; FSM-state expert; Vitest expert; Audit expert.
**Deliverable:** when the FSM sits in `scoping`/`researching` across repeated prompts with research
activity but no pre-research write, surface a hardening `directive` ("converge: write ONE
pre-research, stop investigating"). Soft (surface/directive, never block).
**Depends on:** FU.1.

**Files affected:**

- `packs/builtin/coding-flow/skills/scope-lifecycle/skill.yaml` (modify) OR
  `entry-and-handoffs/skill.yaml` — a prompt_submit rule reading FSM + a turn-counter state.
- `src/functions/*` (modify if a scope-dwell counter primitive is needed) — increment a
  `coding-flow-scope-dwell` state on each scoping prompt; reset on a pre-research write.
- `test/builtin/coding-flow.test.ts` (modify) — dwell ≥ threshold → directive fires.

**Key code shapes:**

```yaml
- id: scope-sprawl-nudge
  process:
    - call: read_fsm_state
      as: st
    - call: read_state
      args: { key: coding-flow-scope-dwell }
      as: dwell
    - call: verdict
      if: '(st == "scoping" || st == "researching") && dwell.value >= 3'
      args:
        level: directive
        message: >-
          CONVERGE THE SCOPE: you have been in {{st}} for several turns. Write ONE pre-research
          artifact now and advance to AUTHOR — stop open-ended investigation. (Questions belong in
          scope, but the scope must converge, not sprawl.)
```

**Test fixtures:** drive 3 scoping prompt_submits with no pre-research write → directive present;
a pre-research write resets the dwell.
**Acceptance criteria:**

- [ ] dwell ≥ 3 in `scoping`/`researching` → directive fires
- [ ] a pre-research write resets the counter (no nag after converging)
- [ ] never a block (surface/directive only)
- [ ] full gate chain green

**Risk callouts:** must NOT block — research legitimately needs multiple turns; this is a nudge. The
dwell counter is state-only (cheap), reset on the pre-research write so an honest scope sees it once.
**References:** `scope-lifecycle/skill.yaml`; `entry-and-handoffs/skill.yaml`; state functions.
**Verification commands:** `pnpm vitest run test/builtin/coding-flow.test.ts && pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm format:check`.
**7-phase steps:** 1 DONE. 2 learn: pick the host rule + the dwell-counter wiring. 3 code: counter + nudge. 4 test: dwell + reset. 5 audit: surface-only, resets. 6 n/a. 7 fix.

---

### Task FU.3: SessionStart health assurance (D3)

**Required skills:** opensquid SessionStart hook expert; pack-activation expert; Vitest expert; Audit expert.
**Deliverable:** on `startup`/`resume`, the session-start path verifies flow enforcement is live —
(a) opensquid hooks present+current, (b) a flow-gate pack (`coding-flow`) active for the umbrella,
(c) FSM loadable — and injects a LOUD `directive` when any fails, instead of running silently
un-gated.
**Depends on:** FU.1.

**Files affected:**

- `packs/builtin/default-discipline/skills/session-connection-check/skill.yaml` OR a new
  `flow-health-check` skill (modify/new) — a `session_start` rule calling a new `check_flow_health`.
- `src/functions/check_flow_health.ts` (new) — reads: hooks present in settings.json + current;
  active.json includes a gate pack; FSM state file loads. Returns a structured report.
- `src/runtime/bootstrap.ts` (modify) — register the function.
- `src/functions/check_flow_health.test.ts` (new) — healthy → null; each failure → its message.

**Key code shapes:**

```ts
// check_flow_health.ts — read-only; returns null when healthy, else an inject_context directive.
export const CheckFlowHealth: FunctionDef<…> = {
  name: 'check_flow_health', memoizable: false,
  execute: async (_a, ctx) => {
    const problems: string[] = [];
    if (!(await opensquidHooksInstalledAndCurrent())) problems.push('opensquid hooks not installed/current in ~/.claude/settings.json');
    if (!(await gatePackActiveForCwd(ctx.event.cwd))) problems.push('no flow-gate pack (coding-flow) active for this umbrella');
    if (!(await fsmStateLoadable(ctx.sessionId))) problems.push('coding-flow FSM state unreadable');
    return problems.length === 0 ? ok(null) : ok({ inject_context:
      '⛔ FLOW ENFORCEMENT NOT ACTIVE — ' + problems.join('; ') + '. Run `opensquid setup` and restart this session.' });
  },
};
```

**Test fixtures:** healthy env → null; remove the hook entry → hook-missing message; active.json
without a gate pack → pack message; unreadable FSM → FSM message.
**Acceptance criteria:**

- [ ] healthy session → no injection (silent)
- [ ] hooks missing/stale → loud directive at session start
- [ ] no gate pack active → loud directive
- [ ] FSM unreadable → loud directive
- [ ] full gate chain green

**Risk callouts:** read-only + fail-open (a crash in the check must not block the session — return
null). Cannot self-heal an already-running hook-less session (documented); it covers the NEXT
session + surfaces the condition. Idempotent (silent when healthy).
**References:** `src/runtime/hooks/session-start.ts` (contextInjections); `session-connection-check/skill.yaml`; `active.json`; `src/runtime/fsm_state.ts`.
**Verification commands:** `pnpm vitest run src/functions/check_flow_health.test.ts && pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm format:check`.
**7-phase steps:** 1 DONE. 2 learn: the settings.json hook shape + active.json read + fsm_state read. 3 code: check_flow_health + the session_start rule + register. 4 test: healthy + each failure. 5 audit: read-only, fail-open, silent-when-healthy. 6 n/a. 7 fix.

---

### Task FU.4: the discipline lesson + docs/release (D4)

**Required skills:** opensquid docs expert; Audit expert.
**Deliverable:** a recorded lesson (memory) — when a gate blocks, fix the state to pass it honestly,
never take the ad-hoc/bypass path — plus CHANGELOG + version bump.
**Depends on:** FU.1, FU.2, FU.3 (green).

**Files affected:**

- `~/.claude/projects/.../memory/` (new memory; NOT git) — the gate-bypass discipline lesson.
- `CHANGELOG.md` (modify) — the FU entries under a new version.
- `package.json` (modify) — patch bump.

**Key code shapes:** Keep-a-Changelog `### Fixed` block describing the gate-composition fix.
**Test fixtures:** n/a; `pnpm format:check` on the `.md`.
**Acceptance criteria:**

- [ ] CHANGELOG entry + version bump (verified)
- [ ] the lesson memory written + indexed in MEMORY.md
- [ ] `pnpm format:check` green

**Risk callouts:** version bump is a MUTATION — re-read after; format:check LAST.
**References:** `CHANGELOG.md`; `package.json`; the memory dir.
**Verification commands:** `pnpm format:check`.
**7-phase steps:** 1 DONE. 2 learn: current version. 3 code: bump + entry + memory. 4 test: format. 5 audit: version re-read. 6 n/a. 7 fix.
