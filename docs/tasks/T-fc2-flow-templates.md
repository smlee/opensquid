# Track T-FC2-FLOW-TEMPLATES — reusable FSM flow templates (B2)

**Pre-research:** the §1.4 / FC.2 spec (`T-fsm-completion.md:100-105`); `Fsm` =
`{initial, states[], transitions[]}` (`fsm.ts:48-55`); `validateFsm` (`fsm.ts:63`) enforces
totality; the loader has `manifest` (with `flows`) in scope at the `loadOptionalFsm` call
(`loader.ts:199`); `guards_compiler.ts` is the structural mirror; the loopback edge to
template is `{from: researched, on: guess_found, to: researching}` (coding-flow fsm.yaml:29).

### Task FC.2: Author the `flows:` template subsystem + adopt loopback_gate

**Required skills:** opensquid pack-format / manifest schema expert; FSM engine expert; TypeScript compiler-pattern expert (mirror guards_compiler); Vitest fixtures expert; Audit / code review expert

**Deliverable:** a `flows:[]` manifest block + `flows_compiler.ts` (mirroring `guards_compiler`) that expands `{template, params}` into FSM `{states[], transitions[]}`, merged into the hand-authored `fsm.yaml` machine BEFORE `validateFsm` so totality is checked on the expanded FSM. First template = `loopback_gate` (a quality-gate re-do edge: `{from: state, on: trigger, to: back_to}`). coding-flow ADOPTS it for the guess-audit loop (the hand-written edge moves to a `flows:` entry) — proving the mechanism in-use, not dead code.

**Depends on:** None (the FSM engine + loader shipped in slice A/FU.1).

**Files affected:**

- `src/packs/schemas/manifest.ts` (modify) — add `Flow` schema + `flows: z.array(Flow).default([])`.
- `src/packs/flows_compiler.ts` (new) — `compileFlows(packName, flows) → {ok, expansion:{states,transitions}, errors}`; `FLOW_TEMPLATES` registry; first entry `loopback_gate`.
- `src/packs/loader.ts` (modify) — compile flows; pass the expansion into `loadOptionalFsm` to merge (dedup states, append transitions) BEFORE `validateFsm`; error if `flows` present with no `fsm.yaml`.
- `packs/builtin/coding-flow/{manifest.yaml,fsm.yaml}` (modify) — move the guess_found edge from fsm.yaml into a `flows:` loopback_gate entry.
- `src/packs/flows_compiler.test.ts` (new) + `test/builtin/coding-flow.test.ts` (modify) — expansion + merged-FSM-still-valid + loopback edge preserved.

**Key code shapes:**

```ts
// flows_compiler.ts — mirror of guards_compiler. Each template is a pure
// params→{states,transitions} expander; unknown template / bad params fail loud.
import { type Transition } from '../runtime/fsm.js';
export interface FlowExpansion {
  states: string[];
  transitions: Transition[];
}
const FLOW_TEMPLATES: Record<string, (p: Record<string, unknown>) => FlowExpansion> = {
  // A quality-gate re-do edge: being in `state`, a `trigger` (e.g. an audit-fail)
  // loops back to `back_to` to redo the region. Declares both endpoint states so
  // validateFsm stays total on the merged machine.
  loopback_gate: (p) => {
    // A loop-back connects two EXISTING spine states → contributes only the edge;
    // both endpoints must already be declared in fsm.yaml, so validateFsm (on the
    // merged machine) catches a typo'd endpoint. (params validated as strings.)
    return { states: [], transitions: [{ from: p.state, on: p.trigger, to: p.back_to }] };
  },
};
export function compileFlows(
  packName: string,
  flows: readonly Flow[],
): { ok: true; expansion: FlowExpansion } | { ok: false; errors: string[] } {
  /* … */
}
```

```ts
// loader.ts — at the fsm load site (line ~199): compile flows, merge before validate.
const flowsResult = compileFlows(manifest.name, manifest.flows);
if (!flowsResult.ok)
  throw new Error(`pack ${manifest.name}: flows compile errors: ${flowsResult.errors.join('; ')}`);
const fsm = await loadOptionalFsm(join(dir, 'fsm.yaml'), flowsResult.expansion);
// loadOptionalFsm merges expansion.states (deduped) + expansion.transitions, THEN validateFsm.
```

```yaml
# coding-flow manifest.yaml — adopt the template (the fsm.yaml guess_found edge is removed)
flows:
  - template: loopback_gate
    params: { state: researched, trigger: guess_found, back_to: researching }
```

**Test fixtures:** `compileFlows('p', [{template:'loopback_gate', params:{state:'researched', trigger:'guess_found', back_to:'researching'}}])` → expansion has the one transition (states `[]`; endpoints pre-declared in fsm.yaml). An unknown template / non-string params → `{ok:false, errors:[…]}`. `loadPack(coding-flow)` → the merged FSM still contains the `researched --guess_found--> researching` transition AND `validateFsm` returns `[]`. A `flows:` loopback whose endpoint is absent from fsm.yaml is caught by `validateFsm` on the merged machine (the typo-throws case); `flows:` with no fsm.yaml throws loud.

**Acceptance criteria:**

- [ ] `compileFlows` expands loopback_gate to the correct states+transitions; unknown template fails loud
- [ ] coding-flow's loopback edge now comes from `flows:` (removed from fsm.yaml) and the loaded FSM is byte-equivalent (same transition present)
- [ ] `validateFsm` runs on the MERGED machine (a flow targeting an undeclared state errors at load)
- [ ] `flows` present + no fsm.yaml → loud load error (not silent)
- [ ] `pnpm typecheck && pnpm lint && pnpm vitest run && pnpm build && pnpm format:check` all green

**Risk callouts:** totality MUST be checked on the EXPANDED machine — merge BEFORE `validateFsm`, never after (a flow edge to a typo endpoint must fail load). `loopback_gate` contributes ONLY the edge (endpoints must pre-exist in fsm.yaml) — this is what makes the typo-catch real; a self-declaring template would make undeclared-endpoint errors impossible. The merge still dedups states (`FlowExpansion.states` is kept for future templates that DO introduce states). Fail loud on unknown template / non-string params (mirror guards_compiler's no-silent-skip). At n=1 the abstraction is shaped by one example — keep `FLOW_TEMPLATES` a flat registry so a 2nd/3rd template is additive, no premature generalization of the expander signature.

**References:** `src/packs/guards_compiler.ts` (the mirror), `src/runtime/fsm.ts:48-79` (Fsm + validateFsm), `src/packs/loader.ts:199` (fsm load site), `src/packs/schemas/manifest.ts:547` (guards field — add flows beside it), `docs/tasks/T-fsm-completion.md:100-105` (the minimal shape).

**Verification commands:** `pnpm vitest run src/packs/flows_compiler.test.ts test/builtin/coding-flow.test.ts && pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run && pnpm build`.

**7-phase steps:** 1 pre-research: DONE (Fsm shape + loader merge point + guards_compiler mirror). 2 learn: lock the FlowExpansion shape + merge-before-validate + flat FLOW_TEMPLATES. 3 code: Flow schema, flows_compiler, loader merge, adopt in coding-flow. 4 test: expansion + unknown-template + merged-FSM-valid + loopback-preserved. 5 audit: validate-on-merged, dedup states, fail-loud, no premature generalization. 6 post-research: n/a. 7 fix.
