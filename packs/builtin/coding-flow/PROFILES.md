# coding-flow — track-type region profiles (FU.3)

One FSM; a **track-type** is a required-region _profile_ the guards consult — not a
separate machine. `enter-scoping` classifies the scope-authoring prompt and records
`coding-flow-track` (session state); each region-guard fires only when its region is in
the active profile.

| track-type | regions                  | meaning                                      |
| ---------- | ------------------------ | -------------------------------------------- |
| `feature`  | SCOPE · AUTHOR · EXECUTE | a new capability (full track) — **default**  |
| `fix`      | SCOPE · EXECUTE          | research + 7-phase, no task decomposition    |
| `doc`      | SCOPE · EXECUTE          | same shape; audit phase = "render / observe" |
| `trivial`  | SCOPE · EXECUTE          | already-scoped mechanical edit               |

## Which region-guard consults the profile

- **SCOPE** (`scope-before-code`) — requires SCOPE-complete for **every** profile (code
  always needs research). Profile-independent in practice.
- **AUTHOR** (`taskcreate-spec-required`) — requires AUTHOR. Fires **only** when the track
  is NOT `fix`/`doc`/`trivial`. The single profile-dependent gate.
- **EXECUTE** (`phase-logged-before-commit`) — requires EXECUTE. Universal.

## Fail-safe

- Classification is recorded by `enter-scoping`, which RESETS `coding-flow-track` to
  `feature` on every scope entry before any keyword downgrade — a stale `fix` value can
  never leak into a later `feature` task.
- **GF.5 (F5) — mixed-intent guard.** A downgrade to `fix`/`doc`/`trivial` fires ONLY
  when the prompt carries NO feature-intent keyword
  (`build|add|feature|implement|refactor|new (feature|module|endpoint)`). A mixed prompt
  ("build X and fix Y") stays `feature` (strictest), so one stray keyword can't disable
  the AUTHOR gate for the whole session. The feature list is deliberately narrow (no
  `change`/`update`/`edit`) so a pure fix/doc track still downgrades.
- An unset/unclassified track reads as `null`; `null != "fix"` is true, so the AUTHOR gate
  still fires. **Default = `feature` = strictest.** Misclassification never under-gates.

`trivial` currently shares `fix`/`doc`'s AUTHOR-skip behavior (all three are non-AUTHOR);
the SCOPE+EXECUTE columns above document intent for a future profile that also relaxes
SCOPE — not yet wired (SCOPE stays universal today).
