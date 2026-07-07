/** REL.6 (wg-80b1960a5c18) — structural assertion over the tag-triggered publish workflow. NO live publish:
 *  the guard LOGIC (versionAlreadyPublished) is unit-tested in REL.1; this asserts the WIRING (tag-only trigger,
 *  clean-env green before publish, the version-difference guard, publish gated on the guard + NODE_AUTH_TOKEN). */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse as yamlParse } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const raw = readFileSync(resolve(REPO_ROOT, '.github/workflows/publish.yml'), 'utf8');

interface Workflow {
  on?: { push?: { tags?: string[]; branches?: string[] } };
  permissions?: { contents?: string };
  jobs?: Record<
    string,
    { steps?: { name?: string; run?: string; if?: string; env?: Record<string, string> }[] }
  >;
}
const wf = yamlParse(raw) as Workflow;

describe('REL.6 publish.yml structure', () => {
  it('is valid YAML', () => {
    expect(wf).toBeTypeOf('object');
  });

  it('triggers ONLY on a v* tag push (no branch/PR trigger)', () => {
    expect(wf.on?.push?.tags).toEqual(['v*']);
    expect(wf.on?.push?.branches).toBeUndefined();
  });

  it('declares read-only contents permission', () => {
    expect(wf.permissions?.contents).toBe('read');
  });

  it('runs the full suite (typecheck/lint/test/build) BEFORE any publish', () => {
    const steps = wf.jobs?.publish?.steps ?? [];
    const runIdx = (needle: string): number =>
      steps.findIndex((s) => (s.run ?? '').includes(needle));
    for (const cmd of ['pnpm typecheck', 'pnpm lint', 'pnpm test', 'pnpm build']) {
      expect(runIdx(cmd)).toBeGreaterThanOrEqual(0);
    }
    const publishIdx = steps.findIndex((s) => (s.run ?? '').trim() === 'npm publish');
    expect(publishIdx).toBeGreaterThan(runIdx('pnpm build')); // publish only after the clean-env build
  });

  it('runs the version-difference guard via REL.1 versionAlreadyPublished', () => {
    const steps = wf.jobs?.publish?.steps ?? [];
    const guard = steps.find((s) => (s.name ?? '').toLowerCase().includes('guard'));
    expect(guard?.run).toContain('versionAlreadyPublished');
    expect(guard?.run).toContain('dist/runtime/release/release_core.js'); // single-sourced from dist/, not inline
  });

  it('gates npm publish on the guard output + uses NODE_AUTH_TOKEN from secrets.NPM_TOKEN', () => {
    const steps = wf.jobs?.publish?.steps ?? [];
    const publish = steps.find((s) => (s.run ?? '').trim() === 'npm publish');
    expect(publish?.if).toContain("steps.guard.outputs.publish == 'true'");
    expect(publish?.env?.NODE_AUTH_TOKEN).toContain('secrets.NPM_TOKEN');
  });
});
