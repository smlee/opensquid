/* eslint-disable @typescript-eslint/require-await */
/**
 * Tests for WIZ.4 — channel-test step in the chat-setup wizard.
 *
 * Four fixtures per WIZ.4 acceptance criteria:
 *   1. User declines the confirm → no RPC call, no side effects.
 *   2. User accepts + daemon reachable → success message contains
 *      message_id, recorded note is green.
 *   3. User accepts + daemon NOT running → "start chat-daemon" hint,
 *      no RPC call.
 *   4. User accepts + bot token invalid → "fix OPENSQUID_TELEGRAM_BOT_TOKEN"
 *      hint, RPC call happened and threw with an Unauthorized error.
 *
 * Strategy:
 *   - Mirrors WIZ.3's @clack/prompts queue-driven mock.
 *   - Inject the `send` + `loadRouting` deps via the function's DI seam
 *     so tests never dial a real socket nor read ~/.opensquid/. (Avoids
 *     `vi.mock` ceremony and keeps test isolation explicit.)
 *   - Each test runs against a tmpdir cwd seeded with a project card so
 *     the uuid-resolution chain is exercised end-to-end.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatDaemonState } from './chat_state.js';

// ---------------------------------------------------------------------------
// Mock @clack/prompts — same queue-driven shape as chat_actions.test.ts.
// ---------------------------------------------------------------------------

interface PromptState {
  queue: unknown[];
  notes: { msg?: string; title?: string }[];
  /** When set, the next prompt returns the cancel symbol. */
  injectCancelOnPrompt: number | null;
  promptCount: number;
  /** Spinner stop messages (so tests can assert on success / failure text). */
  spinnerStops: string[];
}

const state: PromptState = {
  queue: [],
  notes: [],
  injectCancelOnPrompt: null,
  promptCount: 0,
  spinnerStops: [],
};

const CANCEL_SYMBOL = Symbol.for('opensquid-wiz4-test-cancel');

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
  note: (msg?: string, title?: string): void => {
    const entry: { msg?: string; title?: string } = {};
    if (msg !== undefined) entry.msg = msg;
    if (title !== undefined) entry.title = title;
    state.notes.push(entry);
  },
  confirm: async (): Promise<unknown> => consume(),
  spinner: (): { start: () => void; stop: (msg?: string) => void; message: () => void } => ({
    start: () => undefined,
    stop: (msg?: string) => {
      if (msg !== undefined) state.spinnerStops.push(msg);
    },
    message: () => undefined,
  }),
  isCancel: (v: unknown): boolean => v === CANCEL_SYMBOL,
}));

// Import AFTER vi.mock so the module pulls in the mocked clack surface.
const { runChannelTestStep, DaemonUnreachableError, RoutingMissingError } =
  await import('./chat_actions_test_step.js');
type SendTestParams = Parameters<NonNullable<Parameters<typeof runChannelTestStep>[0]['send']>>[0];
type SendTestResult = Awaited<
  ReturnType<NonNullable<Parameters<typeof runChannelTestStep>[0]['send']>>
>;

// ---------------------------------------------------------------------------
// Per-test fixtures
// ---------------------------------------------------------------------------

let cwd: string;
let priorNoBilled: string | undefined;
let priorProjectUuid: string | undefined;

const TEST_UUID = '11111111-2222-3333-4444-555555555555';
const DEFAULT_ROUTING = {
  telegram: { report_channel: 'telegram:8075471258', report_topic_id: 42 },
};

let sendCallCount = 0;
let sendImpl: (p: SendTestParams) => Promise<SendTestResult> = async () => ({
  ok: true,
  platform: 'telegram',
  message_id: 'TEST-MID-DEFAULT',
  delivered_at: '2026-05-21T00:00:00.000Z',
});
const recordedSendParams: SendTestParams[] = [];
function fakeSend(p: SendTestParams): Promise<SendTestResult> {
  sendCallCount += 1;
  recordedSendParams.push(p);
  return sendImpl(p);
}

let routingImpl: (
  uuid: string,
) => Promise<typeof DEFAULT_ROUTING | null | Record<string, never>> = async () => DEFAULT_ROUTING;

