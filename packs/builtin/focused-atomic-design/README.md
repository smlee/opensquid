# focused-atomic-design

Opt-in focused pack encoding Atomic Design idioms (atoms → molecules →
organisms → templates → pages; token-driven theming; one-component-per-file)
as a discipline + recall surface.

## Activation

Auto-activates via `detected_by` when the project's filesystem matches any
of the canonical atomic-design layouts (`src/components/atoms/` etc.).

## What ships

- **DOG.1 (this commit)**: manifest + foundation (no tools — methodology
  pack) + detected_by (filesystem signals only).
- **DOG.4**: seed lessons + verify gates.

## See also

- [`docs/pack-runtime.md`](../../../docs/pack-runtime.md) §1.2/§1.3/§1.4.
- DOG.2 composes this pack into `frontend-react-19-atomic`.
