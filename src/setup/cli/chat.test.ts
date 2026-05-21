/* eslint-disable @typescript-eslint/require-await */
/**
 * WIZ.5 — tests for `src/setup/cli/chat.ts`.
 *
 * Pure argv-parse + dispatch tests. The wizard itself is exhaustively
 * tested in `chat_actions.test.ts`; here we only verify that:
 *   1. The 3 flags (--dry-run / --replace / --skip-test) map correctly
 *      to the underlying `WizardDeps` shape + env-var side effect.
 *   2. Bare `opensquid setup` prints help (doesn't auto-run wizard).
 *   3. `--skip-test` restores prior OPENSQUID_NO_BILLED_CALLS on exit.
 *   4. The runWizard stub is called exactly once per `setup chat` invocation.
 *
 * Strategy: substitute `runWizard` with a recording stub, build a fresh
 * commander program per test, drive it via `parseAsync` with a fabricated
 * argv array. No subprocess, no real file system.
 */

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerSetup, type ChatCliDeps } from './chat.js';

import type { WizardDeps, WizardResult } from './chat_actions.js';

// ---------------------------------------------------------------------------
// Recorder — captures every call to runWizard so tests can assert on the
// args. Each test resets it to a fresh state.
// ---------------------------------------------------------------------------

interface RunRecord {
  calls: WizardDeps[];
  // Snapshot of OPENSQUID_NO_BILLED_CALLS at the moment runWizard was invoked,
  // so we can prove `--skip-test` toggled it BEFORE the wizard ran.
  envSnapshots: (string | undefined)[];
}

function makeRecorder(env: NodeJS.ProcessEnv): {
  record: RunRecord;
  deps: ChatCliDeps;
} {
  const record: RunRecord = { calls: [], envSnapshots: [] };
  const runWizard = async (deps: WizardDeps): Promise<WizardResult> => {
    record.calls.push(deps);
    record.envSnapshots.push(env.OPENSQUID_NO_BILLED_CALLS);
    return { outcome: 'completed', written: [] };
  };
  return { record, deps: { runWizard, env } };
}

function buildProgram(deps: ChatCliDeps): Command {
  const program = new Command();
  // Suppress commander's auto-exit so tests don't bail when a parse error
  // happens (we want to assert on it instead).
  program.exitOverride();
  // Silence help/error output during tests.
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  registerSetup(program, deps);
  return program;
}

// ---------------------------------------------------------------------------
// Per-test env isolation — every test runs against a synthetic env so the
// real process.env (and any concurrent OPENSQUID_NO_BILLED_CALLS) isn't
// touched. The chat.ts shim reads + writes via the injected `env` ref.
// ---------------------------------------------------------------------------

let env: NodeJS.ProcessEnv;

beforeEach(() => {
  env = {};
});

afterEach(() => {
  env = {};
});

describe('registerSetup — chat subcommand argv parsing', () => {
  it('no flags → wizardDeps has neither dryRun nor replace; no env mutation', async () => {
    const { record, deps } = makeRecorder(env);
    const program = buildProgram(deps);
    await program.parseAsync(['node', 'opensquid', 'setup', 'chat']);
    expect(record.calls).toHaveLength(1);
    expect(record.calls[0]).toEqual({});
    expect(record.envSnapshots[0]).toBeUndefined();
  });

  it('--dry-run → wizardDeps.dryRun=true', async () => {
    const { record, deps } = makeRecorder(env);
    const program = buildProgram(deps);
    await program.parseAsync(['node', 'opensquid', 'setup', 'chat', '--dry-run']);
    expect(record.calls).toHaveLength(1);
    expect(record.calls[0]?.dryRun).toBe(true);
    expect(record.calls[0]?.replace).toBeUndefined();
  });

  it('--replace → wizardDeps.replace=true', async () => {
    const { record, deps } = makeRecorder(env);
    const program = buildProgram(deps);
    await program.parseAsync(['node', 'opensquid', 'setup', 'chat', '--replace']);
    expect(record.calls).toHaveLength(1);
    expect(record.calls[0]?.replace).toBe(true);
    expect(record.calls[0]?.dryRun).toBeUndefined();
  });

  it('all three flags compose', async () => {
    const { record, deps } = makeRecorder(env);
    const program = buildProgram(deps);
    await program.parseAsync([
      'node',
      'opensquid',
      'setup',
      'chat',
      '--dry-run',
      '--replace',
      '--skip-test',
    ]);
    expect(record.calls).toHaveLength(1);
    expect(record.calls[0]?.dryRun).toBe(true);
    expect(record.calls[0]?.replace).toBe(true);
    // --skip-test toggles OPENSQUID_NO_BILLED_CALLS=1 BEFORE the wizard runs.
    expect(record.envSnapshots[0]).toBe('1');
  });
});

