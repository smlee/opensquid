/**
 * Tests for WIZ.3 — interactive chat-setup wizard (api-mode scenarios).
 *
 * Strategy:
 *   - Shared mock harness lives in `./chat_actions_test_helpers.ts` (extracted
 *     in WAB-SUB.3 to keep this file under the 450-LOC cap). Importing the
 *     helpers module installs the `@clack/prompts` mock as a side effect.
 *   - Each test runs against a fresh tmpdir for `OPENSQUID_HOME` and a
 *     separate tmpdir for `~/.loop/.env` — so file-system assertions never
 *     touch the developer's actual home.
 *   - WIZ.3 fixtures (preserved + adjusted for the new mode-choice prompt):
 *       1. Clean state full flow + api mode → 4 files written.
 *       2. Existing fast_chat (api mode) → Keep branch, no writes.
 *       3. Malformed YAML → cancel + exit code 2, no writes.
 *       4. Ctrl-C at first prompt → no partial write, no backup dir.
 *       5. Dry-run preview shown before confirm (text contains plan paths).
 *       6. Write failure → rollback path engaged.
 *   - WAB-SUB.3 subscription-mode fixtures live in `chat_actions_wab_sub.test.ts`.
 */

import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  pathExists,
  promptState as state,
  queue,
  setupChatWizardTest,
} from './chat_actions_test_helpers.js';

// Import AFTER the helpers (which installs vi.mock).
const { runChatSetupWizard } = await import('./chat_actions.js');

const ctx = setupChatWizardTest();
const home = (): string => ctx.homeDir();
const env = (): string => ctx.envPath();

// ---------------------------------------------------------------------------
// Fixture 1 — Clean state, full flow (api mode)
// ---------------------------------------------------------------------------

