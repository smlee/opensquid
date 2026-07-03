# Understanding Pack FSMs — opensquid's behavior architecture

> **Who this is for:** everyone. The first sections need no coding background.
> Each section goes one layer deeper, so a curious newcomer, a pack author, and
> a runtime engineer can each stop where it stops being useful to them.

---

## 1. The one-sentence version

**opensquid lets you describe an AI agent's behavior as a _pack_ of plain text
files — and the runtime turns those files into how the agent actually behaves.
Swap the pack, swap the behavior.**

That's the whole idea. Everything below explains how.

---

## 2. The plain-language picture (no tech needed)

Imagine hiring an assistant. To make them good at a job you'd give them three
things:

1. **A job description** — what they're for, what they know.
2. **A set of habits** — "before you ship code, run the tests"; "never push to
   the main branch by force."
3. **A workflow** — the stages a task moves through: _figure out what's needed →
   research it → write the plan → do the work → check it._

A **pack** is exactly those three things written down in a way the computer can
follow. The agent "wears" a pack the way a person wears a uniform-plus-training:
put on the _RaumPilates pack_ and the agent behaves like a studio assistant; put
on the _engineering pack_ and it behaves like a careful senior engineer.

Two key words you'll keep seeing:

- **Skill** = one habit. "_When_ you're about to do X, _check_ Y, and if it's
  wrong, _warn or stop_." Skills are how a pack nudges or blocks the agent in the
  moment.
- **FSM** (Finite State Machine) = the **workflow as a flowchart**. It's just a
  set of named **stages** and the **arrows** between them. You can only move
  along an arrow that exists — you can't skip from "just started" straight to
  "shipping" if there's no arrow for it. That's what keeps the agent honest.

```
   ┌────────┐  scope   ┌─────────┐ research ┌────────────┐  spec   ┌──────────────┐
   │  idle  │ ───────▶ │ scoping │ ───────▶ │ researched │ ──────▶ │ spec_authored│ ─▶ … ─▶ done
   └────────┘          └─────────┘          └────────────┘         └──────────────┘
                            ▲                      │
                            └──────────────────────┘
                              "found an unresolved guess" → go back and research
```

The bent arrow at the bottom is the important part: if the agent realizes it was
**guessing**, the workflow can send it _back_ to research. A good architecture
makes "don't guess" a checkable rule, not a hope.

---

## 3. Why build it this way? (the value)

- **Behavior is data, not code.** Changing what the agent does means editing a
  text file, not rewriting a program. Anyone can read it; anyone can change it.
- **Everything is standardized.** Every pack is described the same way, so the
  runtime that runs _one_ pack runs _any_ pack. There are no special cases.
