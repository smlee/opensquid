# Track T-FSM-COMPLETION — finish the pack-FSM standardization arc

**Pre-research:** spawned 3 parallel research agents (B-adopt migration survey,
B2 flow-template justification analysis, CI-flake root-cause). Findings folded in
below; each decision is evidence-cited. This spec is the `task-spec-author` output
for the three outstanding items the user asked to scope as one continuous run.

**Goal:** close out the FSM standardization arc — adopt the shipped `guards:`
template where it's safe, make an evidence-based call on flow-templates (B2), and
de-flake the two CI tests that erode trust in the green check.

---

## FC.1 — Adopt the `guards:` template (B-adopt)

**Why:** slice B shipped the `guards:` manifest template (compile a `guards:[]`
block → synthetic `<pack>/guards` skill) but **0 packs use it**. Realize the "code
stays small" goal by collapsing hand-written detect→verdict skeletons into `guards:`.

**Constraint discovered (research):** the `Guard` schema (`manifest.ts:475`)
allows `level: warn|block` ONLY; the compiler (`guards_compiler.ts:80`) hardcodes
rule id `guard:<name>`, `load: lazy`, `when_to_load: []`, and triggers from
`on: ∈ {tool_call,prompt_submit,stop,session_end}`. A guard binds exactly ONE
`detect`. So `surface`/`directive`/`pass` verdicts, multi-detect rules, LLM/state
primitives, and `inbound_channel`/`session_start` triggers are all non-migratable.

### FC.1a — Clean example migrations (zero behavior risk; do first)

Two example skills are pure detect→verdict with NO drift_response key and no test
on their rule id. Migrate them as the reference adoption:

- `packs/builtin/tool-history-correlator/skills/correlator/skill.yaml` (single
  `session_tool_history` → `verdict(warn)`, trigger `stop`) → one `guards:` entry
  (`name: bash-heavy-turn`). ~47 LOC → ~10. Delete the skill folder.
- `packs/builtin/file-pattern-guard/skills/guard/skill.yaml` (detect-less
  `when`-only `verdict(block)`, trigger `tool_call`) → one `guards:` entry
  (`name: refuse-vendored-or-generated-edits`). ~34 LOC → ~8. Delete the skill folder.

Acceptance: `npm run build` + the example packs' tests green; a dispatch test
proves the synthetic `<pack>/guards` skill fires the identical verdict
(level+message) on the same event. Net ≈ −60 LOC.

### FC.1b — `default-discipline` cluster (coordinated change; do second)

`git` (2 rules), `engine-vocab`, `versioning`, `honesty-ledger` (14), `phase-logging`
(3) are all shape-perfect guards BUT their rule ids are keyed in
`packs/builtin/default-discipline/drift_response.yaml` and asserted in 3 tests
(`default-discipline.test.ts:90`, `command_boundary.skill.test.ts:56/63/83`,
`drift_response.test.ts:24`). Migrating changes ids `name` → `guard:name`, which
silently falls through to `default: full_stop_and_redo` (`dispatch.ts:475`).

This is a SINGLE atomic change: convert the skills to `guards:`, re-prefix every
`per_rule` key to `guard:<name>`, AND update the 3 test files in the same commit.
Acceptance: full suite green; drift_response.test proves each migrated guard still
resolves to its intended policy (not the default). Net ≈ −150 LOC across the cluster.

**Scope note:** FC.1b changes observable audit attribution (`<skill>/<rule>` →
`default-discipline/guards/guard:<name>`). Acceptable (internal), but recorded.
`scope-detect` (scope-architect) is independently clean — migrate opportunistically
only if FC.1a/b land smoothly.

---

## FC.2 — Flow templates (B2): **DECISION REQUIRED — research recommends DEFER**

**The user's vision:** "reusable gate/flow templates so the FSM template is
recursive, code stays small." B1 (`guards:`, the gate template) delivered the gate
half. B2 = reusable FLOW templates (composable transition + driver-skill patterns).

**Research verdict: PREMATURE at the current n.** Evidence:

1. **Rule-of-three fails.** Exactly 2 `fsm.yaml` instances exist (`scope-fsm`,
   `workflow-fsm`); `pack-architect` only does a cross-pack read. The repeated
   patterns (advance-on-doc-write, block-while-state≠X, loopback_gate, linear
   spine) each have n=2 or n=1. The `guards:` abstraction was earned by ~23 skills
   repeating the skeleton — an order of magnitude more evidence.
