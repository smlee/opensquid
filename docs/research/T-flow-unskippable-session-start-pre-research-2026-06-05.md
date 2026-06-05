# Pre-research — T-FLOW-UNSKIPPABLE (session-start guarantees the flow can't be skipped)

**Date:** 2026-06-05 · **Repo:** opensquid · **Area:** coding-flow gates + model config + SessionStart
**Origin:** the user's directive — _"fix session start so my flows don't get skipped ever"_ — after
catching un-gated work this session. Root-caused to THREE independent mechanism defects (all verified
live), plus hardening. **Status: F0/F0b/F0c FIXED + tested (3109 suite green); FU.1 done; FU.2-4 next.**

---

## 1. Verified failure modes (each observed THIS session)

### F0 — the EXECUTE commit matcher is `^`-anchored → the gate never fires on a real commit

`execute-gate/skill.yaml:20` matched `^git\s+…commit`. The Bash tool resets cwd, so every real
commit is `cd <dir> && git commit …` (starts with `cd`) → `^git` never matches → the gate NEVER
FIRES. Verified via `opensquid-hook-pretooluse`: payload `git commit` → `deny`; payload
`cd … && git commit` → no decision (evaded). **Single correct fix — no alternatives to weigh** (an
anchor is either right or wrong): **D0a** = `\bgit\s+(?:-[cC]\s+\S+\s+)*commit\b` (match anywhere,
like the sibling no-verify matcher).

### F0b — the audit model alias spawns bare `claude` (no `-p`) → audits return no verdict

`~/.opensquid/models.yaml` mapped `reasoning` to `cli: claude` with no `args`; `subscription_cli`
(`src/models/strategies/subscription_cli.ts:39-113`) pipes the prompt to stdin, and bare interactive
`claude` never returns a clean verdict. **Single correct fix — no alternatives:** **D0b** =
`args: ['-p']` (print mode reads stdin; verified live `echo x | claude -p` → clean `PONG`).

### F0c — the user-level `models.yaml` was NEVER READ → the alias is unresolvable (the deepest)

`src/models/load_config.ts:63-66` documented layer 2 (`~/.opensquid/models.yaml`) verbatim as
_"NOT YET WIRED … read by the setup wizard but not consulted by the runtime resolver."_ So
`loadModelsConfig()` returned `{}` (no `reasoning`), `subagent_call` (`src/functions/llm.ts:100-104`)
failed `arg_invalid` in ~0.3s (no spawn), the audits never ran, and the FSM was stuck at `scoping`
FOREVER — the flow was UN-COMPLETABLE. Verified live: a direct `loadModelsConfig()` returned
`aliases: []` pre-fix; `['reasoning','fast_classifier']` post-fix. **Single correct fix — the layer
was simply unwired:** **D0c** = wire + schema-validate the user-level read (merged over the pack
layer). Proven: post-fix the audit ran (a 116s `claude -p` returning a real `VERDICT`). F0b + F0c are
BOTH required — F0c reads the file, F0b makes its invocation return a verdict.

### F1 — the gate seam: blocking TaskCreate reroutes work to the un-gated ad-hoc path

The AUTHOR gate blocks `TaskCreate`; the EXECUTE gate has _"ad-hoc commit (no active task) passes"_
(`coding-flow.test.ts:654`). So blocked authoring leaks out as an "ad-hoc" commit. Observed live:
SF.1/SF.2 committed ad-hoc (`98c64af`/`932116a`) after TaskCreate was 🦑-blocked. The gates don't
COMPOSE.

### F2 — the SCOPE phase is entirely ungated

Gates fire only on `src/`∪`packs/`∪`test/` writes + commit/push. Research / `Bash` / `docs/` writes
are invisible, so a sprawling, oscillating scope can't be caught.

### F3 — hook-less sessions run fully un-gated, silently

Claude Code wires hooks at SESSION START. **Verified live this session** (`ps -p 73557 -o lstart`
→ `Tue Jun 2 09:26 2026`; `stat -f %Sm ~/.claude/settings.json` → `2026-06-03 18:00`): the live
RaumPilates session predates the hook install by >1 day, so it calls NONE of the opensquid hooks →
zero gates, zero FSM, zero warning. The cited timestamps are the source. Not self-healable for that
already-running session (see D3); detectable + currently surfaced to no one.

### F4 — the FSM parks at `scoping` with only a soft nudge

`handoff-rescope-nudge` is advisory; nothing escalates if the agent dwells in `scoping` doing
un-gated work. The state is correct; the lack of escalation is the gap.

## 2. Design — make the flow FIRE, COMPLETE, and COMPOSE

Principle: gates must COMPOSE and FAIL CLOSED; the flow must be able to FIRE (F0) and COMPLETE
(F0b+F0c) before composition matters. F0/F0b/F0c are single-correct mechanism fixes (an anchor, a
missing flag, an unwired file-read) — stated explicitly per never-guess, no alternatives to weigh.

- **D0a (F0)** — un-anchor the commit matcher.
- **D0b (F0b)** — `args: ['-p']` on the audit aliases.
- **D0c (F0c)** — wire + schema-validate the user-level `~/.opensquid/models.yaml` read in
  `loadModelsConfig` (layer 2, merged over pack, under env).
