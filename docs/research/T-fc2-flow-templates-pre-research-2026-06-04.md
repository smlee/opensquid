# Pre-research — FC.2: reusable FSM flow templates (B2)

**Date:** 2026-06-04. **Repo:** opensquid. **Decision:** the user chose BUILD (full +
complete, no half-measure). **Research this turn:** Read of `src/runtime/fsm.ts:1-97`
(Fsm + validateFsm + step), `src/packs/loader.ts:120-209` (the guards-compile + fsm-load
sites), `src/packs/guards_compiler.ts` (the structural mirror); grep of the manifest fsm
field + the coding-flow loopback edge.

## 1. The shape (verified, file:line)

- `Fsm = {initial, states[], transitions[]}`; `Transition = {from, on, to, when?}`
  (`fsm.ts:34-55`). `validateFsm` (`fsm.ts:63`) enforces totality: `initial` + every
  `from`/`to` must be a declared state (`*` exempt on `from`).
- The pack FSM is a side-file `fsm.yaml`, loaded by `loadOptionalFsm(join(dir,'fsm.yaml'))`
  at `loader.ts:199` — which parses + `validateFsm`s internally (`loader.ts:341-357`).
- `manifest` (and thus a future `manifest.flows`) is already in scope at line 199 —
  guards compile just above at `:130`. So flows can compile there and be merged before the
  fsm is validated.
- The loopback edge to template: `{from: researched, on: guess_found, to: researching}`
  (coding-flow `fsm.yaml:29`, the D3 guess-audit re-do).

## 2. Design (derived; mirrors guards_compiler)

- `Flow = {template: string, params: record}` in the manifest schema; `flows: Flow[]`.
- `flows_compiler.ts`: a flat `FLOW_TEMPLATES` registry of pure `params → {states,
transitions}` expanders. First: `loopback_gate({state, trigger, back_to})` →
  `{states:[state, back_to], transitions:[{from:state, on:trigger, to:back_to}]}`.
- Loader: `compileFlows(manifest.flows)` → pass the expansion into `loadOptionalFsm`,
  which MERGES `expansion.states` (deduped into the parsed states) + `expansion.transitions`
  (appended) BEFORE `validateFsm`. Totality is then checked on the EXPANDED machine — a
  flow edge to a typo state fails load (the key correctness property).
- Edge: `flows` present + no `fsm.yaml` → loud error (flows augment a base FSM; there is
  nothing to merge into). Fail loud, mirror guards' no-silent-skip.

## 3. Adoption (so it is not dead code)

coding-flow's `fsm.yaml:29` loopback edge MOVES to a `manifest.yaml` `flows:` entry; the
loaded FSM must remain byte-equivalent (same transition present) and `validateFsm` clean.
This proves the mechanism in real use — the n=1 reality (the abstraction is shaped by this
one example) is mitigated by keeping `FLOW_TEMPLATES` a flat registry: a 2nd/3rd template
is purely additive, no generalization of the expander signature until earned.

## 4. Open questions — none that block. (Skills expansion, e.g. for a block-while-state

template, is deferred: that pattern is already covered by shipped `guards:`. loopback_gate
is FSM-only — `{states, transitions}`, no skills.)
