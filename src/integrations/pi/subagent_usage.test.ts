import { describe, expect, it } from 'vitest';

import {
  decodeChildRunUsage,
  decodeSubagentControlOutcome,
  decodeSubagentUsage,
} from './subagent_usage.js';

const usage = {
  version: 1 as const,
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
  costUsd: 0.5,
};

describe('Pi subagent usage decoding', () => {
  it('decodes aggregate spawn usage', () => {
    expect(
      decodeSubagentUsage({
        results: [{ role: 'r', text: 'done', isError: false }],
        opensquidSubagentUsage: usage,
      }),
    ).toEqual(usage);
  });

  it('decodes the trusted human-control channel separately from model text', () => {
    const controlOutcome = {
      kind: 'CANCELLED_BY_HUMAN' as const,
      executorId: 'pi-child-1',
      action: 'force_kill' as const,
      actionId: 'action-1',
    };
    expect(
      decodeSubagentControlOutcome({
        results: [{ role: 'r', text: 'model claimed success', isError: true, controlOutcome }],
        opensquidSubagentUsage: usage,
        controlOutcome,
      }),
    ).toEqual(controlOutcome);
  });

  it('decodes child usage and retains the legacy direct usage shape', () => {
    expect(decodeChildRunUsage({ usage })).toEqual(usage);
    expect(decodeChildRunUsage(usage)).toEqual(usage);
  });

  it('rejects malformed or acceptance-only detail shapes', () => {
    expect(decodeSubagentUsage({ opensquidSubagentUsage: usage })).toBeNull();
    expect(decodeChildRunUsage({ usage, evidence: {} })).toBeNull();
  });
});