2. **The 2 FSMs are not independent data points.** `workflow-fsm` is the
   "unified replacement for chain_state" and `scope-fsm` is a 4-state subset of the
   same research→build spine; they share edges because one derives from the other.
3. **The codebase is trending toward FEWER FSM gates.** The active `coding-flow`
   track (`T-coding-flow-pack.md:34-35`) consolidates scope+workflow discipline and
   explicitly chooses "extend the artifact contract, don't multiply gates" (CF.2)
   and RETIRES a gate (CF.3). `scope-fsm` + `workflow-fsm` are themselves
   consolidation candidates — templating packs that are mid-merge is wasted surface.
4. **The highest-value flow-gate is ALREADY covered by shipped `guards:`.** The
   block-while-state≠X pattern is expressible today as
   `guards: [{detect: read_fsm_state, when: 'st != "researched"', level: block}]`.
   B2's nominal payoff is largely pre-empted by B1.
5. **The biggest literal repetition is a primitive-ergonomics issue, not flow
   topology.** The `tool_name`/`tool_args` preamble repeats 6× — better solved by
   ambient `tool`/`tool_args` bindings or one `tool_event` primitive than by a
   whole template-expansion subsystem.

**Recommendation:** DEFER B2. Revisit when a THIRD, structurally-distinct FSM
exists (a non-research-spine machine — chat-session / memory-lifecycle /
incident-response) AND the `coding-flow` consolidation has settled. At n=3 with
domain diversity, re-run the repetition table; if patterns #1/#3 still hold on the
independent third instance, the abstraction is earned.

**If built anyway (the minimal shape):** a `flows:[]` manifest block + a
`flows_compiler.ts` (mirroring `guards_compiler`) that expands `{template, params}`
into `{states[], transitions[], skills[]}`, merged into the hand-authored `fsm`
BEFORE the existing `validateFsm` call so totality is checked on the expanded
machine. First template = `loopback_gate` (the guess-audit edge). This is captured
so the option is ready if the user chooses to proceed despite the n=2 evidence.

**→ This is the one scoping decision for the user: build B2 now, or defer per the
evidence and instead bank the smaller immediate win (collapse the
`tool_name`/`tool_args` preamble at the primitive layer)?**

---

## FC.3 — De-flake the two CI tests (timing flakes; test-only fixes)

Both are load-induced timing flakes under vitest's forked-parallel pool (no
shared-state bug — `process.env` is per-fork). Fixes are test-only; product code is
correct for what these tests exercise.

- **`src/runtime/agent_bridge/transport_bridge.test.ts`** — already polls a real
  condition via `waitFor` (good), but `waitFor`'s inner **5s ceiling** (`:46`) is
  the binding constraint, not the 20s vitest `setConfig` (`:83-85`) which never
  triggers because `waitFor` throws first. chokidar runs in polling mode, which
  slips under CPU contention. **Fix:** raise the `waitFor` ceiling to ~15s
  (`:46`), keep the 20ms poll interval. The predicate fires <500ms locally; a
  generous ceiling costs nothing on the happy path.
- **`test/e2e/l3_inbound_e2e.test.ts`** — a fixed `setTimeout(500)` (`:126-128`)
  used as an async proxy, plus two cold `node` hook spawns (`:140,:162`) whose
  wall-clock sum can blow the 20s budget under load. The ack-dedup assertion is NOT
  a race (the two fires are strictly sequential, ack write is lock-guarded).
  **Fix:** replace the 500ms sleep with a `waitUntil(pred, 15000, 25)` condition
  poll; raise the per-`it` ceiling to 30s (legitimate — two real cold spawns are
  inherently slow, not a masked bug).

Acceptance: both tests green in isolation AND under `npm test` full-suite load,
across 3 consecutive runs. No product-code change.

---

## Locked decisions

1. FC.1a first (zero-risk reference adoption), then FC.1b (atomic
   skills+drift_response+tests change). Never migrate FC.1b skills without
   re-prefixing the `per_rule` keys in the same commit.
2. FC.2 (B2) defaults to DEFER per the n=2 evidence — pending the user's call.
3. FC.3 is test-only; verify under full-suite load, not just isolation.
4. Each FC sub-task runs the 7-phase flow and emits a plain-header completion
   report to chat topic 15 (no 🦑).

## Open question (scoping) — exactly one

**FC.2 only:** build the flow-template subsystem now (against the n=2 "premature"
evidence, because completing the FSM template vision is the priority), or defer it
with the n=3 trigger and bank the primitive-preamble win instead? FC.1 + FC.3
proceed regardless.