- **It composes.** Packs can be stacked (engineering discipline + a specific
  framework + a project's quirks) and the agent gets all of them at once.
- **It's honest by construction.** Because the workflow is an explicit
  flowchart, "you can't write code before you've researched" is enforced by the
  shape of the machine — not left to good intentions.

---

## 4. What's inside a pack (the files)

A pack is a folder. The example below uses `workflow-fsm` to illustrate the FSM
mechanism. The mechanics shown here are identical across every pack — only the YAML
differs.

> **Which pack is the live coding discipline?** The v2 **design-of-record is
> `fullstack-flow`** (`packs/builtin/fullstack-flow/pack.yaml`) — an FSM-primary pack
> (the machine is inline in `pack.yaml`, no separate `fsm.yaml`) with **five** gated
> stages, SCOPE → PLAN → AUTHOR → CODE → DEPLOY, each a deterministic zero-LLM gate
> plus a guess-free content-audit. It is what opensquid itself runs (pinned in
> `.opensquid/active.json`). The earlier `coding-flow` pack (T-FSM-UNIFY merged
> `workflow-fsm` + `scope-fsm` into it — one 9-state FSM, three gated stages SCOPE →
> TASK-AUTHORING → CODE with the restored spec-audit gate) is the still-shipped opt-in
> **legacy default**. For the current machine + gate detail see `docs/flows.md` §3.

Here is the (illustrative) pack folder:

```
workflow-fsm/
  manifest.yaml          ← identity: name, what it's for  (REQUIRED)
  fsm.yaml               ← the workflow flowchart (states + arrows)
  skills/
    enter-scoping/skill.yaml         ← a habit
    advance-on-writes/skill.yaml     ← a habit
    advance-on-phase-log/skill.yaml  ← a habit
    handoffs/skill.yaml              ← a habit
```

Other optional files a pack can carry: `models.yaml` (which AI model to use for
judgment calls, by _role_ not by name), `drift_response.yaml` (how strict to be
when a rule trips), `team.yaml` (sub-agents the pack can spawn). You only add
what you need; a minimal pack is just `manifest.yaml`.

### 4a. `manifest.yaml` — identity

```yaml
name: workflow-fsm
version: 0.1.0
scope: workflow # how broadly it applies: universal/domain/specialty/workflow/project
goal: run the 7-phase workflow as a pack-declared FSM
description: >
  The 7-phase engineering workflow as a pack FSM …
```

Four fields are required: `name`, `version`, `scope`, `goal`. Everything else
has a sensible default, so a brand-new pack works out of the box.

### 4b. `fsm.yaml` — the flowchart

```yaml
initial: idle # where every session starts
states: [idle, scoping, researched, spec_authored, tasks_loaded, phases_in_flight, phases_complete]
transitions:
  - { from: idle, on: scope_start, to: scoping }
  - { from: scoping, on: research_done, to: researched }
  - { from: researched, on: guess_found, to: scoping } # ← the loop-back
  - { from: researched, on: spec_authored, to: spec_authored }
  # … and so on
```

Read it as: "From `idle`, the event `scope_start` moves you to `scoping`." Each
arrow is one line. The machine is **total**: for _any_ (state, event), the
outcome is defined — either a declared arrow, or "stay put." There's no
undefined behavior, and an arrow can never point at a stage that doesn't exist
(the loader checks this and refuses a broken FSM).

### 4c. `skills/<name>/skill.yaml` — a habit

A skill says **when** it wakes up (`triggers`) and lists **rules**. A rule is a
short recipe of steps:

```yaml
name: advance-on-writes
triggers:
  - kind: tool_call # wake up whenever the agent uses a tool
rules:
  - id: advance-research-done
    process:
      - call: tool_name # what tool? bind it to `tool`
        as: tool
      - call: tool_args # the tool's arguments, bind to `targs`
        as: targs
      - call: advance_fsm # move the workflow forward …
        if: '(tool == "Write" || tool == "Edit") && contains(targs.file_path, "-pre-research-")'
        args: { event: research_done } # … by firing this event
```

In English: "When the agent writes a _pre-research_ document, fire the
`research_done` event, which (per `fsm.yaml`) advances the workflow to
`researched`." Each step is a `call` to a small built-in **verb** (a _primitive_
— `tool_name`, `advance_fsm`, etc.), optionally guarded by an `if:` condition and
optionally storing its result with `as:`.

---

## 5. How it runs (the moment-to-moment)

opensquid hooks into the host (e.g. Claude Code) at well-known moments — _before
a tool runs, after a prompt is submitted, when a session ends._ Each moment is an
**event**. When an event happens:

```
event (e.g. "agent is about to Write a file")
  │
  ▼
load the active packs  →  for each pack, for each of its skills that listens to this event,
                          for each rule: run the rule's steps
  │
  ▼
a rule may produce a VERDICT:  pass · warn · block · directive
  │
  ▼
block → the tool is denied (with a reason)   ·   warn/directive → a note to the agent
```

The rule's steps run through a tiny, fixed interpreter. Steps call **primitives**
(the verbs), conditions are checked by a small expression language (`==`, `&&`,
`||`, and a handful of functions like `contains`, `match`, `len`). Crucially,
**the interpreter is generic** — it has no idea what "workflow" or "RaumPilates"
means. All the meaning lives in the pack's YAML. That's what "the runtime runs
any pack" means in practice.

Two primitives make the FSM live:

