/**
 * Tests for `channels.yaml` schema.
 *
 * Coverage: empty record + populated record + rejection of non-string values.
 */

import { describe, expect, it } from 'vitest';

import { ChannelsConfig } from './channels.js';

describe('ChannelsConfig schema', () => {
  it('parses an empty record (minimum-viable)', () => {
    expect(ChannelsConfig.parse({})).toEqual({});
  });

  it('defaults to empty record when undefined', () => {
    expect(ChannelsConfig.parse(undefined)).toEqual({});
  });

  it('parses a populated abstract-name → URI map', () => {
    const result = ChannelsConfig.parse({
      alerts: 'telegram://12345/666',
      audit_log: 'slack://workspace/audit',
    });
    expect(result.alerts).toBe('telegram://12345/666');
    expect(result.audit_log).toBe('slack://workspace/audit');
  });

  it('rejects non-string URI values', () => {
    const result = ChannelsConfig.safeParse({ alerts: 42 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['alerts']);
    }
  });
});