beforeEach(async () => {
  priorNoBilled = process.env.OPENSQUID_NO_BILLED_CALLS;
  priorProjectUuid = process.env.OPENSQUID_PROJECT_UUID;
  delete process.env.OPENSQUID_NO_BILLED_CALLS;
  delete process.env.OPENSQUID_PROJECT_UUID;
  cwd = await mkdtemp(join(tmpdir(), 'opensquid-wiz4-cwd-'));
  // Seed a project card so the uuid-resolution chain succeeds.
  await mkdir(join(cwd, '.opensquid'), { recursive: true });
  await writeFile(
    join(cwd, '.opensquid', 'project.json'),
    JSON.stringify({ version: 1, id: 'wiz4-test', uuid: TEST_UUID }),
    'utf8',
  );
  state.queue = [];
  state.notes = [];
  state.spinnerStops = [];
  state.injectCancelOnPrompt = null;
  state.promptCount = 0;
  sendCallCount = 0;
  recordedSendParams.length = 0;
  sendImpl = async () => ({
    ok: true,
    platform: 'telegram',
    message_id: 'TEST-MID-DEFAULT',
    delivered_at: '2026-05-21T00:00:00.000Z',
  });
  routingImpl = async () => DEFAULT_ROUTING;
});

afterEach(() => {
  if (priorNoBilled === undefined) delete process.env.OPENSQUID_NO_BILLED_CALLS;
  else process.env.OPENSQUID_NO_BILLED_CALLS = priorNoBilled;
  if (priorProjectUuid === undefined) delete process.env.OPENSQUID_PROJECT_UUID;
  else process.env.OPENSQUID_PROJECT_UUID = priorProjectUuid;
});

const daemonRunning: ChatDaemonState = {
  running: true,
  pidPath: '/tmp/wiz4-fake.pid',
  pid: 999999,
  mcpReachable: true,
};
const daemonStopped: ChatDaemonState = {
  running: false,
  pidPath: '/tmp/wiz4-fake.pid',
  mcpReachable: false,
};

function depsBase(): Parameters<typeof runChannelTestStep>[0] {
  return {
    daemonState: daemonRunning,
    cwd,
    send: fakeSend,
    loadRouting: routingImpl,
  };
}

// ---------------------------------------------------------------------------
// Fixture 1 — User declines the confirm → no RPC call, no side effects.
// ---------------------------------------------------------------------------

describe('runChannelTestStep — user declines', () => {
  it('skips the RPC call when the user picks no (default)', async () => {
    state.queue.push(false); // confirm → no
    await runChannelTestStep(depsBase());
    expect(sendCallCount).toBe(0);
    const skipNote = state.notes.find((n) => n.title === 'Test');
    expect(skipNote?.msg ?? '').toMatch(/skipped|saved without/i);
  });

  it('skips the offer entirely when OPENSQUID_NO_BILLED_CALLS=1', async () => {
    process.env.OPENSQUID_NO_BILLED_CALLS = '1';
    // No prompt should be consumed — queue intentionally empty.
    await runChannelTestStep(depsBase());
    expect(state.promptCount).toBe(0);
    expect(sendCallCount).toBe(0);
    const skipNote = state.notes.find((n) => n.title === 'Test');
    expect(skipNote?.msg ?? '').toContain('OPENSQUID_NO_BILLED_CALLS');
  });
});

// ---------------------------------------------------------------------------
// Fixture 2 — User accepts + daemon reachable → success + message_id.
// ---------------------------------------------------------------------------

describe('runChannelTestStep — daemon reachable', () => {
  it('sends the message and prints the message_id', async () => {
    state.queue.push(true);
    sendImpl = async () => ({
      ok: true,
      platform: 'telegram',
      message_id: 'WIZ4-MID-12345',
      delivered_at: '2026-05-21T00:00:00.000Z',
    });
    await runChannelTestStep(depsBase());
    expect(sendCallCount).toBe(1);
    const stops = state.spinnerStops.join(' | ');
    expect(stops).toContain('WIZ4-MID-12345');
    expect(stops).toMatch(/Check your Telegram chat/i);
  });

  it('resolves project:telegram to the routing report_channel + threads topic id', async () => {
    state.queue.push(true);
    await runChannelTestStep(depsBase());
    expect(sendCallCount).toBe(1);
    const captured = recordedSendParams[0];
    expect(captured?.channel).toBe('telegram:8075471258');
    expect(captured?.threadId).toBe('42');
    expect(captured?.projectUuid).toBe(TEST_UUID);
  });
});

// ---------------------------------------------------------------------------
// Fixture 3 — User accepts + daemon NOT running → start-daemon hint.
// ---------------------------------------------------------------------------

