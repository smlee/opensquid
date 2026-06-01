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
  cycles (→ loops). `recall-consumed` was removed (SG.3) for violating this;
  `honesty-ledger` / `phase-logging` read `assistantText` at Stop and inherit
  the off-by-one (audit pending).
- **Soft vs hard verdict ≠ verdict level** — a rule's `level: warn` does NOT
  make it soft. The _effective_ action is the pack's `drift_response` POLICY;
  with no `drift_response.yaml` the default is `block_tool`, so every rule
  (even `level: warn`) HARD-BLOCKS. To make a gate actually warn, the pack must
  ship a `drift_response.yaml` mapping that rule to the `warn` policy.
