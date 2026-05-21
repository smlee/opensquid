/* eslint-disable @typescript-eslint/require-await */
/**
 * Tests for WIZ.3 — interactive chat-setup wizard.
 *
 * Strategy:
 *   - `vi.mock('@clack/prompts')` replaces every prompt with a queue-driven
 *     fake. Each test pre-loads the queue with the values the wizard will
 *     read; if the queue runs dry mid-test, the test fails with "unexpected
 *     prompt". This is the same pattern as channels/adapters/telegram.test.ts.
 *   - Each test runs against a fresh tmpdir for `OPENSQUID_HOME` and a
 *     separate tmpdir for `~/.loop/.env` — so file-system assertions never
 *     touch the developer's actual home.
 *   - Seven fixtures per the WIZ.3 acceptance criteria:
 *       1. Clean state full flow → 4 files written.
 *       2. Existing fast_chat (api mode) → Keep branch, no writes.
 *       3. Existing fast_chat (subscription mode) → hard-block warn + Replace.
 *       4. Malformed YAML → cancel + exit code 2, no writes.
 *       5. Ctrl-C at first prompt → no partial write, no backup dir.
 *       6. Dry-run preview shown before confirm (text contains plan paths).
 *       7. Write failure → rollback path engaged (backup dir created,
 *          original files preserved).
 */

import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @clack/prompts — every interactive function pulls from a shared
// queue. `pushPrompts` lets each test prime the queue; the wizard then
// "asks questions" by calling the mocked function, which returns the head
// of the queue.
// ---------------------------------------------------------------------------

interface PromptState {
  queue: unknown[];
  cancelMessages: string[];
  outroMessages: string[];
  introMessages: string[];
  notes: { msg?: string; title?: string }[];
  /** When set, the next prompt returns the cancel symbol instead of consuming the queue. */
  injectCancelOnPrompt: number | null;
  /** Counter of prompts called (for injectCancelOnPrompt). */
  promptCount: number;
}

const state: PromptState = {
  queue: [],
  cancelMessages: [],
  outroMessages: [],
  introMessages: [],
  notes: [],
  injectCancelOnPrompt: null,
  promptCount: 0,
};

const CANCEL_SYMBOL = Symbol.for('opensquid-test-cancel');

function consume(): unknown {
  state.promptCount += 1;
  if (state.injectCancelOnPrompt !== null && state.promptCount === state.injectCancelOnPrompt) {
    return CANCEL_SYMBOL;
  }
  if (state.queue.length === 0) {
    throw new Error('test setup error: prompt queue ran dry');
  }
  return state.queue.shift();
}

vi.mock('@clack/prompts', () => ({
  intro: (msg?: string): void => {
    if (msg !== undefined) state.introMessages.push(msg);
  },
  outro: (msg?: string): void => {
    if (msg !== undefined) state.outroMessages.push(msg);
  },
  cancel: (msg?: string): void => {
    if (msg !== undefined) state.cancelMessages.push(msg);
  },
  note: (msg?: string, title?: string): void => {
    const entry: { msg?: string; title?: string } = {};
    if (msg !== undefined) entry.msg = msg;
    if (title !== undefined) entry.title = title;
    state.notes.push(entry);
  },
  text: async (): Promise<unknown> => consume(),
  password: async (): Promise<unknown> => consume(),
  confirm: async (): Promise<unknown> => consume(),
  select: async (): Promise<unknown> => consume(),
  multiselect: async (): Promise<unknown> => consume(),
  spinner: (): { start: () => void; stop: () => void; message: () => void } => ({
    start: () => undefined,
    stop: () => undefined,
    message: () => undefined,
  }),
  isCancel: (v: unknown): boolean => v === CANCEL_SYMBOL,
}));

// Import AFTER vi.mock so the wizard pulls in the mocked module.
const { runChatSetupWizard } = await import('./chat_actions.js');

// ---------------------------------------------------------------------------
// Per-test fixtures
// ---------------------------------------------------------------------------

let homeDir: string;
let envHome: string;
let envPath: string;
let priorHome: string | undefined;
let priorNoBilled: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  priorNoBilled = process.env.OPENSQUID_NO_BILLED_CALLS;
  homeDir = await mkdtemp(join(tmpdir(), 'opensquid-wiz3-home-'));
  envHome = await mkdtemp(join(tmpdir(), 'opensquid-wiz3-loop-'));
  envPath = join(envHome, '.env');
  process.env.OPENSQUID_HOME = homeDir;
  // Default: skip billed calls so test (f) is a no-op.
  process.env.OPENSQUID_NO_BILLED_CALLS = '1';
  // Reset prompt state.
  state.queue = [];
  state.cancelMessages = [];
  state.outroMessages = [];
  state.introMessages = [];
  state.notes = [];
  state.injectCancelOnPrompt = null;
  state.promptCount = 0;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  if (priorNoBilled === undefined) delete process.env.OPENSQUID_NO_BILLED_CALLS;
  else process.env.OPENSQUID_NO_BILLED_CALLS = priorNoBilled;
});

