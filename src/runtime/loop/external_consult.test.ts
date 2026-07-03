/**
 * GFR.4 / E2 — the external-CONSULTATION signal (record/read, windowed, fail-closed). Uses the vitest
 * globalSetup OPENSQUID_HOME temp dir for session-state writes (precedent: readiness.test.ts).
 */
import { describe, expect, it } from 'vitest';

import {
  externalConsultResult,
  isExternalConsultTool,
  recordExternalConsult,
} from './external_consult.js';

let n = 0;
const sid = (): string => `external-consult-test-${String(n++)}`;

describe('isExternalConsultTool', () => {
  it('recognizes the core harness tools + MCP web fetchers', () => {
    for (const t of [
      'WebSearch',
      'WebFetch',
      'mcp__fetch__fetch',
      'mcp__docs__web_fetch',
      'mcp__x__web_search',
    ]) {
      expect(isExternalConsultTool(t)).toBe(true);
    }
  });
  it('rejects codebase-only + unrelated tools', () => {
    for (const t of ['Grep', 'Read', 'Bash', 'Edit', 'mcp__opensquid__recall', '']) {
      expect(isExternalConsultTool(t)).toBe(false);
    }
  });
});

describe('externalConsultResult', () => {
  it('fails CLOSED on a never-recorded task', async () => {
    expect(await externalConsultResult(sid(), 'T1')).toEqual({ before: false, after: false });
  });

  it('records the before window without touching after', async () => {
    const s = sid();
    await recordExternalConsult(s, 'T1', 'before');
    expect(await externalConsultResult(s, 'T1')).toEqual({ before: true, after: false });
  });

  it('records the after window without touching before', async () => {
    const s = sid();
    await recordExternalConsult(s, 'T1', 'after');
    expect(await externalConsultResult(s, 'T1')).toEqual({ before: false, after: true });
  });

  it('is MONOTONIC: a later after-consult never clears an earlier before-consult', async () => {
    const s = sid();
    await recordExternalConsult(s, 'T1', 'before');
    await recordExternalConsult(s, 'T1', 'after');
    expect(await externalConsultResult(s, 'T1')).toEqual({ before: true, after: true });
  });

  it('keys per task', async () => {
    const s = sid();
    await recordExternalConsult(s, 'T1', 'before');
    expect(await externalConsultResult(s, 'T2')).toEqual({ before: false, after: false });
  });
});