- **`read_fsm_state`** — "what stage is this pack's workflow in right now?" Use it
  in an `if:` to gate behavior (`if: st == "researched"`).
- **`advance_fsm`** — "fire this event at the pack's FSM," which moves it along a
  declared arrow (or harmlessly does nothing if no arrow matches).

The current stage is remembered per session, so it persists across many events
within a working session and resets cleanly when the session ends.

---

## 6. A complete walkthrough: the engineering workflow

This walkthrough uses the `workflow-fsm` pack, end to end (its 7-phase discipline was
folded into the v1 `coding-flow` pack, and the v2 rebuild is `fullstack-flow` — see the
note in §4; the mechanics are identical regardless of which pack is active). Activate a
discipline pack and the machine enforces its stages:

| The agent does this…                       | which fires this event…         | moving the workflow to…         |
| ------------------------------------------ | ------------------------------- | ------------------------------- |
| sends a "let's scope a new task" prompt    | `scope_start`                   | **scoping**                     |
| writes `docs/research/…-pre-research-….md` | `research_done`                 | **researched**                  |
| writes a track spec `docs/tasks/T-….md`    | `spec_authored`                 | **spec_authored**               |
| creates tasks with provenance              | `tasks_loaded`                  | **tasks_loaded**                |
| logs a phase via `log_phase`               | `phase_started` / `phases_done` | **phases_in_flight → complete** |

Alongside the advances, a `handoffs` skill watches the stage and, at each
milestone, surfaces a **directive** — a non-blocking nudge pointing at the next
step ("you've finished research; now spawn the spec author, here's the path to
the doc you just wrote"). The path is _captured_ when the research doc is written
and _replayed_ into the directive — so the handoff carries real context, not a
placeholder.

Nothing about this lives in opensquid's program code. It's all in the pack's
`fsm.yaml` + four small skills. To change the workflow — add a stage, change a
rule, loosen a gate — you edit YAML, not TypeScript. **That is the architecture's
whole point**, and it's why retiring the old hard-coded workflow (a special-case
module called `chain_state`) in favor of this pack made the system _smaller_, not
bigger.

---

## 7. Authoring your own pack (a recipe)

1. **Make a folder** with a `manifest.yaml` (name, version, scope, goal).
2. **If your behavior has stages**, add an `fsm.yaml`: list the `states`, the
   `initial` one, and the `transitions` (arrows). Keep it mostly sequential —
   the order _is_ the discipline — and add a loop-back arrow where re-work is
   legitimate.
3. **Add skills** under `skills/<name>/skill.yaml`. For each habit: pick the
   `triggers` (which events wake it), then write `rules` whose `process` steps
   read context (`tool_name`, `tool_args`, `read_fsm_state`), decide with `if:`,
   and act (`advance_fsm`, or `verdict` to warn/block/hand-off).
4. **Prefer guards for simple gates.** The most common shape — "detect a thing,
   then warn or block" — has a one-line shortcut: a `guards:` block in the
   manifest. You declare the detection + the message once and the runtime
   compiles it into a rule for you (see `docs/pack-runtime.md`). This keeps packs
   tiny.
5. **Opt in.** List the pack in `active.json` for the scope you want it in. It
   loads, validates, and starts running.

Design principle to keep in mind: **make unknowns explicit.** If a gate needs to
decide "is this guess-free?", model the unknowns as data the machine can check,
rather than hoping the agent self-polices. The FSM is the tool for turning "be
careful" into "the arrow doesn't exist yet, so you literally can't proceed."

---

## 8. Engineer's reference (the layers)

For the precise schemas, the primitive catalog, and the loader contract, see
`docs/pack-runtime.md`. In brief, the stack from bottom to top:

- **Expression engine** (`src/runtime/evaluator/expression/`) — evaluates `if:`
  conditions: a safe grammar (no `eval`), `== && || !`, dotted/bracket paths, and
  a frozen 5-function allow-list (`len`, `contains`, `match`, `startsWith`,
  `endsWith`). `match` uses RE2 (ReDoS-immune).
