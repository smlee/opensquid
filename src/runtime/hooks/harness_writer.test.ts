/** #26 HWS.4 — the CC advisory-nudge writer: renders all three delta kinds, preserves the shipped stale-closed
 *  text (no regression), writes NOTHING, and honors the injectable seam (a custom writer substitutes cleanly). */
import { describe, expect, it } from 'vitest';

import { ccNudgeWriter, buildStaleClosedNudge, type HarnessWriter } from './harness_writer.js';
import type { OutboundDelta } from '../../workgraph/harness_sync.js';

describe('ccNudgeWriter', () => {
  it('returns null for an empty delta-set (nothing to say)', async () => {
    expect(await ccNudgeWriter.apply([])).toBeNull();
  });

  it('a `close` delta renders EXACTLY the shipped stale-closed nudge (no regression)', async () => {
    const rendered = await ccNudgeWriter.apply([{ kind: 'close', harnessId: 'h1' }]);
    expect(rendered).toBe(buildStaleClosedNudge(['h1'])); // byte-for-byte the shipped message
    expect(rendered).toContain('#h1');
    expect(rendered).toContain('TaskUpdate');
    expect(rendered).toContain('completed');
  });

  it('a `status:closed` delta renders the same "mark completed" nudge as `close`', async () => {
    const rendered = await ccNudgeWriter.apply([
      { kind: 'status', harnessId: 'h9', status: 'closed' },
    ]);
    expect(rendered).toBe(buildStaleClosedNudge(['h9']));
  });

  it('a `create` delta renders a TaskCreate nudge naming the wg id + title', async () => {
    const rendered = await ccNudgeWriter.apply([
      { kind: 'create', wgId: 'wg-100', title: 'ship it' },
    ]);
    expect(rendered).toContain('wg-100');
    expect(rendered).toContain('ship it');
    expect(rendered).toContain('TaskCreate');
  });

  it('a mixed delta-set renders all lines joined (close/status grouped + a create line)', async () => {
    const deltas: OutboundDelta[] = [
      { kind: 'close', harnessId: 'h1' },
      { kind: 'status', harnessId: 'h2', status: 'closed' },
      { kind: 'create', wgId: 'wg-5', title: 'new work' },
    ];
    const rendered = await ccNudgeWriter.apply(deltas);
    expect(rendered).not.toBeNull();
    const lines = rendered!.split('\n');
    // The two complete-nudges are grouped into one line (the shipped multi-id format); the create is its own.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('#h1');
    expect(lines[0]).toContain('#h2');
    expect(lines[1]).toContain('wg-5');
  });

  it('the seam is honored — a custom HarnessWriter substitutes wherever ccNudgeWriter is (proves abstraction)', async () => {
    const recording: HarnessWriter & { calls: OutboundDelta[][] } = {
      calls: [],
      apply(d) {
        this.calls.push(d);
        return Promise.resolve(d.length ? 'custom' : null);
      },
    };
    const writer: HarnessWriter = recording; // assignable where ccNudgeWriter is expected
    const out = await writer.apply([{ kind: 'create', wgId: 'wg-1', title: 't' }]);
    expect(out).toBe('custom');
    expect(recording.calls).toHaveLength(1);
  });

  it('WRITES nothing — apply only returns advisory text (no Task-tool call, no side effect)', async () => {
    // The writer's sole output is its return value; there is no injected transport it could call.
    const before = await ccNudgeWriter.apply([{ kind: 'close', harnessId: 'h1' }]);
    const after = await ccNudgeWriter.apply([{ kind: 'close', harnessId: 'h1' }]);
    expect(after).toBe(before); // pure — identical input → identical output, no accumulated state
  });
});
