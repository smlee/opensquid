/**
 * FAC.1 (T-fix-audit-correctness, wg-8f7d9b919a40) — spec-citation
 * integrity pin: every `docs/tasks/*.md` a non-test source file cites as
 * authority must EXIST on disk. The whole-source audit found 35 citations
 * to five planning docs that were never committed — code deferring to
 * artifacts nobody can produce. Scope matches the mechanical census that
 * drove the cleanup: non-test src only.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../..');
// Cited docs may live in the opensquid repo OR the umbrella planning repo.
// The umbrella repo is NOT present on CI runners (opensquid checks out
// alone), so umbrella-resident citations are pinned by NAME here and by
// EXISTENCE whenever the umbrella is available (local dev + the pre-push
// gate, which runs this suite where the umbrella exists).
const LOCAL_TASKS_DIR = resolve(REPO, 'docs/tasks');
const UMBRELLA_TASKS_DIR = resolve(REPO, '../docs/tasks');
const KNOWN_UMBRELLA_DOCS = [
  'WAB.1-architecture.md',
  'WIZ.1-flow.md',
  'T-telegram-realtime.md',
  'T-compression.md',
  // The FSM-actor runtime spec (substrate + loop-driver tiers) lives in the umbrella planning
  // repo (loop/docs/tasks); cited by the runtime/packs source headers. Existence-verified by the
  // second test whenever the umbrella is available (local dev + pre-push).
  'T-fsm-actor-runtime.md',
  // The FSM-actor RE-SCOPE track (T1+, the event-driven drift fix) — same umbrella planning repo,
  // cited by compile_v2.ts. Existence-verified locally; pinned by name for the CI checkout.
  'T-fsm-actor-rescope.md',
  // The pack v1→v2 migration track (M.1+) — same umbrella planning repo, cited by
  // migrate_v1_to_v2.ts. Existence-verified locally; pinned by name for the CI checkout.
  'T-pack-migrate-v2.md',
];

describe('spec-citation integrity (FAC.1)', () => {
  it('every docs/tasks/*.md cited in non-test src exists on disk (or is a known umbrella doc when the umbrella is absent)', () => {
    const out = execSync(
      `grep -rhoE 'docs/tasks/[A-Za-z0-9._-]+\\.md' src --include='*.ts' --exclude='*.test.ts' || true`,
      { cwd: REPO, encoding: 'utf8' },
    );
    const cited = [...new Set(out.split('\n').filter(Boolean))].map((s) =>
      s.replace('docs/tasks/', ''),
    );
    expect(cited.length).toBeGreaterThan(0); // the grep itself must be live

    const umbrellaAvailable = existsSync(UMBRELLA_TASKS_DIR);
    const resolves = (doc: string): boolean => {
      if (existsSync(resolve(LOCAL_TASKS_DIR, doc))) return true;
      if (umbrellaAvailable) return existsSync(resolve(UMBRELLA_TASKS_DIR, doc));
      return KNOWN_UMBRELLA_DOCS.includes(doc); // CI: pinned by name only
    };
    expect(cited.filter((doc) => !resolves(doc))).toEqual([]);
  });

  it('the known-umbrella allowlist is existence-verified whenever the umbrella is available', () => {
    if (!existsSync(UMBRELLA_TASKS_DIR)) return; // CI — verified in local dev + pre-push
    const missing = KNOWN_UMBRELLA_DOCS.filter(
      (doc) => !existsSync(resolve(UMBRELLA_TASKS_DIR, doc)),
    );
    expect(missing).toEqual([]);
  });
});
