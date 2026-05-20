/**
 * Tests for CLI.1 — `opensquid triggers list|show|fire|enable|disable`.
 *
 * Strategy: build a fixture packsDir via `mkdtemp` with three packs (seven
 * triggers spanning all four kinds), drive the verbs through
 * `commander.parseAsync` against `registerTriggers` with injected
 * stdout/stderr/dispatch deps. Asserts cover row counts, filter behavior,
 * error messages, dispatcher invocation, atomic state-file writes, and the
 * non-TTY confirmation-refusal path.
 */

import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerTriggers, renderTable } from './triggers.js';
import { buildRows } from './triggers_state.js';

import type { Event } from '../../runtime/types.js';

let packsDir: string;
let stateDir: string;
let statePath: string;
let outChunks: string[];
let errChunks: string[];

const out = (s: string): void => {
  outChunks.push(s);
};
const errSink = (s: string): void => {
  errChunks.push(s);
};
const outText = (): string => outChunks.join('');
const errText = (): string => errChunks.join('');

async function writePack(
  root: string,
  name: string,
  skills: { name: string; triggers: unknown[] }[],
): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'manifest.yaml'),
    `name: ${name}\nversion: 0.0.1\nscope: project\ngoal: test fixture\n`,
    'utf8',
  );
  for (const skill of skills) {
    const skillDir = join(dir, 'skills', skill.name);
    await mkdir(skillDir, { recursive: true });
    const triggersBlock = skill.triggers.map((t) => `  - ${JSON.stringify(t)}`).join('\n');
    await writeFile(
      join(skillDir, 'skill.yaml'),
      `name: ${skill.name}\ntriggers:\n${triggersBlock}\n`,
      'utf8',
    );
  }
}

