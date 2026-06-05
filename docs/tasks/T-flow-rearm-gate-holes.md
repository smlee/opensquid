# Track T-FLOW-REARM-GATE-HOLES — close the two coding-flow gate holes (G-a, G-b)

**Pre-research:** `docs/research/T-flow-rearm-gate-holes-pre-research-2026-06-04.md`
(design fully determined; alternatives weighed; no open questions).

**Principle:** Simplicity / no-implicit-state — replace a keyword denylist on the
_enforcement_ path with a structural predicate (state + backlog count); keep the
irreducibly-heuristic language WARN as an honestly-labelled best-effort backstop, never
the guarantee. The two findings are coupled: G-a re-arms run-active so G-b's WARN can fire.
Order: RH.1 → RH.2 → RH.3.

---

### Task RH.1: G-a — structural SCOPE re-arm (kill the keyword dependency on the re-arm path)

**Required skills:** opensquid pack-FSM/skill expert; coding-flow lifecycle expert; Vitest dispatcher-integration expert; Audit expert.
**Deliverable:** a plain-language prompt arriving at a depleted `phases_complete`
(`open_task_count == 0`) re-arms the FSM to `scoping` — WITHOUT any keyword match — so the
pause-gates (which derive run-active from FSM state) re-engage for the new track. The
existing keyword path and the backlog loop are both preserved.
**Depends on:** None.

**Files affected:**

- `packs/builtin/coding-flow/skills/entry-and-handoffs/skill.yaml` (modify) — add a NEW
  `rearm-on-depletion` rule AFTER the handoff rules (see "shipped design" below; `enter-scoping`
  is left keyword-only).
- `test/builtin/coding-flow.test.ts` (modify) — 2 new integration tests (re-arm + loop-safety).

**Key code shapes** (SHIPPED design — a SEPARATE trailing rule, not a disjunct in
`enter-scoping`):

