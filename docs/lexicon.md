# opensquid lexicon

Ubiquitous language: **one canonical definition per term**, each stated in a
single sentence with no compound connectors. The point is that a word means
exactly one thing to everyone working on opensquid — so we never talk past each
other (the failure this file exists to prevent). Grow it as we label things.

## Design principles

- **Simplicity Principle** — prefer the simple logical solution; proliferating
  exceptions/special-cases mean either the problem wasn't decomposed or the
  solution is overcomplicated.
- **No implicit state** — every lifecycle is an explicit _total-transition_
  state machine; every transform is a pure function.
- **Coding stack behind it** — _make illegal states unrepresentable_ (types),
  _functional core / imperative shell_ (architecture), _single responsibility /
  orthogonality_ (decomposition); umbrella = Hickey's _simple = not complected_.
- **Determinism boundary** — impose determinism on the **control plane** (state,
  order, guards, invariants — where correctness is binary and verifiable) and
  keep the **work plane** probabilistic (reasoning, generation, judgment — where
  the value is the stochasticity). Determinism where correctness is binary;
  probabilism where value is judgment. The LLM is a stochastic component inside
  a deterministic system. Failure in BOTH directions: too little determinism →
  drift; too much → you shackle the model's value / gate the unverifiable
  (the `recall-consumed` trap).
- **FSM = containment, verification = correctness** — FSMs make the _process_
  reliable and _contain_ the model's drift (no undefined/illegal state reachable,
  regardless of what the fallible model does); they do NOT make the model's
  _content_ correct within a step — that's the empirical layer (tests, audit,
  spikes). FSMs make the model's unreliability _harmless_, not absent. →
  [[project-opensquid-architecture-thesis]]

## Chat

- **Inbox** — a project's store of inbound messages (the daemon routes each
  message to the right project by topic).
- **Channel** — a project's dedicated conversation surface (a Telegram topic).
- **Responder** — the single agent currently answering a channel.
- **Chat FSM** — per channel, states `{LIVE, AUTONOMOUS}`; transition _claim_ =
  `SessionStart`, transition _release_ = `SessionEnd`; the `AUTONOMOUS`
  occupant is a subscription-spawned agent (no metered cost).

## Hooks / gates

- **Response-judging → UserPromptSubmit, not Stop** — a gate that judges the
  assistant's just-emitted response (did it cite recall? stay honest? consume
  memory?) must run at the NEXT `UserPromptSubmit`, where the prior response is
  settled in the transcript and the turn ledger has reset. A `Stop` hook fires
  _before_ its triggering response is flushed → it reads the PRIOR response
  (off-by-one) and its per-turn trigger never resets across Stop-feedback
  cycles (→ loops). `recall-consumed` was removed (SG.3) for violating this.
  The capability that makes UPS the correct home is `priorAssistantText` (RJ.1):
  the UPS hook fills it from the transcript, and because the prior turn is
  already flushed at UPS-fire there is NO off-by-one (CC provides
  `transcript_path` on UserPromptSubmit; the prior turn is readable).
  `honesty-ledger`, `phase-logging`, and `d9-guard` were relocated to UPS on
  this capability (RJ.2/RJ.3). _Correction (2026-06-01):_ the earlier claim that
  they "read assistantText at Stop and inherit the off-by-one" was a WRONG
  premise — the audit found they never ran at Stop at all (honesty-ledger /
  phase-logging default-triggered on `tool_call` with a stop-only/tool_call-only
  primitive mismatch → silent no-ops; d9-guard ran at Stop but fed a CONTENTLESS
  prompt to its classifier). The empirical-spike gate caught the bad premise.
- **The default drift-response policy honors the verdict level** — the
  _effective_ action is the pack's `drift_response` POLICY, but when a pack
  ships no `drift_response.yaml` (no per-rule, no pack default) the fallback
  DERIVES from the verdict `level`: `block → block_tool` (hard block),
  everything else → `warn` (non-blocking). So a `level: warn` rule warns by
  default and a `level: block` rule blocks — a yaml is an OVERRIDE, not a
  prerequisite for level-correct behavior (`defaultPolicyForLevel`, SG.4).
  _Superseded the earlier rule "level:warn ≠ soft without a drift_response.yaml"_,
  which described the old blanket `block_tool` default that silently discarded
  the level and hard-blocked every warn-level rule. A pack still ships a yaml
  to OVERRIDE the level-derived default — e.g. `default-discipline` uses
  `default: full_stop_and_redo` and per-rule `warn` downshifts; its overrides
  fight the pack's own aggressive default, independent of this fallback.
- **MCP-side session resolution → project-scoped pointer, not the env id** — an
  MCP server is a separate process from the hooks and can't read hook stdin.
  Claude Code exposes `CLAUDE_PROJECT_DIR` AND `CLAUDE_CODE_SESSION_ID` to stdio
  MCP servers, but the session-id env var is NOT safe to key on: under `--resume`
  it's a NEW id that differs from the persisted/transcript/hook-stdin id the
  state lives under (so `sessions/<env-id>/` is empty). Resolve via the
  project-scoped `.current-session` pointer (`resolveProjectUuid(CLAUDE_PROJECT_DIR)`),
  which the UPS hook writes with the hook-stdin id — the id the state actually
  uses. Race-free across projects; same-project residue tracked (FU.3/FU.4/FU.7).
  The global `.current-session` is last-writer-wins across all sessions — never
  the authority for MCP resolution.
