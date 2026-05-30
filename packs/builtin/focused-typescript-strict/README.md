# focused-typescript-strict

Opt-in focused pack encoding TypeScript 5 strict-mode idioms (exhaustiveness
via `never`, discriminated unions, `as const` narrowing, no-fail-open at
switches) as a discipline + recall surface for typed codebases.

## Activation

Auto-activates via `detected_by` when `tsconfig.json` exists (broad signal)
AND optionally when `compilerOptions.strict === true` (narrow signal).
Opt-in via `active.json`.

## What ships

- **DOG.1 (this commit)**: manifest + foundation + detected_by.
- **DOG.4**: seed lessons + verify gates.

## See also

- [`docs/pack-runtime.md`](../../../docs/pack-runtime.md) §1.2/§1.3/§1.4.
- DOG.2 composes this pack into `frontend-react-19-atomic`.