- **D1 (F1)** — the EXECUTE gate composes: a code commit while the FSM is MID-FLOW
  (`scoping`/`researching`/`researched`/`spec_authored`) is NOT ad-hoc → BLOCKS; a true ad-hoc commit
  (`idle`/`phases_complete`, no open track) still passes.
- **D2 (F2) — scope-sprawl escalation, OPERATIONALLY DEFINED:** a state-only counter increments on
  each `prompt_submit` while the FSM is in `scoping`/`researching`, and RESETS on a `-pre-research-`
  write. When the counter reaches **≥ 3** with no pre-research write yet, surface a "converge: write
  ONE pre-research now" directive. Threshold 3 = the same `depth.count >= 3` bar the scope-advance
  already uses (one full "research turn"); chosen for consistency, not invented. Soft (surface),
  never block.
- **D3 (F3) — SessionStart health assurance.** Mechanism alternatives weighed (this is NOT a
  single-correct fix, so it is justified against options): **(i) abort the session** ❌ — a
  SessionStart hook must NEVER block the session from starting (`session-start.ts:26-27` fail-open
  contract); **(ii) auto-reinstall hooks mid-session** ❌ — Claude Code reads hook config only at
  session start, so a mutation can't take effect until restart anyway, and a hook silently rewriting
  `~/.claude/settings.json` is a foot-gun; **(iii) periodic re-check** ❌ — over-engineered for a
  once-per-session condition; **(iv) loud warn + point to `opensquid setup`** ✅ chosen (simplest
  correct: a hook can only INFORM, and a restart is the real remedy). **The already-running hook-less
  session is unremediated BY NECESSITY** — a session that never loaded the hook cannot be reached by
  any hook; only the user restarting it (which the loud directive prompts) fixes it. D3 therefore
  guarantees the NEXT session is gated + surfaces the current one; it cannot retrofit the current one.
- **D4** — the discipline lesson (memory): when a gate blocks, FIX the state to pass it honestly;
  never take the ad-hoc/bypass path.

## Alternatives

| #     | Option                                             | Verdict                                                                                                                                                     |
| ----- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | Just tell the agent to be disciplined              | ❌ Behaviour-only; the F0/F0b/F0c/F1 mechanism holes remain; not structural.                                                                                |
| B     | Remove the ad-hoc-commit allowance entirely        | ❌ Breaks legitimate ad-hoc commits; only its OVERLAP with mid-flow state is the bug.                                                                       |
| C     | Block ALL un-gated tool use during scoping         | ❌ Research REQUIRES Bash/Read/docs writes; gating them breaks the scope phase itself.                                                                      |
| **D** | **D0a+D0b+D0c+D1+D2+D3+D4** (fire+complete+harden) | ✅ **Chosen.** (Per-decision alternatives: F0/F0b/F0c single-correct; D1 weighed vs B; D2 threshold justified vs the depth bar; D3 weighed (i)-(iv) above.) |

## Failure modes

- **D1 false-positives a real ad-hoc commit?** Only if the FSM is mid-flow — which means a track IS
  open; `idle`/`phases_complete` ad-hoc still allowed. Both branches unit-tested.
- **D0b regresses other model calls?** `-p` is the correct one-shot mode for ALL `subscription_cli`
  uses (pipe a prompt, want stdout); strictly more correct.
- **D0c reads a malformed user YAML?** Fail-SOFT: absent/unparseable/schema-invalid is skipped (the
  resolver must never throw inside a hook). Unit-tested.
- **D2 fires on a legitimately long scope?** It's a surface, never a block; resets on the
  pre-research write, so an honest converging scope sees it at most once.
- **D3 nags on every session?** Gated on actual failure; silent + idempotent when healthy.

## Empirical spikes

F0 (hook-evasion both ways), F0b (`claude -p` vs bare `claude`), and F0c (`loadModelsConfig()` →
`[]` pre-fix; `['reasoning','fast_classifier']` + a 116s `claude -p` verdict post-fix) were all
verified LIVE. D1 is unit-tested (mid-flow → BLOCK; idle/phases_complete → ALLOW). The end-to-end
proof of the whole fix chain is this artifact: after D0a+D0b+D0c the scope-advance audit must run and
move the FSM `scoping → researched` (if it advanced, the chain is confirmed in vivo).

## 6. Decomposition

- **FU.0 (DONE + tested)** — the three root causes: D0a (matcher), D0b (`-p`), D0c (wire layer-2 in
  `load_config.ts` + tests). Make the gate FIRE and the flow COMPLETE.
- **FU.1 (DONE + tested)** — D1: EXECUTE gate composes (mid-flow ≠ ad-hoc). Both branches tested.
- **FU.2** — D2: scope-sprawl escalation directive (state-only, threshold 3).
- **FU.3** — D3: SessionStart health assurance rule (hooks+pack+FSM) → loud directive on failure.
- **FU.4** — D4: the discipline lesson (memory) + docs/CHANGELOG/version.

No unresolved scoping items — the three root causes are verified live and fixed; each remaining hole
has a justified fix; the one non-self-healable case (F3 already-running session, D3) is called out
with its reasoning.
