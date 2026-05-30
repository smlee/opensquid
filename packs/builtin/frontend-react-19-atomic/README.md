# frontend-react-19-atomic

Composite domain-expert pack for the v0.6 dogfood recipe.

## What it includes

Per `manifest.yaml` `includes:` (MM.1 schema):

- [`focused-react-19`](../focused-react-19/README.md) — React 19+ idioms
  (Server Components, Actions, useOptimistic, hooks discipline).
- [`focused-typescript-strict`](../focused-typescript-strict/README.md) —
  TS 5 strict-mode (exhaustiveness, discriminated unions, no-fail-open).
- [`focused-atomic-design`](../focused-atomic-design/README.md) — atoms
  → molecules → organisms layout + token-driven theming.

## Activation

Opt-in via project-scope or user-scope `active.json`:

```json
{ "packs": ["frontend-react-19-atomic"] }
```

The composite_resolver (`src/packs/composite_resolver.ts`) expands the
composite at session-start (IDF.3 caching contract) into a flat list
containing the composite + its three children. Each child then runs its
own `detected_by` rules independently — the composite itself carries no
`detected_by` (children handle gating).

## What ships at this slice (DOG.2)

- `manifest.yaml` — `kind: composite` + 3-entry `includes:` array.
- `README.md` (this file).
- Integration tests at `test/builtin/composite-frontend.test.ts` covering
  load + expansion + child-detection round-trip.
- NO `foundation:` (composites MUST NOT declare own foundation — pure
  aggregator per v0.6 §4.7).
- NO `skills/` directory (composites carry no own skills).
- NO `models.yaml` (children declare their own model aliases if any).

## What lands later

- **DOG.3** — `seed_lessons` + `verify_gates` schema sugar for focused
  child packs.
- **DOG.4** — populate each child's `skills/` + 5–10 seed lessons + 2–3
  verify gates per pack.
- **DOG.5** — living-pack version ledger integration for the composite
  (auto-merge on upgrade flow).
- **DOG.6** — execute the 9-step dogfood recipe end-to-end on a real
  React 19 project.

## Composite-pack rules (from pack-runtime.md §1.7)

| Field           | Composite (`kind: composite`) requirement                              |
| --------------- | ---------------------------------------------------------------------- |
| `includes`      | **REQUIRED** non-empty array of `{pack_id, semver}` entries            |
| `foundation`    | **FORBIDDEN** — composite is a pure aggregator                         |
| `detected_by`   | OPTIONAL — additional gate WHEN to expand includes                     |
| `skills/` dir   | typically empty — children contribute skills                           |
| Depth cap       | 3 levels of nested composite expansion (composite-of-composites)       |
| Cycle detection | per-root visited-set — cycle → `CompositeResolutionError` at load time |
