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
const TASKS_DIRS = [resolve(REPO, 'docs/tasks'), resolve(REPO, '../docs/tasks')];

describe('spec-citation integrity (FAC.1)', () => {
  it('every docs/tasks/*.md cited in non-test src exists on disk', () => {
    const out = execSync(
      `grep -rhoE 'docs/tasks/[A-Za-z0-9._-]+\\.md' src --include='*.ts' --exclude='*.test.ts' || true`,
      { cwd: REPO, encoding: 'utf8' },
    );
    const cited = [...new Set(out.split('\n').filter(Boolean))].map((s) =>
      s.replace('docs/tasks/', ''),
    );
    expect(cited.length).toBeGreaterThan(0); // the grep itself must be live
    const dangling = cited.filter((doc) => !TASKS_DIRS.some((d) => existsSync(resolve(d, doc))));
    expect(dangling).toEqual([]);
  });
});