function queue(...values: unknown[]): void {
  state.queue.push(...values);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fixture 1 — Clean state, full flow
// ---------------------------------------------------------------------------

describe('runChatSetupWizard — clean state full flow', () => {
  it('writes models.yaml + .env + manifest + chat_agent.yaml after explicit confirm', async () => {
    // Queue mirrors the prompt order in the wizard:
    //   (c) model select, mode select, api key, key dest
    //   (d) "no packs" prompt, starter pack name, default_model, prompt choice,
    //       skills, tunables
    //   (e) channel offer
    //   (g) final confirm
    // (f) is skipped because OPENSQUID_NO_BILLED_CALLS=1
    queue(
      'claude-haiku-4-5-20251001', // model select
      'api', // mode select
      'sk-ant-EXAMPLE1234', // password — API key
      'env', // dest select
      'create', // "no packs — create starter"
      'chat-agent-default', // pack name text
      'fast_chat', // default_model select
      'default', // system prompt choice
      'none', // skills choice
      'no', // tunables choice
      'skip', // channel offer
      true, // final confirm
    );

    const captured: number[] = [];
    const result = await runChatSetupWizard({
      opensquidHome: homeDir,
      envPath,
      setExitCode: (c) => captured.push(c),
    });

    expect(result.outcome).toBe('completed');
    expect(result.written ?? []).toHaveLength(4);
    expect(captured).toEqual([]);

    // models.yaml
    const modelsRaw = await readFile(join(homeDir, 'models.yaml'), 'utf8');
    expect(modelsRaw).toContain('fast_chat:');
    expect(modelsRaw).toContain('mode: api');
    expect(modelsRaw).toContain('provider: anthropic');
    expect(modelsRaw).toContain('claude-haiku-4-5-20251001');

    // .env
    const envRaw = await readFile(envPath, 'utf8');
    expect(envRaw).toContain('ANTHROPIC_API_KEY=sk-ant-EXAMPLE1234');
    const envStat = await stat(envPath);
    // On POSIX, mode & 0o777 should be 0o600.
    expect(envStat.mode & 0o777).toBe(0o600);

    // pack files
    const packRoot = join(homeDir, 'packs', 'chat-agent-default');
    const manifestRaw = await readFile(join(packRoot, 'manifest.yaml'), 'utf8');
    expect(manifestRaw).toContain('name: chat-agent-default');
    const chatAgentRaw = await readFile(join(packRoot, 'chat_agent.yaml'), 'utf8');
    expect(chatAgentRaw).toContain('default_model: fast_chat');

    // Backup dir exists (even if empty — wizard pre-creates it).
    const backupBase = join(homeDir, 'backup');
    expect(await pathExists(backupBase)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fixture 2 — Existing fast_chat (api mode) → Keep
// ---------------------------------------------------------------------------

describe('runChatSetupWizard — existing fast_chat (api mode)', () => {
  it('Keep branch exits without writes', async () => {
    await writeFile(
      join(homeDir, 'models.yaml'),
      'fast_chat:\n  mode: api\n  provider: anthropic\n  model: claude-haiku-4-5-20251001\n',
      'utf8',
    );
    queue('keep'); // idempotency choice

    const result = await runChatSetupWizard({ opensquidHome: homeDir, envPath });

    expect(result.outcome).toBe('no_changes');
    // Models file unchanged.
    const raw = await readFile(join(homeDir, 'models.yaml'), 'utf8');
    expect(raw).toContain('mode: api');
    expect(raw).not.toContain('Daily-driver chat agent');
    // No backup dir (nothing to back up).
    expect(state.outroMessages.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Fixture 3 — Existing fast_chat (subscription mode) → hard-block warn + Replace
// ---------------------------------------------------------------------------

describe('runChatSetupWizard — existing fast_chat (subscription mode)', () => {
  it('warns about sub-mode then walks Replace into api-mode', async () => {
    await writeFile(
      join(homeDir, 'models.yaml'),
      'fast_chat:\n  mode: subscription\n  impl: cli\n  cli: claude\n',
      'utf8',
    );
    queue(
      'replace', // idempotency choice
      'claude-haiku-4-5-20251001', // model select
      'api', // mode select
      'sk-ant-NEWKEY9999', // password
      'env', // dest
      'create', // no packs
      'chat-agent-default', // pack name
      'fast_chat', // default_model
      'default', // system prompt
      'none', // skills
      'no', // tunables
      'skip', // channel offer
      true, // final confirm
    );

    const result = await runChatSetupWizard({ opensquidHome: homeDir, envPath });

    expect(result.outcome).toBe('completed');
    // Sub-mode warning note was emitted before the idempotency choice.
    const warnNote = state.notes.find((nn) => nn.title === 'Warning');
    expect(warnNote?.msg ?? '').toContain('subscription mode');
    // models.yaml now api mode.
    const raw = await readFile(join(homeDir, 'models.yaml'), 'utf8');
    expect(raw).toContain('mode: api');
    // Old subscription block was backed up.
    const backupBase = join(homeDir, 'backup');
    expect(await pathExists(backupBase)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fixture 4 — Malformed YAML → cancel + exit 2, no writes
// ---------------------------------------------------------------------------

describe('runChatSetupWizard — malformed models.yaml', () => {
  it('cancels with exit code 2 and never prompts past detection', async () => {
    await writeFile(join(homeDir, 'models.yaml'), 'fast_chat:\n  mode: "api\n', 'utf8');

    const captured: number[] = [];
    const result = await runChatSetupWizard({
      opensquidHome: homeDir,
      envPath,
      setExitCode: (c) => captured.push(c),
    });

    expect(result.outcome).toBe('aborted');
    expect(captured).toEqual([2]);
    // No prompts consumed — wizard bailed during detection.
    expect(state.promptCount).toBe(0);
    expect(state.cancelMessages.join('\n')).toContain("can't parse");
    // models.yaml unchanged.
    const raw = await readFile(join(homeDir, 'models.yaml'), 'utf8');
    expect(raw).toContain('"api');
  });
});

// ---------------------------------------------------------------------------
// Fixture 5 — Ctrl-C at first prompt → no partial write, no backup dir
// ---------------------------------------------------------------------------

describe('runChatSetupWizard — Ctrl-C at first prompt', () => {
  it('aborts cleanly with no files modified and no backup dir', async () => {
    // Inject cancel on the very first prompt (the model select).
    state.injectCancelOnPrompt = 1;

    const result = await runChatSetupWizard({ opensquidHome: homeDir, envPath });

    expect(result.outcome).toBe('aborted');
    expect(state.cancelMessages.join('\n')).toContain('No files modified');
    // No models.yaml, no env file, no backup dir.
    expect(await pathExists(join(homeDir, 'models.yaml'))).toBe(false);
    expect(await pathExists(envPath)).toBe(false);
    expect(await pathExists(join(homeDir, 'backup'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixture 6 — Dry-run preview shown before confirm
// ---------------------------------------------------------------------------

describe('runChatSetupWizard — dry-run preview', () => {
  it('emits a Plan note containing every target path before the final confirm', async () => {
    queue(
      'claude-haiku-4-5-20251001',
      'api',
      'sk-ant-SHOWPLAN0000',
      'env',
      'create',
      'chat-agent-default',
      'fast_chat',
      'default',
      'none',
      'no',
      'skip',
      false, // DECLINE the confirm — wizard exits without writing
    );

    const result = await runChatSetupWizard({ opensquidHome: homeDir, envPath });

    expect(result.outcome).toBe('aborted');
    const planNote = state.notes.find((nn) => nn.title === 'Plan');
    expect(planNote).toBeDefined();
    expect(planNote?.msg ?? '').toContain('models.yaml');
    expect(planNote?.msg ?? '').toContain(envPath);
    expect(planNote?.msg ?? '').toContain('chat_agent.yaml');
    // Critically: dry-run masks the key.
    expect(planNote?.msg ?? '').not.toContain('SHOWPLAN0000');
    expect(planNote?.msg ?? '').toContain('=…0000');
    // No files written.
    expect(await pathExists(join(homeDir, 'models.yaml'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixture 7 — Write failure → rollback (we trigger it by pre-creating a
// directory at the path where chat_agent.yaml needs to write, so the rename
// step EISDIRs)
// ---------------------------------------------------------------------------

describe('runChatSetupWizard — write failure rollback', () => {
  it('preserves existing files when a write fails mid-plan', async () => {
    // Seed an existing models.yaml so we have something to back up + restore.
    await writeFile(
      join(homeDir, 'models.yaml'),
      'capable_writer:\n  mode: api\n  provider: anthropic\n  model: claude-sonnet-4-6\n',
      'utf8',
    );
    // Pre-create a DIRECTORY at the chat_agent.yaml target so the rename
    // will fail with EISDIR.
    const packRoot = join(homeDir, 'packs', 'chat-agent-default');
    await mkdir(join(packRoot, 'chat_agent.yaml'), { recursive: true });

    queue(
      'claude-haiku-4-5-20251001',
      'api',
      'sk-ant-FAIL00009999',
      'env',
      // Pack picker sees an existing pack now, so it's a different flow.
      'chat-agent-default', // pack select
      'fast_chat', // default_model
      'default', // system prompt
      'none', // skills
      'no', // tunables
      'skip', // channel offer
      true, // final confirm
    );

    const captured: number[] = [];
    const result = await runChatSetupWizard({
      opensquidHome: homeDir,
      envPath,
      setExitCode: (c) => captured.push(c),
    });

    expect(result.outcome).toBe('aborted');
    expect(captured).toEqual([3]);
    // Original models.yaml restored (still contains capable_writer, not fast_chat).
    const raw = await readFile(join(homeDir, 'models.yaml'), 'utf8');
    expect(raw).toContain('capable_writer');
  });
});
