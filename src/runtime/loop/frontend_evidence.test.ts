/**
 * frontend_evidence (FD5) — the pre-delivery gate fact. Unit-tests the fail-open contract + the audit wiring with
 * injectable staged-file deps (no real git). FAIL-OPEN is the safety-critical property: a commit we cannot analyze
 * must NEVER be blocked; only a proven staged CRITICAL frontend defect yields clean:false.
 */
import { describe, expect, it } from 'vitest';

import { frontendEvidenceForEvent, type FrontendEvidenceDeps } from './frontend_evidence.js';
import type { Event } from '../types.js';

const commit = (cwd?: string): Event =>
  ({
    kind: 'tool_call',
    tool: 'Bash',
    args: { command: 'git commit -m x' },
    cwd,
  }) as unknown as Event;

const depsWith = (files: { path: string; content: string }[]): FrontendEvidenceDeps => ({
  stagedFiles: () => Promise.resolve(files),
});

describe('frontendEvidenceForEvent', () => {
  it('clean staged frontend → clean:true, zero critical', async () => {
    const fe = await frontendEvidenceForEvent(
      commit('/repo'),
      depsWith([{ path: 'Card.tsx', content: '<img src="x" alt="ok" />' }]),
    );
    expect(fe.clean).toBe(true);
    expect(fe.critical).toBe(0);
  });

  it('a staged CRITICAL frontend defect → clean:false (the gate blocks)', async () => {
    const fe = await frontendEvidenceForEvent(
      commit('/repo'),
      depsWith([{ path: 'Card.tsx', content: '<img src="logo.png">' }]),
    );
    expect(fe.clean).toBe(false);
    expect(fe.critical).toBe(1);
  });

  it('FAIL-OPEN: a non-tool_call event → clean:true', async () => {
    const fe = await frontendEvidenceForEvent({
      kind: 'prompt_submit',
      prompt: 'x',
    } as unknown as Event);
    expect(fe.clean).toBe(true);
  });

  it('FAIL-OPEN: no cwd → clean:true (cannot analyze)', async () => {
    const fe = await frontendEvidenceForEvent(
      commit(undefined),
      depsWith([{ path: 'a.tsx', content: '<img src="x">' }]),
    );
    expect(fe.clean).toBe(true);
  });

  it('FAIL-OPEN: a deps error (git failure) → clean:true (never brick the commit)', async () => {
    const fe = await frontendEvidenceForEvent(commit('/repo'), {
      stagedFiles: () => Promise.reject(new Error('not a git repo')),
    });
    expect(fe.clean).toBe(true);
  });

  it('no staged frontend files → clean:true', async () => {
    const fe = await frontendEvidenceForEvent(commit('/repo'), depsWith([]));
    expect(fe.clean).toBe(true);
    expect(fe.filesScanned).toBe(0);
  });
});
