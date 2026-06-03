# Pre-research — T-FSM-COMPLETION (close out the pack-FSM standardization arc)

**Date:** 2026-06-03. **Repo:** opensquid. **Method:** three parallel research
agents (B-adopt migration survey, B2 flow-template justification, CI-flake
root-cause), each instructed to cite file:line and edit nothing. Findings below are
the persisted research record; decisions live in `docs/tasks/T-fsm-completion.md`.
Every claim is derived-with-citation or flagged as an open question — no
unresolved guesses.

## 1. B-adopt (guards adoption) — verified findings

The `guards:` compiler restricts what can migrate (`manifest.ts:475` →
`level: warn|block` only; `guards_compiler.ts:80` → rule id `guard:<name>`,
`load: lazy`, `when_to_load: []`, triggers from `on: ∈
{tool_call,prompt_submit,stop,session_end}`; exactly ONE `detect` per guard).
Surveying all 28 builtin `skill.yaml` files against that envelope:

- **Cleanly migratable today (no drift_response key, no test on the rule id):**
  - `tool-history-correlator/correlator` — single `session_tool_history` →
    `verdict(warn)`, trigger `stop`.
  - `file-pattern-guard/guard` — detect-less `when`-only `verdict(block)`, trigger
    `tool_call`.
- **Shape-perfect but BLOCKED behind the drift_response rule-id contract:** the
  `default-discipline` cluster — `git` (2 rules), `engine-vocab`, `versioning`,
  `honesty-ledger` (14), `phase-logging` (3). Their ids are keyed in
  `default-discipline/drift_response.yaml` and asserted in `default-discipline.test.ts:90`,
  `command_boundary.skill.test.ts:56/63/83`, `drift_response.test.ts:24`. Dispatch
  does an exact-string lookup `per_rule[rule.id] ?? default` (`dispatch.ts:475`), so
  the id change `name` → `guard:name` would **silently downshift** these to
  `default: full_stop_and_redo`. Migratable ONLY as one atomic commit that
  re-prefixes the `per_rule` keys + updates the 3 tests.
- **Non-migratable** (evidence): multi-detect rules (`taskcreate-spec-required`
  needs both `tool_name` AND `tool_args`; `scope-before-code` 4 detects; etc.);
  LLM/state primitives (`d9-guard` `llm_classify`; the FSM driver skills
  `advance_fsm`/`read_fsm_state`/`write_state`); `surface`/`directive`/`pass`
  levels (`inbound-greeter`, the `*-author-walkthrough` skills, `handoffs`);
  triggers outside the `on:` enum (`inbound_channel`, `session_start`).

Net LOC removed: ≈ −60 (FC.1a), ≈ −150 more (FC.1b). Risk: FC.1b changes audit
attribution `<skill>/<rule>` → `default-discipline/guards/guard:<name>` (internal,
acceptable).

## 2. B2 (flow templates) — verified findings → DEFER (user-confirmed)

Exactly **2** `fsm.yaml` instances exist (`scope-fsm`, `workflow-fsm`);
`pack-architect` ships no FSM (only a cross-pack `read_fsm_state`). The repeated
patterns each have n=2 or n=1:

- advance-on-doc-write: `scope-lifecycle/skill.yaml:16-23` ≈ `advance-on-writes/skill.yaml:13-25`.
- block-while-state≠X gate: `scope-lifecycle/skill.yaml:73-88` (already expressible
  as a shipped `guards:` entry — B1 pre-empts this).
- loopback_gate edge: `scope-fsm/fsm.yaml:12` ≈ `workflow-fsm/fsm.yaml:16` (same
  shape, different target state).
- `tool_name`/`tool_args` driver preamble repeats **6×** across the two packs.

**Verdict: premature.** Rule-of-three fails (n=2); the two FSMs are not independent
(`workflow-fsm` is the chain_state rewrite, `scope-fsm` a slice of the same spine,
`workflow-fsm/manifest.yaml:5-9`); the `coding-flow` track is consolidating toward
FEWER FSMs (`T-coding-flow-pack.md:34-35` — "extend the artifact contract, don't
multiply gates" + retires a gate). The genuinely-repeated unit (the 6× preamble) is
a primitive-ergonomics problem, not a flow-topology one. **Decision: defer with the
n=3-independent-FSM trigger; bank the preamble-collapse win instead (FC.2').**

## 3. CI flakes — verified root causes

Both are pure timing flakes under vitest's default forked-parallel pool
(`vitest.config.ts:16-28` sets no `pool`/`isolate`/`fileParallelism` → defaults
`forks`/`isolate:true`/`fileParallelism:true`; `process.env` is per-fork, so NOT a
shared-state bug).

- `transport_bridge.test.ts` — already polls via `waitFor` (correct strategy) but
  the binding constraint is `waitFor`'s **inner 5s ceiling** (`:46`), NOT the 20s
  vitest `setConfig` (`:83-85`) which never triggers because `waitFor` throws
  first. chokidar runs in polling mode and slips under CPU contention. **Fix:**
  raise the `waitFor` ceiling to ~15s; keep the 20ms interval. Test-only.
- `l3_inbound_e2e.test.ts` — a fixed `setTimeout(500)` (`:126-128`) used as an
  async proxy + two cold `node` hook spawns (`:140,:162`) whose wall-clock sum can
  exceed the 20s per-`it` budget under load. The ack-dedup assertion is **not** a
  race (the two fires are strictly sequential; ack write is `proper-lockfile`-guarded;
  dedup keyed `(platform,message_id)` only). **Fix:** replace the sleep with a
  `waitUntil(pred,15000,25)` poll; raise the per-`it` ceiling to 30s (legit — two
  real cold spawns are inherently slow). Test-only.

## 4. Open questions — none that block.

The B2 build-vs-defer fork was the only decision requiring the user; resolved
(defer). FC.1a / FC.1b / FC.3 / FC.2' proceed under this research.