describe('runChannelTestStep — daemon stopped', () => {
  it('prints the "start chat-daemon first" hint without dialing', async () => {
    state.queue.push(true);
    const deps = { ...depsBase(), daemonState: daemonStopped };
    await runChannelTestStep(deps);
    expect(sendCallCount).toBe(0);
    const testNote = state.notes.find((n) => n.title === 'Test');
    expect(testNote?.msg ?? '').toMatch(/chat-daemon start/i);
    expect(testNote?.msg ?? '').toContain(daemonStopped.pidPath);
  });
});

// ---------------------------------------------------------------------------
// Fixture 4 — User accepts + bot token invalid → recovery hint cites
// OPENSQUID_TELEGRAM_BOT_TOKEN. Simulate by having the fake send throw
// with a Telegram-style 401 Unauthorized message — same shape grammy
// → gateway → daemon → JSON-RPC error would surface in production.
// ---------------------------------------------------------------------------

describe('runChannelTestStep — bot token invalid', () => {
  it('prints the OPENSQUID_TELEGRAM_BOT_TOKEN recovery hint on 401', async () => {
    state.queue.push(true);
    sendImpl = async () => {
      throw new Error(
        'chat-daemon RPC error 500: Telegram API: 401 Unauthorized — bot token is invalid',
      );
    };
    await runChannelTestStep(depsBase());
    expect(sendCallCount).toBe(1);
    expect(state.spinnerStops.join(' | ')).toMatch(/Test failed/);
    const hintNote = state.notes.find((n) => n.title === 'Test');
    expect(hintNote?.msg ?? '').toContain('OPENSQUID_TELEGRAM_BOT_TOKEN');
    expect(hintNote?.msg ?? '').toMatch(/~\/\.opensquid\/\.env/);
    expect(hintNote?.msg ?? '').toMatch(/BotFather/);
  });
});

// ---------------------------------------------------------------------------
// Bonus coverage — distinct hint mentioning `chat-daemon start` for
// DaemonUnreachableError; RoutingMissingError takes a different branch;
// no-project-uuid takes yet another. Together this nails the error
// taxonomy from the WIZ.4 spec's "distinguish error types" requirement.
// ---------------------------------------------------------------------------

describe('runChannelTestStep — additional error classifications', () => {
  it('routes DaemonUnreachableError to the start-daemon hint', async () => {
    state.queue.push(true);
    sendImpl = async () => {
      throw new DaemonUnreachableError('ECONNREFUSED: socket gone');
    };
    await runChannelTestStep(depsBase());
    expect(sendCallCount).toBe(1);
    const hintNote = state.notes.find((n) => n.title === 'Test');
    expect(hintNote?.msg ?? '').toMatch(/chat-daemon start/);
  });

  it('routes RoutingMissingError to the chat_set_project_channel hint', async () => {
    state.queue.push(true);
    routingImpl = async () => ({}); // empty routing — no telegram block
    await runChannelTestStep(depsBase());
    expect(sendCallCount).toBe(0); // routing fails before dialing daemon
    expect(state.spinnerStops.join(' | ')).toMatch(/Test failed/);
    const hintNote = state.notes.find((n) => n.title === 'Test');
    expect(hintNote?.msg ?? '').toMatch(/chat_set_project_channel/);
    // Also exercises the RoutingMissingError class export contract.
    expect(new RoutingMissingError('x').name).toBe('RoutingMissingError');
  });

  it('prints no-project-uuid hint when project.json + env var both missing', async () => {
    const orphanCwd = await mkdtemp(join(tmpdir(), 'opensquid-wiz4-orphan-'));
    state.queue.push(true);
    await runChannelTestStep({ ...depsBase(), cwd: orphanCwd });
    expect(sendCallCount).toBe(0);
    const hintNote = state.notes.find((n) => n.title === 'Test');
    expect(hintNote?.msg ?? '').toMatch(/OPENSQUID_PROJECT_UUID/);
    expect(hintNote?.msg ?? '').toMatch(/project init/);
  });

  it('uses OPENSQUID_PROJECT_UUID env override when set', async () => {
    process.env.OPENSQUID_PROJECT_UUID = 'env-supplied-uuid';
    state.queue.push(true);
    // Override loadRouting to assert it received the env-supplied uuid.
    let observedUuid = '';
    routingImpl = async (uuid) => {
      observedUuid = uuid;
      return DEFAULT_ROUTING;
    };
    await runChannelTestStep(depsBase());
    expect(observedUuid).toBe('env-supplied-uuid');
  });
});
