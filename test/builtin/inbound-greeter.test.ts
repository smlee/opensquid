/**
 * T-L3-LOOP LL.5 — verifies the reference `inbound-greeter` skill ships
 * inside the `default-discipline` pack with a valid `inbound_channel`
 * trigger.
 */
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadPack } from '../../src/packs/loader.js';

describe('builtin default-discipline / inbound-greeter (T-L3-LOOP LL.5)', () => {
  it('loads as part of default-discipline pack', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    const skill = pack.skills.find((s) => s.name === 'inbound-greeter');
    expect(skill).toBeDefined();
  });

  it('declares an inbound_channel trigger with a sender_pattern', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    const skill = pack.skills.find((s) => s.name === 'inbound-greeter');
    expect(skill?.triggers).toHaveLength(1);
    const t = skill?.triggers[0] as { kind: string; sender_pattern?: string };
    expect(t.kind).toBe('inbound_channel');
    expect(t.sender_pattern).toBe('^.+$');
    // Validate the regex actually compiles + matches a typical sender.
    const re = new RegExp(t.sender_pattern ?? '');
    expect(re.test('alice')).toBe(true);
    expect(re.test('')).toBe(false);
  });

  it('emits a single surface verdict rule (passive evaluator posture)', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    const skill = pack.skills.find((s) => s.name === 'inbound-greeter');
    expect(skill?.rules).toHaveLength(1);
    const rule = skill?.rules[0];
    expect(rule?.id).toBe('surface-acknowledgment');
    expect(rule?.kind).toBe('track_check');
  });

  it('unloads on session_ends so it stays scoped to one chat watch lifetime', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    const skill = pack.skills.find((s) => s.name === 'inbound-greeter');
    expect(skill?.unloads_when).toContainEqual({ kind: 'session_ends' });
  });
});