- **Process interpreter** (`src/runtime/evaluator.ts`) — runs a rule's
  `ProcessStep[]` serially: evaluate `if:`, interpolate `{{var}}` /
  `{{var.field}}` args (recursing into nested args), call the primitive, bind
  `as:`, recognize the terminal `verdict` / `directive` / `inject_context`.
- **Primitive registry** (`src/functions/`, assembled in `bootstrap.ts`) — the
  verbs: event readers (`tool_name`, `tool_args`, `text_pattern_match`), state
  (`read_state`, `write_state`), FSM (`read_fsm_state`, `advance_fsm`), verdicts,
  LLM-via-alias (`llm_classify`, `subagent_call`, `check_destination`), RAG/recall,
  gated side-effects, and pure predicates.
- **FSM engine** (`src/runtime/fsm.ts` + `fsm_state.ts`) — `validateFsm`
  (load-time totality) + the total `step` transition function + per-session
  persistence keyed `(session, pack)`. `read_fsm_state` accepts an optional
  `pack:` to read _another_ pack's lifecycle state (cross-pack gating).
- **Loader** (`src/packs/loader.ts`) — turns a folder into a typed `Pack`:
  parses `manifest.yaml`, scans `skills/`, validates `fsm.yaml`, compiles
  `verify_gates`/`guards` into synthetic skills, folds in the side-files.
- **Dispatcher** (`src/runtime/hooks/dispatch.ts`) — the generic runner: for the
  incoming event, walks `packs × skills × rules`, threads each pack's `fsm`/
  `models` into the eval context, and maps verdicts to host exit codes. It is the
  _only_ executor; there is no per-pack or per-workflow special case.
- **v2 supply + observed actor** (`src/runtime/loop/v2_supply.ts`,
  `src/runtime/loop/v2_observed_actor.ts`) — the v2 `fullstack-flow` machine runs in
  **observed mode**: opensquid watches the host's hook events and advances the FSM only
  at gate/decision states (an executor / `sub_flow` state is inert in observed mode,
  `v2_observed_actor.ts:74`), because the agent does the work in its own harness. This
  is why every v2 stage is modelled as a gate whose trigger is a hook event, not an
  executor that runs the work itself. Enforcement is fail-closed at the git gate
  (`src/setup/cli/gate.ts`); the PreToolUse block path fires only under
  `OPENSQUID_AUTOMATION=1` (`pre-tool-use.ts:328`).

### Model selection (an aside worth knowing)

opensquid never hard-codes a model name in a pack. A pack declares an **alias**
(`fast_classifier`, `reasoning`, …) and the _user_ maps each alias to the actual
model that's the perfect fit for that job. Match the tool to the task:
deterministic checks need no model at all; a judgment that needs real reasoning
(e.g. detecting a disguised guess) gets a _capable_ reasoning-class alias — never
a weak default. The control flow stays deterministic; only the judgment is
delegated, and only where judgment is genuinely required.

---

## 9. Glossary

| Term           | Plain meaning                                                        |
| -------------- | -------------------------------------------------------------------- |
| **Pack**       | A folder of files that fully describes an agent's behavior.          |
| **Skill**      | One habit: when-to-wake-up + rules.                                  |
| **Rule**       | A short recipe of steps that reads context, decides, and acts.       |
| **Primitive**  | A built-in verb a step can `call` (e.g. `advance_fsm`).              |
| **FSM**        | The behavior's flowchart: named stages + the arrows between them.    |
| **Transition** | One arrow: from a stage, on an event, to a stage.                    |
| **Total**      | Every (stage, event) has a defined outcome — no surprises.           |
| **Guard**      | A reusable "detect → warn/block" shortcut for the common gate shape. |
| **Verdict**    | A rule's outcome: `pass` / `warn` / `block` / `directive`.           |
| **Directive**  | A non-blocking nudge to the agent pointing at the next step.         |
| **Event**      | A moment the runtime reacts to (tool call, prompt, session end…).    |
| **Dispatcher** | The generic engine that runs any pack against an event.              |
| **Alias**      | A role-name for a model (`reasoning`) the user maps to a real model. |
