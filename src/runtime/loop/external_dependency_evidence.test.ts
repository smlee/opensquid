/**
 * GFR.4 / E2 — the external-needed evidence bridge (injectable git read → the diff-derived conditionality).
 * FAIL-OPEN to not-needed on no-cwd / git-error / empty-diff (the SUPPLEMENT never bricks the flow).
 */
import { describe, expect, it } from 'vitest';

import {
  externalNeededForSession,
  type ExternalNeededDeps,
} from './external_dependency_evidence.js';

const deps = (over: Partial<ExternalNeededDeps>): ExternalNeededDeps => ({
  cwd: () => Promise.resolve('/repo'),
  diff: () => Promise.resolve(''),
  ...over,
});

const IMPORT_DIFF = ['--- a/src/foo.ts', '+++ b/src/foo.ts', "+import { z } from 'zod'"].join('\n');

describe('externalNeededForSession', () => {
  it('is true when the diff adds a new third-party import', async () => {
    expect(
      await externalNeededForSession('s', deps({ diff: () => Promise.resolve(IMPORT_DIFF) })),
    ).toBe(true);
  });

  it('is false for a diff with no external touch (exempt)', async () => {
    const internal = '--- a/src/foo.ts\n+++ b/src/foo.ts\n+  const y = 1';
    expect(
      await externalNeededForSession('s', deps({ diff: () => Promise.resolve(internal) })),
    ).toBe(false);
  });

  it('fails OPEN (false) when there is no cwd', async () => {
    expect(await externalNeededForSession('s', deps({ cwd: () => Promise.resolve(null) }))).toBe(
      false,
    );
  });

  it('fails OPEN (false) when the git read throws', async () => {
    expect(
      await externalNeededForSession(
        's',
        deps({
          diff: () => Promise.reject(new Error('not a git repo')),
        }),
      ),
    ).toBe(false);
  });

  it('fails OPEN (false) on an empty diff', async () => {
    expect(await externalNeededForSession('s', deps({ diff: () => Promise.resolve('') }))).toBe(
      false,
    );
  });
});
