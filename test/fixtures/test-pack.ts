/**
 * Phase 1 smoke-test fixture pack — `never-amend` exemplar.
 *
 * A minimal but complete `Pack` that exercises the runtime end-to-end:
 *
 *   - one skill (`git`), preload mode, no load/unload conditions
 *   - one rule (`never-amend`), `track_check` kind
 *   - two-step process: `match_command` (regex against `tool_args.command`)
 *     gated by `verdict` (emits `block` when the match hits)
 *
 * The pack uses ONLY primitives that do not need external systems —
 * `match_command` reads the in-memory `Event`, `verdict` constructs an
 * in-memory `Verdict`. No Ollama, no `claude` CLI, no libsql, no filesystem.
 * That hermeticity is the whole point: the smoke test proves the substrate
 * wires together (registry → evaluator → dispatcher → hook exit code)
 * without any infrastructure dependency.
 *
 * Phase 2 deletes this fixture in favor of real on-disk YAML packs loaded
 * via `~/.opensquid/active.json`.
 *
 * Imported by: test/e2e/runtime-smoke.test.ts.
 */

import type { Pack } from '../../src/runtime/types.js';

export const neverAmendPack: Pack = {
  name: 'test-pack',
  version: '0.1.0',
  scope: 'workflow',
  goal: 'block git commit --amend in tests',
  description: '',
  requires: [],
  conflicts: [],
  evolves: false,
  skills: [
    {
      name: 'git',
      load: 'preload',
      when_to_load: [],
      unloads_when: [],
      rules: [
        {
          id: 'never-amend',
          kind: 'track_check',
          process: [
            {
              call: 'match_command',
              args: { pattern: 'git\\s+commit.*--amend', target: 'tool_args.command' },
              as: 'hit',
            },
            {
              call: 'verdict',
              if: 'hit',
              args: { level: 'block', message: 'amend forbidden' },
            },
          ],
        },
      ],
    },
  ],
};
