/**
 * GR.1 — claimAudience derives the harness identity from the trusted GDC env markers (the same set
 * the gate uses). CLAUDECODE wins over CODEX (a session is one or the other); neither → unknown.
 */
import { describe, expect, it } from 'vitest';

import { claimAudience } from './audience.js';

describe('claimAudience', () => {
  it('CLAUDECODE → claudecode with version', () => {
    expect(claimAudience({ CLAUDECODE: '1.2.3' })).toEqual({
      source: 'claudecode',
      version: '1.2.3',
    });
  });

  it('CODEX_THREAD_ID → codex with threadId', () => {
    expect(claimAudience({ CODEX_THREAD_ID: 'abc' })).toEqual({ source: 'codex', threadId: 'abc' });
  });

  it('neither marker → unknown', () => {
    expect(claimAudience({})).toEqual({ source: 'unknown' });
  });

  it('empty-string markers are treated as absent', () => {
    expect(claimAudience({ CLAUDECODE: '', CODEX_THREAD_ID: '' })).toEqual({ source: 'unknown' });
  });

  it('CLAUDECODE takes precedence when both are set', () => {
    expect(claimAudience({ CLAUDECODE: '9', CODEX_THREAD_ID: 'x' })).toEqual({
      source: 'claudecode',
      version: '9',
    });
  });
});
