# focused-react-19

Opt-in focused pack encoding React 19+ idioms (Server Components, Actions,
useOptimistic, hooks-of-hooks discipline) as a discipline + recall surface
for codebases on React 19.

## Activation

Auto-activates via `detected_by` when `package.json` declares `react ^19` in
`dependencies` OR `devDependencies`. Opt-in via project-scope or user-scope
`active.json`:

```json
{ "packs": ["focused-react-19"] }
```

Or include as part of the `frontend-react-19-atomic` composite (DOG.2):

```json
{ "packs": ["frontend-react-19-atomic"] }
```

## What ships

- **DOG.1 (this commit)**: manifest + `foundation` (tools/domains/methodologies)
  - `detected_by` (npm-deps regex). No skills yet.
- **DOG.4**: 5–10 seed lessons + 2–3 verify gates per pack-runtime.md
  authoring conventions.

## See also

- [`docs/pack-runtime.md`](../../../docs/pack-runtime.md) §1.2 (foundation)
  / §1.3 (activation_scope) / §1.4 (detected_by) — the schema fields this
  pack populates.
- DOG.2 composes this pack with `focused-typescript-strict` +
  `focused-atomic-design`.
