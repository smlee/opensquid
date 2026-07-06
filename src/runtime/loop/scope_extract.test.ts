/**
 * T2.4 — extractScope parse tests (deterministic, zero LLM). Artifacts are written to an OS temp dir
 * (file reads are by absolute path; no session-state involvement).
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractScope } from './scope_extract.js';

async function writeArtifact(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scope-extract-'));
  const p = join(dir, 'art.md');
  await writeFile(p, body, 'utf8');
  return p;
}

describe('extractScope (T2.4)', () => {
  it('returns null for a missing artifact (fail-closed at the gate)', async () => {
    expect(await extractScope('/no/such/path/nope.md')).toBeNull();
  });

  it('parses numbered items into authored/scope/task elements + their anchors', async () => {
    const p = await writeArtifact(
      [
        '# Pre-research',
        '',
        '1. Build the login form [ask: "add a login screen"] src/auth/login.ts:12 wg-abc123',
        '2. Wire the session store [ask: "keep me signed in"] src/auth/session.ts:40',
      ].join('\n'),
    );
    const ext = await extractScope(p);
    expect(ext).not.toBeNull();
    expect(ext?.authoredElements).toEqual([
      { id: 'scope-1', anchor: { kind: 'ask_span', ref: 'add a login screen' } },
      { id: 'scope-2', anchor: { kind: 'ask_span', ref: 'keep me signed in' } },
    ]);
    expect(ext?.scopeElements).toEqual([
      {
        designId: 'scope-1',
        askSpan: 'add a login screen',
        text: 'Build the login form [ask: "add a login screen"] src/auth/login.ts:12 wg-abc123',
      },
      {
        designId: 'scope-2',
        askSpan: 'keep me signed in',
        text: 'Wire the session store [ask: "keep me signed in"] src/auth/session.ts:40',
      },
    ]);
    expect(ext?.tasks).toEqual([
      { designId: 'scope-1', fileLines: ['src/auth/login.ts:12'], wgIds: ['wg-abc123'] },
      { designId: 'scope-2', fileLines: ['src/auth/session.ts:40'], wgIds: [] },
    ]);
  });

  it('an item with no [ask: ...] marker → a null anchor (no_anchor → drift)', async () => {
    const p = await writeArtifact('1. An unanchored addition src/x.ts:1');
    const ext = await extractScope(p);
    expect(ext?.authoredElements).toEqual([{ id: 'scope-1', anchor: null }]);
    expect(ext?.scopeElements).toEqual([
      { designId: 'scope-1', askSpan: '', text: 'An unanchored addition src/x.ts:1' },
    ]);
  });

  it('parses [needs: M] dependency refs into deps edges (reason empty when undeclared)', async () => {
    const p = await writeArtifact(
      ['1. Root [ask: "root"]', '2. Leaf [ask: "leaf"] [needs: 1]'].join('\n'),
    );
    const ext = await extractScope(p);
    expect(ext?.deps).toEqual([{ element: 'scope-2', dependsOn: 'scope-1', reason: '' }]);
  });

  it('captures the DERIVED reason from `[needs: M — <reason>]`', async () => {
    const p = await writeArtifact(
      [
        '1. Root [ask: "root"]',
        '2. Leaf [ask: "leaf"] [needs: 1 — Leaf consumes Root output]',
      ].join('\n'),
    );
    const ext = await extractScope(p);
    expect(ext?.deps).toEqual([
      { element: 'scope-2', dependsOn: 'scope-1', reason: 'Leaf consumes Root output' },
    ]);
  });

  it('is deterministic — same artifact twice → identical extract', async () => {
    const p = await writeArtifact('1. Same [ask: "same"] src/a.ts:1');
    expect(await extractScope(p)).toEqual(await extractScope(p));
  });
});
