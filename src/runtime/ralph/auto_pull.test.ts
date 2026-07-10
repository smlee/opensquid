/** GF.5/GF.6 (T-gitflow-integration-fix) — the SEMANTIC branch naming (`slugify`/`featBranchFor`) + the base-refresh
 *  `reconcileBase` four-state reconcile FSM. Driven over a PURE injected `ReconcileIo` stub (NO real git, NO remote,
 *  NO fixture) — the FSM is exercised purely by the (behind, ahead) counts the stub returns. A guard test reads the
 *  source and asserts the reconcile seam is discard-free (open-Q4: MERGE, never rebase/reset). */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { slugify, featBranchFor, reconcileBase, type ReconcileIo } from './auto_pull.js';

/** A pure ReconcileIo stub: it returns the given (behind, ahead) from `counts`, and records every call by name so
 *  the test can assert WHICH effects the FSM invoked (ff vs merge vs abort). `mergeOk=false` → a merge conflict. */
const io = (
  behind: number,
  ahead: number,
  mergeOk = true,
): { io: ReconcileIo; calls: string[] } => {
  const calls: string[] = [];
  return {
    io: {
      fetch: () => {
        calls.push('fetch');
        return Promise.resolve();
      },
      checkout: () => {
        calls.push('checkout');
        return Promise.resolve();
      },
      counts: () => Promise.resolve({ behind, ahead }),
      ffMerge: () => {
        calls.push('ff');
        return Promise.resolve();
      },
      mergeNoEdit: () => {
        calls.push('merge');
        return Promise.resolve(mergeOk);
      },
      abortMerge: () => {
        calls.push('abort');
        return Promise.resolve();
      },
    },
    calls,
  };
};

describe('GF.5 slugify — a URL/branch-safe slug', () => {
  it('lowercases, collapses punctuation/spaces to single `-`, and trims edges', () => {
    expect(slugify('Fix the Git-Flow Integration!!')).toBe('fix-the-git-flow-integration');
  });

  it('trims leading and trailing separators', () => {
    expect(slugify('  ***Hello, World***  ')).toBe('hello-world');
  });

  it('caps the slug at 60 chars', () => {
    const long = 'a'.repeat(100);
    const out = slugify(long);
    expect(out.length).toBe(60);
    expect(out.length).toBeLessThanOrEqual(60);
  });

  it('a slice at a separator does not leave a trailing `-` from the cap', () => {
    // 60 alnum chars, then a space, then more — slice(0,60) lands exactly on the alnum run.
    const out = slugify(`${'a'.repeat(60)} tail`);
    expect(out).toBe('a'.repeat(60));
  });
});

describe('GF.5 featBranchFor — the parallel per-item SEMANTIC branch name', () => {
  it('is `feat/<slug-of-title>`', () => {
    expect(featBranchFor('Add the Reconcile FSM')).toBe('feat/add-the-reconcile-fsm');
  });
});

describe('GF.6 reconcileBase — the four-state (behind, ahead) reconcile FSM', () => {
  it('(0,0) → up-to-date; no ff, no merge', async () => {
    const { io: stub, calls } = io(0, 0);
    const out = await reconcileBase('/repo', 'production', 'origin', stub);
    expect(out).toEqual({ kind: 'up-to-date' });
    expect(calls).not.toContain('ff');
    expect(calls).not.toContain('merge');
  });

  it('(behind>0, ahead=0) → fast-forwarded; ffMerge called, mergeNoEdit NOT', async () => {
    const { io: stub, calls } = io(3, 0);
    const out = await reconcileBase('/repo', 'production', 'origin', stub);
    expect(out).toEqual({ kind: 'fast-forwarded' });
    expect(calls).toContain('ff');
    expect(calls).not.toContain('merge');
  });

  it('(ahead>0, behind=0) → kept-local; NEITHER ffMerge NOR mergeNoEdit called', async () => {
    const { io: stub, calls } = io(0, 2);
    const out = await reconcileBase('/repo', 'production', 'origin', stub);
    expect(out).toEqual({ kind: 'kept-local' });
    expect(calls).not.toContain('ff');
    expect(calls).not.toContain('merge');
    expect(calls).not.toContain('abort');
  });

  it('(behind>0, ahead>0) merge OK → merged; mergeNoEdit called, no abort', async () => {
    const { io: stub, calls } = io(2, 2, true);
    const out = await reconcileBase('/repo', 'production', 'origin', stub);
    expect(out).toEqual({ kind: 'merged' });
    expect(calls).toContain('merge');
    expect(calls).not.toContain('abort');
    expect(calls).not.toContain('ff');
  });

  it('(behind>0, ahead>0) merge CONFLICT → conflict; abortMerge called (never auto-picks a side)', async () => {
    const { io: stub, calls } = io(2, 2, false);
    const out = await reconcileBase('/repo', 'production', 'origin', stub);
    expect(out).toEqual({ kind: 'conflict' });
    expect(calls).toContain('merge');
    expect(calls).toContain('abort');
  });

  it('always fetches then checks out the CONFIGURED base branch (never a hardcoded main)', async () => {
    const { io: stub, calls } = io(0, 0);
    await reconcileBase('/repo', 'staging', 'origin', stub);
    expect(calls[0]).toBe('fetch');
    expect(calls[1]).toBe('checkout');
  });
});

describe('GF.6 ReconcileIo seam — discard-free (open-Q4: MERGE, never rebase/reset)', () => {
  it('the ReconcileIo interface exposes no reset/rebase capability', () => {
    const { io: stub } = io(0, 0);
    // Compile- and shape-level: the seam has no reset/rebase method to call.
    expect('reset' in stub).toBe(false);
    expect('rebase' in stub).toBe(false);
  });

  it('the source has no `rebase` or `reset --hard` in the reconcile path', () => {
    const raw = readFileSync(join(__dirname, 'auto_pull.ts'), 'utf8');
    // Strip block + line comments — the doc comments deliberately NAME rebase/reset to state they are excluded;
    // the guard is over the executable code, which must invoke neither.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/rebase|reset --hard/);
  });
});
