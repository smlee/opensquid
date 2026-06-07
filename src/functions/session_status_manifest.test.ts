/**
 * Tests for `session_status_manifest` (T-SESSION-STATUS-MANIFEST) — the ONE
 * consolidated session-start connection report. Flow status is isolated via
 * CLAUDE_CONFIG_DIR (same seam as check_flow_health). Chat/packs/daemon/engine
 * sections are asserted by presence (their VALUES depend on machine state), and
 * the structural invariants (header + exactly 5 bullets, never throws) are the
 * load-bearing guarantees.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flowEnforcementProblems } from './check_flow_health.js';
import { SessionStatusManifest } from './session_status_manifest.js';

// The manifest's Flow section delegates to flowEnforcementProblems (hooks-wired AND an active
// FSM-pack check). The pack check reads ambient umbrella state — coding-flow is active locally
// but absent in CI's clean env — so assert the manifest's COMPOSITION here against a controllable
// flow-problem set; the detection itself is covered by check_flow_health's own tests.
vi.mock('./check_flow_health.js', () => ({ flowEnforcementProblems: vi.fn() }));
const mockFlow = vi.mocked(flowEnforcementProblems);

const ctx = {
  sessionId: 'ssm-test',
  event: { kind: 'session_start' as const, cwd: process.cwd() },
} as never;

const WIRED = {
  hooks: {
    PreToolUse: [{ hooks: [{ type: 'command', command: 'opensquid-hook-pretooluse' }] }],
    UserPromptSubmit: [
      { hooks: [{ type: 'command', command: 'opensquid-hook-userpromptsubmit' }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'opensquid-hook-stop' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'opensquid-hook-sessionstart' }] }],
  },
};

describe('session_status_manifest', () => {
  let configDir: string;
  let prior: string | undefined;

  beforeEach(async () => {
    prior = process.env.CLAUDE_CONFIG_DIR;
    configDir = await mkdtemp(join(tmpdir(), 'ssm-'));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    mockFlow.mockReset();
    mockFlow.mockResolvedValue([]); // default: no problems → gates active
  });
  afterEach(async () => {
    if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior;
    await rm(configDir, { recursive: true, force: true });
  });

  it('emits the header + exactly five sections, every bullet labelled', async () => {
    await writeFile(join(configDir, 'settings.json'), JSON.stringify(WIRED), 'utf8');
    const r = await SessionStatusManifest.execute({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok || r.value === null) throw new Error('manifest must always produce content');
    const lines = r.value.content.split('\n');
    expect(lines[0]).toBe('📋 opensquid — session connections');
    expect(lines).toHaveLength(6); // header + 5 bullets
    for (const b of lines.slice(1)) expect(b.startsWith('• ')).toBe(true);
    expect(r.value.content).toMatch(/• Chat:/);
    expect(r.value.content).toMatch(/• Flow gates:/);
    expect(r.value.content).toMatch(/• Packs/);
    expect(r.value.content).toMatch(/• Daemon:/);
    expect(r.value.content).toMatch(/• Engine\/memory:/);
  });

  it('lists the active packs by name (loaded from the builtin tree in-process)', async () => {
    await writeFile(join(configDir, 'settings.json'), JSON.stringify(WIRED), 'utf8');
    const r = await SessionStatusManifest.execute({}, ctx);
    if (!r.ok || r.value === null) throw new Error('no manifest');
    // loadActivePacks resolves the builtin packs in-process; the Packs line is
    // either "Packs (N): a, b" or "Packs: none loaded" — never "unknown".
    expect(r.value.content).toMatch(/• Packs( \(\d+\): .+| : none loaded|: none loaded)/);
    expect(r.value.content).not.toMatch(/• Packs: unknown/);
  });

  it('flow gates INACTIVE → folds the F3 loud restart signal into the manifest', async () => {
    mockFlow.mockResolvedValue([
      'opensquid hooks are NOT wired in ~/.claude/settings.json for: PreToolUse',
    ]);
    const r = await SessionStatusManifest.execute({}, ctx);
    if (!r.ok || r.value === null) throw new Error('no manifest');
    expect(r.value.content).toMatch(/Flow gates: INACTIVE ⛔/);
    expect(r.value.content).toMatch(/NOT wired/);
    expect(r.value.content).toMatch(/RESTART this session/);
  });

  it('flow gates active → concise ✅ line, no restart noise', async () => {
    mockFlow.mockResolvedValue([]); // no problems → gates active
    const r = await SessionStatusManifest.execute({}, ctx);
    if (!r.ok || r.value === null) throw new Error('no manifest');
    expect(r.value.content).toMatch(/Flow gates: active ✅/);
    expect(r.value.content).not.toMatch(/RESTART this session/);
  });

  it('never throws and always yields 5 sections even with no settings.json (fail-quiet)', async () => {
    // no settings.json written → flow probe degrades, others still resolve.
    const r = await SessionStatusManifest.execute({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok || r.value === null) throw new Error('no manifest');
    expect(r.value.content.split('\n')).toHaveLength(6);
  });
});
