# State formats — the portability stability contract

This document is the format-freeze contract for everything under
`~/.opensquid/`. It exists because `opensquid export` bundles the TRUTH set by
default (denylist design), and a bundle is only migration-grade if the shapes
it carries are stable. The rule set:

- A shape stamped **frozen-v1** changes only ADDITIVELY (new optional fields;
  never renames, removals, or semantic changes to existing fields).
- A shape stamped **evolving** may still change shape; bundles carrying it are
  best-effort across versions.
- **One review gates both lists:** adding a truth store AND adding a denylist
  entry (`EXCLUDE_PATTERNS` in `src/setup/cli/portability.ts`) happen in the
  same change, reviewed against this document. An undocumented new file under
  the home EXPORTS BY DEFAULT (fail-portable) — if that is wrong for the file,
  the same change must add the denylist entry here and in code.

## Truth shapes

| Path                                 | Shape                                                                                                                                                                                                                                                | Stability                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `active.json`                        | `{ "packs": string[] }` — the agent/user-scope pack opt-in.                                                                                                                                                                                          | frozen-v1                      |
| `channels.json`                      | `{ v: 1, umbrellas: [{ id, members[], telegram? {chat_id, topic_id?} }], general?, responder? }` (src/channels/routing.ts schema).                                                                                                                   | frozen-v1                      |
| `config.json`                        | `{ version: 1, chat_connections: { <platform>: { bot_token?, … } } }` (src/channels/config.ts). Credential fields are REDACTED in export bundles.                                                                                                    | frozen-v1                      |
| `models.yaml`                        | Model alias map (src/packs/schemas/models.ts) — `mode`/`impl`/`model`/`args`/`auth: env:…`. Secrets are `env:` references only, never inline.                                                                                                        | frozen-v1                      |
| `packs/<name>/…`                     | The pack format: `manifest.yaml`, `skills/*/skill.yaml`, `models.yaml`, `fsm.yaml`, `lessons/`, `drift_response.yaml`, `chat_agent.yaml`.                                                                                                            | evolving (pre-1.0 pack format) |
| `phase_ledger/<task>/<phase>.yaml`   | `{ phase, logged_at, note? }` — one file per logged phase (src/runtime/phase_ledger.ts).                                                                                                                                                             | frozen-v1                      |
| `projects.json`, `projects/<uuid>/…` | Project registry + per-project chat state (inbox JSONL etc.).                                                                                                                                                                                        | evolving                       |
| `store/issues/*.json`                | The workgraph OP-LOG — one op per file, Lamport-ordered, content-hashed ids (src/workgraph/). The projections (`workgraph.db`) rebuild from these.                                                                                                   | frozen-v1                      |
| `lessons/<status>/<id>.md`           | Wedge-lesson per-file source (frontmatter + body; src/rag/wedge/source.ts). `wg_lessons.db` rebuilds from these.                                                                                                                                     | frozen-v1                      |
| `memories/mem-*.md`                  | Memory per-file source (frontmatter id/tags/source + body; src/rag/backends/perfile_source.ts). The rebuild CANONICALIZES frontmatter (lossless normalization). `rag.sqlite` rebuilds from these; `.vec` siblings are embedder cache, never bundled. | frozen-v1                      |
| `umbrellas/<id>/inbox/*.jsonl`       | Pending inbound chat messages (user data — transplants with the bundle). Leases (`live-session.lease`) are machine-local and never bundled.                                                                                                          | evolving                       |
| `inbox/…`                            | The orphan inbox (same record shape as project inboxes).                                                                                                                                                                                             | evolving                       |

## Projections (never bundled; rebuilt on import)

| File            | Rebuilt by                                            |
| --------------- | ----------------------------------------------------- |
| `rag.sqlite`    | `opensquid migrate-memories` (or `opensquid rebuild`) |
| `wg_lessons.db` | `opensquid migrate-lessons` (or `opensquid rebuild`)  |
| `workgraph.db`  | `opensquid rebuild` (replays `store/issues/`)         |

## Machine-local (never bundled)

`sessions/` (ephemeral; handoff docs are the portable session truth) ·
`*.sock` / `*.pid` / `*.log` · `*.bak*` · `memories.bak-*` · `loop-engine.*`
(legacy) · `umbrellas/*/live-session.lease` · `memories/*.vec`.

## Bundle format

`opensquid export` produces a gzip tarball with `manifest.json` at the root:
`{ version: 1, opensquid: <package version>, created_at, files }`. Import
refuses a lived-in home (no override) and refuses newer-version bundles unless
`--force` (forward-parse tolerance of the rebuild entries is unproven —
re-evaluate per entry before relaxing).