beforeEach(async () => {
  packsDir = await mkdtemp(join(tmpdir(), 'opensquid-triggers-packs-'));
  stateDir = await mkdtemp(join(tmpdir(), 'opensquid-triggers-state-'));
  statePath = join(stateDir, 'trigger_state.yaml');
  outChunks = [];
  errChunks = [];

  // 3 packs / 7 triggers spanning all four kinds.
  await writePack(packsDir, 'ci', [
    {
      name: 'drift-digest',
      triggers: [{ kind: 'schedule', cron: '0 9 * * 1' }, { kind: 'tool_call' }],
    },
  ]);
  await writePack(packsDir, 'billing', [
    {
      name: 'stripe-router',
      triggers: [
        { kind: 'webhook', path: '/stripe' },
        { kind: 'inbound_channel', channel: 'alerts' },
      ],
    },
  ]);
  await writePack(packsDir, 'fs-watch', [
    {
      name: 'docs-rebuild',
      triggers: [
        { kind: 'file_changed', paths: ['docs/**/*.md'] },
        { kind: 'schedule', cron: '*/5 * * * *' },
        { kind: 'webhook', path: '/rebuild' },
      ],
    },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function build(deps: Parameters<typeof registerTriggers>[1] = {}): Command {
  const program = new Command();
  registerTriggers(program, {
    packsDir,
    statePath,
    stdout: out,
    stderr: errSink,
    isTty: () => false,
    ...deps,
  });
  return program;
}

const argv = (...args: string[]): string[] => ['node', 'cli', 'triggers', ...args];

describe('opensquid triggers list', () => {
  it('lists all 7 triggers across 3 packs by default', async () => {
    expect(await buildRows({ packsDir, statePath })).toHaveLength(7);
    await build().parseAsync(argv('list'));
    const lines = outText().trim().split('\n');
    expect(lines).toHaveLength(8); // 1 header + 7 rows
    expect(lines[0]).toMatch(/ID\s+KIND\s+PACK\s+SKILL\s+FILTER\s+STATUS/);
  });

  it('--kind schedule filters to schedule triggers only', async () => {
    await build().parseAsync(argv('list', '--kind', 'schedule'));
    const lines = outText().trim().split('\n');
    expect(lines).toHaveLength(3); // header + 2 schedule rows
    expect(outText()).toContain('ci:drift-digest:schedule:0');
    expect(outText()).toContain('fs-watch:docs-rebuild:schedule:1');
    expect(outText()).not.toContain(':webhook:');
  });

  it('--pack billing filters to one pack', async () => {
    await build().parseAsync(argv('list', '--pack', 'billing'));
    expect(outText()).toContain('billing:stripe-router:webhook:0');
    expect(outText()).toContain('billing:stripe-router:inbound_channel:1');
    expect(outText()).not.toContain('ci:');
    expect(outText()).not.toContain('fs-watch:');
  });

  it('reports "(no triggers found)" when filters match nothing', async () => {
    await build().parseAsync(argv('list', '--pack', 'nonexistent'));
    expect(outText()).toContain('(no triggers found)');
  });
});

describe('opensquid triggers show', () => {
  it('returns JSON detail for an existent id', async () => {
    await build().parseAsync(argv('show', 'ci:drift-digest:schedule:0'));
    const parsed = JSON.parse(outText()) as Record<string, unknown>;
    expect(parsed.id).toBe('ci:drift-digest:schedule:0');
    expect(parsed.kind).toBe('schedule');
    expect(parsed.pack).toBe('ci');
    expect((parsed.raw as { cron: string }).cron).toBe('0 9 * * 1');
  });

  it('exits 1 + prints clean error on nonexistent id', async () => {
    const prev = process.exitCode;
    await build().parseAsync(argv('show', 'bogus:bogus:schedule:0'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('no trigger with id "bogus:bogus:schedule:0"');
    process.exitCode = prev;
  });
});

describe('opensquid triggers fire', () => {
  it('dispatches a ScheduleEvent with --yes', async () => {
    const dispatch = vi.fn<(e: Event) => Promise<void>>(() => Promise.resolve());
    await build({ dispatch }).parseAsync(argv('fire', 'ci:drift-digest:schedule:0', '--yes'));
    expect(dispatch).toHaveBeenCalledOnce();
    const event = dispatch.mock.calls[0]?.[0];
    expect(event?.kind).toBe('schedule');
    if (event?.kind === 'schedule') expect(event.scheduleId).toBe('ci:drift-digest:schedule:0');
    expect(outText()).toContain('fired ci:drift-digest:schedule:0');
  });

  it('refuses to dispatch without --yes in non-TTY context', async () => {
    const dispatch = vi.fn();
    const prev = process.exitCode;
    await build({ dispatch }).parseAsync(argv('fire', 'ci:drift-digest:schedule:0'));
    expect(dispatch).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('refusing to dispatch');
    expect(errText()).toContain('without --yes in non-interactive context');
    process.exitCode = prev;
  });

  it('synthesizes a WebhookEvent shape for kind=webhook', async () => {
    const dispatch = vi.fn<(e: Event) => Promise<void>>(() => Promise.resolve());
    await build({ dispatch }).parseAsync(argv('fire', 'billing:stripe-router:webhook:0', '--yes'));
    const event = dispatch.mock.calls[0]?.[0];
    expect(event?.kind).toBe('webhook');
    if (event?.kind === 'webhook') {
      expect(event.method).toBe('POST');
      expect(event.subscriptionId).toBe('billing:stripe-router:webhook:0');
    }
  });

  it('exits 1 on nonexistent id', async () => {
    const prev = process.exitCode;
    await build().parseAsync(argv('fire', 'nope:nope:schedule:0', '--yes'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('no trigger with id');
    process.exitCode = prev;
  });
});

describe('opensquid triggers enable/disable round-trip', () => {
  it('disable adds id to state, list reports status=disabled', async () => {
    await build().parseAsync(argv('disable', 'ci:drift-digest:schedule:0'));
    expect(outText()).toContain('disabled ci:drift-digest:schedule:0');
    expect(await readFile(statePath, 'utf8')).toContain('ci:drift-digest:schedule:0');

    outChunks = [];
    await build().parseAsync(argv('list', '--pack', 'ci', '--kind', 'schedule'));
    expect(outText()).toMatch(
      /ci:drift-digest:schedule:0\s+schedule\s+ci\s+drift-digest\s+cron=0 9 \* \* 1\s+disabled/,
    );
  });

  it('enable removes id from state', async () => {
    await build().parseAsync(argv('disable', 'ci:drift-digest:schedule:0'));
    outChunks = [];
    await build().parseAsync(argv('enable', 'ci:drift-digest:schedule:0'));
    expect(outText()).toContain('enabled ci:drift-digest:schedule:0');
    expect(await readFile(statePath, 'utf8')).toContain('disabled: []');
  });

  it('atomic write leaves no .tmp file on success', async () => {
    await build().parseAsync(argv('disable', 'ci:drift-digest:schedule:0'));
    const files = await readdir(stateDir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(files).toContain('trigger_state.yaml');
  });

  it('disable on nonexistent id exits 1', async () => {
    const prev = process.exitCode;
    await build().parseAsync(argv('disable', 'nope:nope:schedule:0'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('no trigger with id');
    process.exitCode = prev;
  });
});

describe('renderTable layout', () => {
  it('renders kubectl-style columns with header + body rows', () => {
    const rendered = renderTable(
      [
        {
          id: 'ci:drift-digest:schedule:0',
          pack: 'ci',
          skill: 'drift-digest',
          kind: 'schedule',
          index: 0,
          filter: 'cron=0 9 * * 1',
          enabled: true,
        },
        {
          id: 'billing:stripe-router:webhook:0',
          pack: 'billing',
          skill: 'stripe-router',
          kind: 'webhook',
          index: 0,
          filter: 'path=/stripe',
          enabled: false,
        },
      ],
      { color: false },
    );
    const lines = rendered.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^ID\s+KIND\s+PACK\s+SKILL\s+FILTER\s+STATUS\s*$/);
    expect(lines[1]).toContain('enabled');
    expect(lines[2]).toContain('disabled');
  });
});
