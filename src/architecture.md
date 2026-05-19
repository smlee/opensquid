# src/ architecture

Dependency direction (enforced via eslint-plugin-import + audits):

- `mcp/` and `setup/` may import from anything in src/.
- `runtime/` imports from `functions/`, `packs/`, `channels/`, `secrets/`, `rag/`, `models/`.
- Nothing imports from `mcp/` or `setup/`.
- `functions/` imports nothing else in src/ (leaves).
- `packs/` imports from `functions/` (for validation only) and types from `runtime/`.
- `channels/`, `secrets/`, `rag/`, `models/` are sibling layers — none import each other.

Each `index.ts` carries a one-sentence doc comment describing the module's job.
