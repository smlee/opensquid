/**
 * CHS.1 — codex-hooks-writer: projection idempotency, the 0.5.378
 * mixed-group surgery, absolute paths, timeouts, the anchored matcher,
 * and the SessionEnd negative pin.
 */

import { describe, expect, it } from 'vitest';

import {
  CODEX_EVENTS,
  type CodexHooksFile,
  type CodexMatcherGroup,
  projectCodexHooks,
  pruneOpensquidFromGroup,
} from './codex-hooks-writer.js';

const BIN = '/abs/bin';

describe('projectCodexHooks', () => {
  it('fresh file: exactly the 5 events, absolute paths, timeouts, anchored matcher', () => {
    const { next, added, replaced, preserved } = projectCodexHooks({ current: {}, binDir: BIN });
    expect(added).toBe(5);
    expect(replaced).toBe(0);
    expect(preserved).toBe(0);
    expect(Object.keys(next.hooks ?? {}).sort()).toEqual([...CODEX_EVENTS].sort());
    // NO SessionEnd ever — codex Stop is turn-scoped; a sessionend wire
    // would clear the FSM every turn (the spec's negative pin).
    expect(next.hooks?.SessionEnd).toBeUndefined();
    const pre = next.hooks?.PreToolUse?.[0];
    expect(pre?.matcher).toBe('^.*$');
    expect(pre?.hooks[0]?.command).toBe('/abs/bin/opensquid-hook-pretooluse');
    expect(pre?.hooks[0]?.timeout).toBe(620);
    expect(pre?.hooks[0]?.['@opensquid']).toBe(true);
    expect(next.hooks?.Stop?.[0]?.hooks[0]?.timeout).toBe(60);
  });

  it('re-run is idempotent: replaced 5, added 0, content stable', () => {
    const once = projectCodexHooks({ current: {}, binDir: BIN });
    const twice = projectCodexHooks({ current: once.next, binDir: BIN });
    expect(twice.added).toBe(0);
    expect(twice.replaced).toBe(5);
    expect(JSON.stringify(twice.next)).toBe(JSON.stringify(once.next));
  });

  it('foreign groups byte-preserved; mixed group counted as REPLACED (entry-level)', () => {
    const foreignGroup: CodexMatcherGroup = {
      matcher: 'Write|Edit',
      hooks: [{ type: 'command', command: '/some/figma-hook.sh' }],
    };
    const mixedGroup: CodexMatcherGroup = {
      matcher: '^.*$',
      hooks: [
        { type: 'command', command: '/some/foreign.sh' },
        { type: 'command', command: '/old/opensquid-hook-pretooluse', '@opensquid': true },
      ],
    };
    const current: CodexHooksFile = {
      keep_me: 'foreign-top-level',
      hooks: { PostToolUse: [foreignGroup], PreToolUse: [mixedGroup] },
    };
    const { next, added, replaced, preserved } = projectCodexHooks({ current, binDir: BIN });
    expect(next.keep_me).toBe('foreign-top-level');
    expect(next.hooks?.PostToolUse?.[0]).toEqual(foreignGroup);
    // mixed group: ours excised, the foreign sibling kept
    const survivors = next.hooks?.PreToolUse?.find((g) => g.hooks.some((h) => !h['@opensquid']));
    expect(survivors?.hooks.map((h) => h.command)).toEqual(['/some/foreign.sh']);
    expect(replaced).toBe(1); // PreToolUse had ours (entry-level count)
    expect(added).toBe(4);
    expect(preserved).toBeGreaterThanOrEqual(2);
  });
});

describe('pruneOpensquidFromGroup', () => {
  it('wholly ours → null; wholly foreign → identity; mixed → foreign survivors', () => {
    const ours: CodexMatcherGroup = {
      hooks: [{ type: 'command', command: 'opensquid-hook-stop', '@opensquid': true }],
    };
    const foreign: CodexMatcherGroup = { hooks: [{ type: 'command', command: '/x.sh' }] };
    expect(pruneOpensquidFromGroup(ours)).toBeNull();
    expect(pruneOpensquidFromGroup(foreign)).toBe(foreign);
    const mixed: CodexMatcherGroup = { hooks: [...ours.hooks, ...foreign.hooks] };
    expect(pruneOpensquidFromGroup(mixed)?.hooks).toEqual(foreign.hooks);
  });
});