> **Design refinement found in phase 4 (test):** a structural disjunct inside `enter-scoping`
> (rule #1) re-arms to `scoping` BEFORE `handoff-task-complete` (a later rule) can read
> `st == phases_complete` — which suppressed the owed completion-report directive on the
> post-completion prompt (the AF.3 test). Fix: make the re-arm its OWN rule placed LAST, so
> the completion report fires first, then the re-arm. `enter-scoping` is therefore left
> exactly as it was (keyword-only).

```yaml
# placed AFTER handoff-task-complete (the last handoff) so the completion-report directive
# fires first on the post-completion prompt; then this re-arms for the next interaction.
- id: rearm-on-depletion
  process:
    - call: read_fsm_state
      as: st
    - call: open_task_count
      as: open
    # Structural re-arm: a depleted terminal state (phases_complete + empty backlog) means
    # the prior track is DONE → the next prompt begins a new interaction. Re-arm on a
    # state+count predicate, NOT a keyword. open==0 keeps the backlog LOOP untouched (open>0
    # → no re-arm → handoff-task-complete drives next-task). scope_start is a no-op from
    # mid-run states, so this cannot reset an in-flight run.
    - call: advance_fsm
      if: 'st == "phases_complete" && open.count == 0'
      args:
        event: scope_start
    # Strict default for the re-armed (unclassifiable, plain-language) track: feature.
    - call: write_state
      if: 'st == "phases_complete" && open.count == 0'
      args:
        key: coding-flow-track
        value: feature
```

**Test fixtures** (mirror the existing `pause-gates` describe — `dispatchEvent`,
`drivePhasesComplete`, `putPendingTask`, `registry`, `askQuestion`):

```ts
it('G-a: a PLAIN-LANGUAGE prompt at depleted phases_complete re-arms SCOPE (no keyword)', async () => {
  const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
  const sid = 'cf-ga-rearm';
  const reg = registry();
  await drivePhasesComplete(pack, sid); // phases_complete, 0 open
  // baseline: past SCOPE → a question is hard-blocked
  expect((await dispatchEvent(askQuestion, [pack], reg, sid)).exitCode).toBe(2);
  // a plain-language new-work prompt — matches NONE of spec/scope/new task/add/design/plan
  await dispatchEvent(
    { kind: 'prompt_submit', prompt: 'the null handling is broken — make it robust' },
    [pack],
    reg,
    sid,
  );
  // re-armed to scoping (interactive) → the same question is now allowed
  expect((await dispatchEvent(askQuestion, [pack], reg, sid)).exitCode).toBe(0);
});

it('G-a: a plain prompt at phases_complete WITH open tasks does NOT re-arm (loop driver intact)', async () => {
  const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
  const sid = 'cf-ga-loop';
  const reg = registry();
  await drivePhasesComplete(pack, sid);
  await putPendingTask(sid, 'next-1'); // open.count > 0
  await dispatchEvent({ kind: 'prompt_submit', prompt: 'continue' }, [pack], reg, sid);
  // still phases_complete → question stays blocked (handoff-task-complete still owns the loop)
  expect((await dispatchEvent(askQuestion, [pack], reg, sid)).exitCode).toBe(2);
});
```

**Acceptance criteria:**

- [ ] plain-language prompt at `phases_complete` + `open==0` re-arms to `scoping` (AskUserQuestion flips 2→0)
- [ ] plain prompt at `phases_complete` + `open>0` does NOT re-arm (stays blocked) — loop intact
- [ ] existing keyword `enter-scoping` + track-profile tests still pass (no regression)
- [ ] full gate chain green (`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm format:check`)

**Risk callouts:** ordering — `read_fsm_state`/`open_task_count` must be read BEFORE the
advance (the advance must see the pre-transition state). Do NOT widen to `idle` (cold-start
noise). Keep downgrades gated on `intent.matched` (do not couple them to the structural
signal — a plain track must stay strict feature).
**References:** `packs/builtin/coding-flow/skills/entry-and-handoffs/skill.yaml` (`enter-scoping`,
`handoff-rescope-nudge`); `fsm.yaml` `{from: phases_complete, on: scope_start, to: scoping}` (GF.7);
`src/functions/active_task.ts` `OpenTaskCount` (run-active derivation); `pause-prevention`/
`pause-stop-guard` (the run-active consumers); `test/builtin/coding-flow.test.ts:484-621`.
**Verification commands:** `pnpm vitest run test/builtin/coding-flow.test.ts && pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm format:check`.
**7-phase steps:** 1 pre-research DONE. 2 learn: confirm read-order + that `scope_start` is a no-op from mid-run states (so the new disjunct can't reset an in-flight run — only `phases_complete`/`idle` have the transition). 3 code: edit `enter-scoping`. 4 test: the 2 fixtures above + run the FU.3 track suite. 5 audit: no keyword on the re-arm path; loop intact; downgrades unchanged. 6 post-research: n/a. 7 fix.

---

### Task RH.2: G-b — add the decision-deferral class to `no-pause-language`

**Required skills:** opensquid pack-skill expert; regex/pattern expert; Vitest dispatcher-integration expert; Audit expert.
**Deliverable:** the `no-pause-language` retrospective WARN catches the decision-deferral
family of permission-fishing ("your call", "unless you redirect", "up to you", "let me know
which", "which/none of these", "say the word"), framed as the explicit best-effort backstop
to the hard Stop/Question blocks. Stays WARN (exit 0), not block.
**Depends on:** RH.1 (run-active must engage for a new track for the WARN to fire at all).

**Files affected:**

- `packs/builtin/coding-flow/skills/pause-prevention/skill.yaml` (modify) — `no-pause-language`
  rule: add ONE alternation to the `patterns` list + a comment naming the class.
- `test/builtin/coding-flow.test.ts` (modify) — extend the existing language-WARN test with
  the deferral variants.

**Key code shapes** (real YAML — the new pattern appended to `no-pause-language.patterns`):

```yaml
- call: text_pattern_match
  args:
    text_field: priorAssistantText
    patterns:
      - "\\b(?:should\\s+i\\s+(?:continue|proceed)|want\\s+me\\s+to|ready\\s+to\\s+(?:continue|proceed)|shall\\s+i|is\\s+(?:this|the\\s+plan)\\s+(?:ok|good|right))\\b"
      - "\\b(?:i'?ll\\s+pause|let\\s+me\\s+(?:check|pause|confirm)\\s+(?:with\\s+you|before)|pausing\\s+(?:here|now)|checkpoint\\s+here)\\b"
      - '\b(?:context\s+(?:window\s+)?limit|at\s+(?:the\s+)?(?:practical\s+)?limit|running\s+(?:low|out)\s+of\s+context)\b'
      # NEW (G-b): the decision-DEFERRAL class — handing the proceed/choice decision
      # back to the user. A coherent class (not ad-hoc phrases); a false positive is a
      # harmless non-blocking WARN, so recall is favoured over precision (same
      # asymmetry as the no-verify over-block). The HARD guarantee is the Stop/Question
      # blocks (re-armed by G-a) — this stays a retrospective best-effort nudge.
      - "\\b(?:your\\s+call|up\\s+to\\s+you|your\\s+(?:decision|choice)|unless\\s+you(?:'?d|\\s+would)?\\s+(?:rather|prefer|redirect|want|like)|if\\s+you'?d\\s+(?:rather|prefer|like)|whichever\\s+you\\s+(?:prefer|want|'?d\\s+like)|let\\s+me\\s+know\\s+(?:if|which|whether|what)|say\\s+the\\s+word|would\\s+you\\s+like\\s+me\\s+to|do\\s+you\\s+want\\s+me\\s+to|which\\s+(?:one|of\\s+these)|(?:any|none)\\s+of\\s+these)\\b"
  as: paused
```

**Test fixtures** (extend the existing `GF.6: pause/permission language stays WARN` test —
one parametrized assertion over the deferral variants):

```ts
it('G-b: decision-deferral language is caught as pause drift (WARN, not block)', async () => {
  const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
  for (const prior of [
    'Take any of these into a track? your call.',
    'I can do it, unless you redirect.',
    'Let me know which of these you want.',
    'Done — which one of these next, or none of these?',
  ]) {
    const reg = registry();
    const sid = `cf-gb-${prior.length}`;
    await dispatchEvent(scopePrompt, [pack], reg, sid); // → scoping (run active)
    const r = await dispatchEvent(
      { kind: 'prompt_submit', prompt: 'next', priorAssistantText: prior },
      [pack],
      reg,
      sid,
    );
    expect(r.exitCode).toBe(0); // WARN, never block
    expect(r.stderr).toMatch(/DRIFT/);
  }
});
```

**Acceptance criteria:**

- [ ] each deferral variant ("your call", "unless you redirect", "let me know which", "none of these") → WARN (exit 0, stderr `/DRIFT/`)
- [ ] the existing three pattern groups still match (no regression on `should i continue?` etc.)
- [ ] the rule stays `level: warn` (NOT promoted to block)
- [ ] full gate chain green

**Risk callouts:** YAML escaping — this group is a double-quoted scalar, so backslashes are
doubled (`\\b`, `\\s`) exactly like the first two groups; the third group is single-quoted
(single backslashes). Match the host scalar's quoting. Keep it ONE alternation (one class),
not N new list entries. Do not anchor so tightly that "unless you'd rather" / "unless you
redirect" both miss — the `(?:'?d|\s+would)?\s+(?:rather|prefer|redirect|…)` shape covers both.
**References:** `packs/builtin/coding-flow/skills/pause-prevention/skill.yaml` (`no-pause-language`);
the verbatim user-flagged phrases in `docs/tasks/T-chat-finalize-remove-legacy.md` G-b;
`test/builtin/coding-flow.test.ts:566-579` (the existing WARN test to extend).
**Verification commands:** `pnpm vitest run test/builtin/coding-flow.test.ts && pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm format:check`.
**7-phase steps:** 1 pre-research DONE. 2 learn: confirm the scalar quoting of the target
`patterns` entry (double-quoted → `\\b`). 3 code: append the alternation + comment. 4 test:
the parametrized variants + re-run the existing WARN test. 5 audit: still WARN; no regression;
one coherent class. 6 post-research: n/a. 7 fix.

---

### Task RH.3: doc sync — mark G-a/G-b resolved, link this track

**Required skills:** opensquid docs expert; Audit expert.
**Deliverable:** the recorded findings are marked resolved with a pointer to this track; the
lexicon is checked (no new principle label is introduced, so no lexicon edit — confirm).
**Depends on:** RH.1, RH.2 (green).

**Files affected:**

- `docs/tasks/T-chat-finalize-remove-legacy.md` (modify) — annotate the "Gate-hole findings"
  block: G-a/G-b RESOLVED by `T-FLOW-REARM-GATE-HOLES` (RH.1/RH.2).
- `docs/lexicon.md` (verify-only) — confirm no new label needed (the fix is an application of
  the existing Simplicity / no-implicit-state labels); edit ONLY if a reference is owed.

**Key code shapes:**

```md
> **Gate-hole findings (RESOLVED 2026-06-04 by T-FLOW-REARM-GATE-HOLES):** (G-a) RH.1 —
> a structural SCOPE re-arm (state + backlog count) replaces the keyword dependency, so
> plain-language new work re-arms the pause-gates; (G-b) RH.2 — the decision-deferral class
> ("your call / unless you redirect / …") added to `no-pause-language`. Spec:
> docs/tasks/T-flow-rearm-gate-holes.md.
```

**Test fixtures:** n/a (docs); `pnpm format:check` validates `.md` formatting (CI gates `prettier --check`).
**Acceptance criteria:**

- [ ] the G-a/G-b block in `T-chat-finalize-remove-legacy.md` is marked resolved + links this spec
- [ ] lexicon confirmed unchanged (or a one-line reference added if owed)
- [ ] `pnpm format:check` green on the touched `.md`

**Risk callouts:** docs-only; do NOT re-touch any `src/`/`packs/` here (keep the slice clean).
**References:** `docs/tasks/T-chat-finalize-remove-legacy.md` (the findings block); `docs/lexicon.md`.
**Verification commands:** `pnpm format:check`.
**7-phase steps:** 1 pre-research DONE. 2 learn: locate the findings block. 3 code: annotate.
4 test: format:check. 5 audit: the link resolves; no stray code edits. 6 post-research: n/a. 7 fix.