describe('--skip-test env-var toggle', () => {
  it('sets OPENSQUID_NO_BILLED_CALLS=1 during wizard run, restores prior undefined after', async () => {
    const { record, deps } = makeRecorder(env);
    const program = buildProgram(deps);
    expect(env.OPENSQUID_NO_BILLED_CALLS).toBeUndefined();
    await program.parseAsync(['node', 'opensquid', 'setup', 'chat', '--skip-test']);
    expect(record.envSnapshots[0]).toBe('1');
    // After the wizard returns, env is restored to the prior undefined state.
    expect(env.OPENSQUID_NO_BILLED_CALLS).toBeUndefined();
  });

  it('preserves prior OPENSQUID_NO_BILLED_CALLS value after --skip-test exits', async () => {
    env.OPENSQUID_NO_BILLED_CALLS = '0';
    const { record, deps } = makeRecorder(env);
    const program = buildProgram(deps);
    await program.parseAsync(['node', 'opensquid', 'setup', 'chat', '--skip-test']);
    expect(record.envSnapshots[0]).toBe('1');
    // Prior value restored, not deleted.
    expect(env.OPENSQUID_NO_BILLED_CALLS).toBe('0');
  });

  it('without --skip-test, env is left untouched throughout', async () => {
    env.OPENSQUID_NO_BILLED_CALLS = 'preset-value';
    const { record, deps } = makeRecorder(env);
    const program = buildProgram(deps);
    await program.parseAsync(['node', 'opensquid', 'setup', 'chat']);
    expect(record.envSnapshots[0]).toBe('preset-value');
    expect(env.OPENSQUID_NO_BILLED_CALLS).toBe('preset-value');
  });

  it('restores prior env even when runWizard throws', async () => {
    env.OPENSQUID_NO_BILLED_CALLS = 'preset';
    const runWizard = async (): Promise<WizardResult> => {
      throw new Error('wizard exploded');
    };
    const program = buildProgram({ runWizard, env });
    await expect(
      program.parseAsync(['node', 'opensquid', 'setup', 'chat', '--skip-test']),
    ).rejects.toThrow('wizard exploded');
    // Env must be restored even on throw — `finally` block in chat.ts.
    expect(env.OPENSQUID_NO_BILLED_CALLS).toBe('preset');
  });
});

describe('bare `setup` verb does not auto-run wizard', () => {
  it('opensquid setup (no subcommand) prints help and does NOT invoke runWizard', async () => {
    const { record, deps } = makeRecorder(env);
    const program = buildProgram(deps);
    // Commander's default behavior for a verb-group with no action +
    // no matched subcommand is to display help and exit. With
    // exitOverride() it throws a CommanderError instead of exiting.
    // What matters: runWizard is NEVER called.
    try {
      await program.parseAsync(['node', 'opensquid', 'setup']);
    } catch {
      // Commander may throw a "help" or "unknownCommand" error when there's
      // no default action — either is acceptable. Critical assertion below.
    }
    expect(record.calls).toHaveLength(0);
  });
});

describe('help text exposes the three flags', () => {
  it('--help output lists --dry-run, --replace, --skip-test', () => {
    const { deps } = makeRecorder(env);
    const program = buildProgram(deps);
    const chatCmd = program.commands
      .find((c) => c.name() === 'setup')
      ?.commands.find((c) => c.name() === 'chat');
    expect(chatCmd).toBeDefined();
    const helpText = chatCmd?.helpInformation() ?? '';
    expect(helpText).toContain('--dry-run');
    expect(helpText).toContain('--replace');
    expect(helpText).toContain('--skip-test');
  });
});