describe('runChatSetupWizard — clean state full flow (api mode)', () => {
  it('writes models.yaml + .env + manifest + chat_agent.yaml after explicit confirm', async () => {
    // Queue mirrors the prompt order in the wizard:
    //   (c.0) mode choice
    //   (c.api) model select, api key, key dest
    //   (d) "no packs" prompt, starter pack name, default_model, prompt choice,
    //       skills, tunables
    //   (e) channel offer
    //   (g) final confirm
    // (f) is skipped because OPENSQUID_NO_BILLED_CALLS=1
    queue(
      'api', // mode choice (WAB-SUB.3)
      'claude-haiku-4-5-20251001', // model select
      'sk-ant-EXAMPLE1234', // password — API key
      'env', // dest select
      'create', // "no packs — create starter"
      'chat-agent-default', // pack name text
      'fast_chat', // default_model select
      'default', // system prompt choice
      'none', // skills choice
      'no', // tunables
      false, // FRS.B: decline pack activation (preserve fixture semantics) choice
      'skip', // channel offer
      true, // final confirm
    );

    const captured: number[] = [];
    const result = await runChatSetupWizard({
      opensquidHome: home(),
      envPath: env(),
      setExitCode: (c) => captured.push(c),
      // FRS.A: pin project identity (environment-independent fixtures).
      projectEnv: { OPENSQUID_PROJECT_UUID: 'fixture-uuid' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.written ?? []).toHaveLength(4);
    expect(captured).toEqual([]);

    // models.yaml
    const modelsRaw = await readFile(join(home(), 'models.yaml'), 'utf8');
    expect(modelsRaw).toContain('fast_chat:');
    expect(modelsRaw).toContain('mode: api');
    expect(modelsRaw).toContain('provider: anthropic');
    expect(modelsRaw).toContain('claude-haiku-4-5-20251001');

    // .env
    const envRaw = await readFile(env(), 'utf8');
    expect(envRaw).toContain('ANTHROPIC_API_KEY=sk-ant-EXAMPLE1234');
    const envStat = await stat(env());
    // On POSIX, mode & 0o777 should be 0o600.
    expect(envStat.mode & 0o777).toBe(0o600);

    // pack files
    const packRoot = join(home(), 'packs', 'chat-agent-default');
    const manifestRaw = await readFile(join(packRoot, 'manifest.yaml'), 'utf8');
    expect(manifestRaw).toContain('name: chat-agent-default');
    const chatAgentRaw = await readFile(join(packRoot, 'chat_agent.yaml'), 'utf8');
    expect(chatAgentRaw).toContain('default_model: fast_chat');

    // Backup dir exists (even if empty — wizard pre-creates it).
    const backupBase = join(home(), 'backup');
    expect(await pathExists(backupBase)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fixture 2 — Existing fast_chat (api mode) → Keep
// ---------------------------------------------------------------------------

describe('runChatSetupWizard — existing fast_chat (api mode)', () => {
  it('Keep branch exits without writes', async () => {
    await writeFile(
      join(home(), 'models.yaml'),
      'fast_chat:\n  mode: api\n  provider: anthropic\n  model: claude-haiku-4-5-20251001\n',
      'utf8',
    );
    queue('keep'); // idempotency choice

    const result = await runChatSetupWizard({
      opensquidHome: home(),
      envPath: env(),
      // FRS.A: pin project identity so these fixtures stay card-free and
      // environment-independent (CI checkouts have no ancestor card).
      projectEnv: { OPENSQUID_PROJECT_UUID: 'fixture-uuid' },
    });

    expect(result.outcome).toBe('no_changes');
    // Models file unchanged.
    const raw = await readFile(join(home(), 'models.yaml'), 'utf8');
    expect(raw).toContain('mode: api');
    expect(raw).not.toContain('Daily-driver chat agent');
    expect(state.outroMessages.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Fixture 3 — Malformed YAML → cancel + exit 2, no writes
// ---------------------------------------------------------------------------

describe('runChatSetupWizard — malformed models.yaml', () => {
  it('cancels with exit code 2 and never prompts past detection', async () => {
    await writeFile(join(home(), 'models.yaml'), 'fast_chat:\n  mode: "api\n', 'utf8');

    const captured: number[] = [];
    const result = await runChatSetupWizard({
      opensquidHome: home(),
      envPath: env(),
      setExitCode: (c) => captured.push(c),
      // FRS.A: pin project identity (environment-independent fixtures).
      projectEnv: { OPENSQUID_PROJECT_UUID: 'fixture-uuid' },
    });

    expect(result.outcome).toBe('aborted');
    expect(captured).toEqual([2]);
    // No prompts consumed — wizard bailed during detection.
    expect(state.promptCount).toBe(0);
    expect(state.cancelMessages.join('\n')).toContain("can't parse");
    // models.yaml unchanged.
    const raw = await readFile(join(home(), 'models.yaml'), 'utf8');
    expect(raw).toContain('"api');
  });
});

// ---------------------------------------------------------------------------
// Fixture 4 — Ctrl-C at first prompt → no partial write, no backup dir
// ---------------------------------------------------------------------------

describe('runChatSetupWizard — Ctrl-C at first prompt', () => {
  it('aborts cleanly with no files modified and no backup dir', async () => {
    // WAB-SUB.3: the very first prompt is now `runModeChoice` (NOT model select).
    // Ctrl-C at the mode choice must still cleanly abort — proves no shape-
    // determining work has happened before the mode is picked.
    state.injectCancelOnPrompt = 1;

    const result = await runChatSetupWizard({
      opensquidHome: home(),
      envPath: env(),
      // FRS.A: pin project identity so these fixtures stay card-free and
      // environment-independent (CI checkouts have no ancestor card).
      projectEnv: { OPENSQUID_PROJECT_UUID: 'fixture-uuid' },
    });

    expect(result.outcome).toBe('aborted');
    expect(state.cancelMessages.join('\n')).toContain('No files modified');
    // No models.yaml, no env file, no backup dir.
    expect(await pathExists(join(home(), 'models.yaml'))).toBe(false);
    expect(await pathExists(env())).toBe(false);
    expect(await pathExists(join(home(), 'backup'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixture 5 — Dry-run preview shown before confirm
// ---------------------------------------------------------------------------

describe('runChatSetupWizard — dry-run preview', () => {
  it('emits a Plan note containing every target path before the final confirm', async () => {
    queue(
      'api', // mode choice (WAB-SUB.3)
      'claude-haiku-4-5-20251001',
      'sk-ant-SHOWPLAN0000',
      'env',
      'create',
      'chat-agent-default',
      'fast_chat',
      'default',
      'none',
      'no',
      false, // FRS.B: decline pack activation
      'skip',
      false, // DECLINE the confirm — wizard exits without writing
    );

    const result = await runChatSetupWizard({
      opensquidHome: home(),
      envPath: env(),
      // FRS.A: pin project identity so these fixtures stay card-free and
      // environment-independent (CI checkouts have no ancestor card).
      projectEnv: { OPENSQUID_PROJECT_UUID: 'fixture-uuid' },
    });

    expect(result.outcome).toBe('aborted');
    const planNote = state.notes.find((nn) => nn.title === 'Plan');
    expect(planNote).toBeDefined();
    expect(planNote?.msg ?? '').toContain('models.yaml');
    expect(planNote?.msg ?? '').toContain(env());
    expect(planNote?.msg ?? '').toContain('chat_agent.yaml');
    // Critically: dry-run masks the key.
    expect(planNote?.msg ?? '').not.toContain('SHOWPLAN0000');
    expect(planNote?.msg ?? '').toContain('=…0000');
    // No files written.
    expect(await pathExists(join(home(), 'models.yaml'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixture 6 — Write failure → rollback (we trigger it by pre-creating a
// directory at the path where chat_agent.yaml needs to write, so the rename
// step EISDIRs)
// ---------------------------------------------------------------------------

describe('runChatSetupWizard — write failure rollback', () => {
  it('preserves existing files when a write fails mid-plan', async () => {
    // Seed an existing models.yaml so we have something to back up + restore.
    await writeFile(
      join(home(), 'models.yaml'),
      'capable_writer:\n  mode: api\n  provider: anthropic\n  model: claude-sonnet-4-6\n',
      'utf8',
    );
    // Pre-create a DIRECTORY at the chat_agent.yaml target so the rename
    // will fail with EISDIR.
    const packRoot = join(home(), 'packs', 'chat-agent-default');
    await mkdir(join(packRoot, 'chat_agent.yaml'), { recursive: true });

    queue(
      'api', // mode choice (WAB-SUB.3)
      'claude-haiku-4-5-20251001',
      'sk-ant-FAIL00009999',
      'env',
      // Pack picker sees an existing pack now, so it's a different flow.
      'chat-agent-default', // pack select
      'fast_chat', // default_model
      'default', // system prompt
      'none', // skills
      'no', // tunables
      false, // FRS.B: decline pack activation (preserve fixture semantics)
      'skip', // channel offer
      true, // final confirm
    );

    const captured: number[] = [];
    const result = await runChatSetupWizard({
      opensquidHome: home(),
      envPath: env(),
      setExitCode: (c) => captured.push(c),
      // FRS.A: pin project identity (environment-independent fixtures).
      projectEnv: { OPENSQUID_PROJECT_UUID: 'fixture-uuid' },
    });

    expect(result.outcome).toBe('aborted');
    expect(captured).toEqual([3]);
    // Original models.yaml restored (still contains capable_writer, not fast_chat).
    const raw = await readFile(join(home(), 'models.yaml'), 'utf8');
    expect(raw).toContain('capable_writer');
  });
});

// ---------------------------------------------------------------------------
// T-FIX-FIRST-RUN-SETUP A — the orchestrator seam: the wizard probes the FULL
// project-identity resolution (env first, then cwd-walk) and supplies the
// projectCard plan input ONLY when nothing resolves. Three runs through the
// prompt-mock harness; the final `false` declines the confirm so nothing is
// written and the Plan note carries the rendered preview.
// ---------------------------------------------------------------------------

const CARD_PLAN_PROMPTS = [
  'api',
  'claude-haiku-4-5-20251001',
  'sk-ant-SEAMTEST0000',
  'env',
  'create',
  'chat-agent-default',
  'fast_chat',
  'default',
  'none',
  'no',
  false, // FRS.B: decline pack activation
  'skip',
  false, // decline the confirm — preview only
];

describe('runChatSetupWizard — project card (FRS.A orchestrator seam)', () => {
  it('fresh cwd + no env → the plan preview contains the project card', async () => {
    const projectCwd = await mkdtemp(join(tmpdir(), 'frs-a-fresh-'));
    queue(...CARD_PLAN_PROMPTS);
    await runChatSetupWizard({ opensquidHome: home(), envPath: env(), projectCwd, projectEnv: {} });
    const planNote = state.notes.find((nn) => nn.title === 'Plan');
    expect(planNote?.msg ?? '').toContain(join('.opensquid', 'project.json'));
  });

  it('pre-existing card → suppressed, and the on-disk uuid is untouched', async () => {
    const projectCwd = await mkdtemp(join(tmpdir(), 'frs-a-card-'));
    await mkdir(join(projectCwd, '.opensquid'), { recursive: true });
    const card = '{\n  "version": 1,\n  "id": "pre",\n  "uuid": "pre-uuid"\n}\n';
    await writeFile(join(projectCwd, '.opensquid', 'project.json'), card, 'utf8');
    queue(...CARD_PLAN_PROMPTS);
    await runChatSetupWizard({ opensquidHome: home(), envPath: env(), projectCwd, projectEnv: {} });
    const planNote = state.notes.find((nn) => nn.title === 'Plan');
    expect(planNote?.msg ?? '').not.toContain('project.json');
    expect(await readFile(join(projectCwd, '.opensquid', 'project.json'), 'utf8')).toBe(card);
  });

  it('OPENSQUID_PROJECT_UUID set → suppressed (env-first, no split identity)', async () => {
    const projectCwd = await mkdtemp(join(tmpdir(), 'frs-a-env-'));
    queue(...CARD_PLAN_PROMPTS);
    await runChatSetupWizard({
      opensquidHome: home(),
      envPath: env(),
      projectCwd,
      projectEnv: { OPENSQUID_PROJECT_UUID: 'env-uuid' },
    });
    const planNote = state.notes.find((nn) => nn.title === 'Plan');
    expect(planNote?.msg ?? '').not.toContain('project.json');
  });
});

// ---------------------------------------------------------------------------
// FRS.B — pack-activation prompt → user-scope active.json (orchestrator seam)
// ---------------------------------------------------------------------------

const ACTV_BASE = [
  'api',
  'claude-haiku-4-5-20251001',
  'sk-ant-ACTV0000',
  'env',
  'create',
  'chat-agent-default',
  'fast_chat',
  'default',
  'none',
  'no',
];

describe('runChatSetupWizard — pack activation (FRS.B)', () => {
  it('consented → plan preview contains active.json', async () => {
    queue(...ACTV_BASE, true, 'skip', false); // activate; decline plan = preview only
    await runChatSetupWizard({
      opensquidHome: home(),
      envPath: env(),
      projectEnv: { OPENSQUID_PROJECT_UUID: 'fixture-uuid' },
    });
    const planNote = state.notes.find((nn) => nn.title === 'Plan');
    expect(planNote?.msg ?? '').toContain('active.json');
  });

  it('declined → no active.json action (the explicit ungated choice)', async () => {
    queue(...ACTV_BASE, false, 'skip', false);
    await runChatSetupWizard({
      opensquidHome: home(),
      envPath: env(),
      projectEnv: { OPENSQUID_PROJECT_UUID: 'fixture-uuid' },
    });
    const planNote = state.notes.find((nn) => nn.title === 'Plan');
    expect(planNote?.msg ?? '').not.toContain('active.json');
  });

  it('consented + plan CONFIRMED → active.json on disk, merged + deduped, prior file replaced with backup', async () => {
    await writeFile(
      join(home(), 'active.json'),
      JSON.stringify({ packs: ['existing-pack'] }),
      'utf8',
    );
    queue(...ACTV_BASE, true, 'skip', true); // activate; CONFIRM — executed
    const result = await runChatSetupWizard({
      opensquidHome: home(),
      envPath: env(),
      projectEnv: { OPENSQUID_PROJECT_UUID: 'fixture-uuid' },
    });
    expect(result.outcome).toBe('completed');
    const onDisk = JSON.parse(await readFile(join(home(), 'active.json'), 'utf8')) as {
      packs: string[];
    };
    expect(onDisk.packs).toContain('existing-pack');
    expect(onDisk.packs).toContain('chat-agent-default');
    expect(new Set(onDisk.packs).size).toBe(onDisk.packs.length);
    expect(result.written).toContain(join(home(), 'active.json'));
  });
});
