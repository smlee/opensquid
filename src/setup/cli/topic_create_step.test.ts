/* eslint-disable @typescript-eslint/require-await */
/**
 * Tests for TPS.4 — first-run topic-create step in the chat-setup wizard.
 *
 * Coverage matches the 13 scenarios enumerated in the TPS.4 pre-research:
 *   1. Happy path: user accepts, cold start  → resolver returns created=true
 *   2. Happy path: user accepts, warm start  → resolver returns created=false
 *   3. User cancels (Esc)                    → no resolver call, skipped note
 *   4. User declines (selects "no")          → no resolver call, skipped note
 *   5. OPENSQUID_NO_BILLED_CALLS=1           → no confirm, no call, CI note
 *   6. No report_channel configured          → no confirm, no call, skipped note
 *   7. Daemon not running                    → no confirm, daemon-start hint
 *   8. createTopic throws 403                → hint mentions Manage Topics
 *   9. createTopic throws 429                → hint mentions rate-limit
 *  10. createTopic throws 400 forum-disabled → hint mentions Group Info → Topics
 *  11. Lockfile LOCKED                       → hint mentions another process
 *  12. Unknown error                         → generic hint
 *  13. Step never throws (regression check across all error paths)
 *
 * Strategy mirrors WIZ.4's sibling test (chat_actions_test_step.test.ts):
 *   - vi.mock @clack/prompts with a queue-driven confirm.
 *   - Inject `resolveOrCreateTopic` + `loadRouting` via the deps interface.
 *   - Tmpdir cwd seeded with .opensquid/project.json so the uuid walk
 *     exercises end-to-end without touching ~/.opensquid.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatDaemonState } from './chat_state.js';

// ---------------------------------------------------------------------------
// Mock @clack/prompts — queue-driven, same shape as WIZ.4 sibling test.
// ---------------------------------------------------------------------------

interface PromptState {
  queue: unknown[];
  notes: { msg?: string; title?: string }[];
  injectCancelOnPrompt: number | null;
  promptCount: number;
  spinnerStops: string[];
}

const state: PromptState = {
  queue: [],
  notes: [],
  injectCancelOnPrompt: null,
  promptCount: 0,
  spinnerStops: [],
};

const CANCEL_SYMBOL = Symbol.for('opensquid-tps4-test-cancel');

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

// Import AFTER vi.mock so the module sees the mocked clack surface.
const { runTopicCreateStep } = await import('./topic_create_step.js');
type TopicCreateDeps = Parameters<typeof runTopicCreateStep>[0];
type ResolveArgs = Parameters<NonNullable<TopicCreateDeps['resolveOrCreateTopic']>>[0];
type ResolveResult = Awaited<ReturnType<NonNullable<TopicCreateDeps['resolveOrCreateTopic']>>>;
type ProjectChatRouting = Awaited<ReturnType<NonNullable<TopicCreateDeps['loadRouting']>>>;

// ---------------------------------------------------------------------------
// Per-test fixtures
// ---------------------------------------------------------------------------

let cwd: string;
let priorNoBilled: string | undefined;
let priorProjectUuid: string | undefined;

const TEST_UUID = '11111111-2222-3333-4444-555555555555';
const DEFAULT_ROUTING: NonNullable<ProjectChatRouting> = {
  telegram: { report_channel: '-1001234567890', report_topic_id: 7 },
};

let resolveCallCount = 0;
const recordedResolveArgs: ResolveArgs[] = [];
let resolveImpl: (a: ResolveArgs) => Promise<ResolveResult> = async () => ({
  topicId: 42,
  topicName: 'loop · 11111111',
  created: true,
});
function fakeResolve(a: ResolveArgs): Promise<ResolveResult> {
  resolveCallCount += 1;
  recordedResolveArgs.push(a);
  return resolveImpl(a);
}

let routingImpl: (uuid: string) => Promise<ProjectChatRouting | null> = async () => DEFAULT_ROUTING;

beforeEach(async () => {
  priorNoBilled = process.env.OPENSQUID_NO_BILLED_CALLS;
  priorProjectUuid = process.env.OPENSQUID_PROJECT_UUID;
  delete process.env.OPENSQUID_NO_BILLED_CALLS;
  delete process.env.OPENSQUID_PROJECT_UUID;
  cwd = await mkdtemp(join(tmpdir(), 'opensquid-tps4-cwd-'));
  await mkdir(join(cwd, '.opensquid'), { recursive: true });
  await writeFile(
    join(cwd, '.opensquid', 'project.json'),
    JSON.stringify({ version: 1, id: 'tps4-test', uuid: TEST_UUID }),
    'utf8',
  );
  state.queue = [];
  state.notes = [];
  state.spinnerStops = [];
  state.injectCancelOnPrompt = null;
  state.promptCount = 0;
  resolveCallCount = 0;
  recordedResolveArgs.length = 0;
  resolveImpl = async () => ({
    topicId: 42,
    topicName: 'loop · 11111111',
    created: true,
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
  pidPath: '/tmp/tps4-fake.pid',
  pid: 999999,
  mcpReachable: true,
};
const daemonStopped: ChatDaemonState = {
  running: false,
  pidPath: '/tmp/tps4-fake.pid',
  mcpReachable: false,
};

function depsBase(): TopicCreateDeps {
  return {
    daemonState: daemonRunning,
    cwd,
    resolveOrCreateTopic: fakeResolve,
    loadRouting: routingImpl,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1 + 2 — happy paths (cold + warm).
// ---------------------------------------------------------------------------

describe('runTopicCreateStep — happy paths', () => {
  it('1: cold start — user accepts, resolver returns created=true', async () => {
    state.queue.push(true);
    resolveImpl = async () => ({
      topicId: 99,
      topicName: 'loop · abc12345',
      created: true,
    });
    await runTopicCreateStep(depsBase());
    expect(resolveCallCount).toBe(1);
    const stops = state.spinnerStops.join(' | ');
    expect(stops).toMatch(/Created topic/);
    expect(stops).toContain('thread_id=99');
    expect(stops).toContain('loop · abc12345');
  });

  it('2: warm start — user accepts, resolver returns created=false', async () => {
    state.queue.push(true);
    resolveImpl = async () => ({
      topicId: 88,
      topicName: 'loop · cafebabe',
      created: false,
    });
    await runTopicCreateStep(depsBase());
    expect(resolveCallCount).toBe(1);
    const stops = state.spinnerStops.join(' | ');
    expect(stops).toMatch(/Existing topic.*reused/);
    expect(stops).toContain('thread_id=88');
  });

  it('forwards workspaceUuid + chatId + mode=wizard to the resolver', async () => {
    state.queue.push(true);
    await runTopicCreateStep(depsBase());
    const captured = recordedResolveArgs[0];
    expect(captured?.workspaceUuid).toBe(TEST_UUID);
    expect(captured?.chatId).toBe('-1001234567890');
    expect(captured?.mode).toBe('wizard');
    expect(captured?.workspacePath).toBe(cwd);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 + 4 — user cancels / declines.
// ---------------------------------------------------------------------------

describe('runTopicCreateStep — user opts out', () => {
  it('3: Esc / Ctrl-C cancel skips the resolver', async () => {
    state.injectCancelOnPrompt = 1;
    await runTopicCreateStep(depsBase());
    expect(resolveCallCount).toBe(0);
    const skipNote = state.notes.find((n) => n.title === 'Topic');
    expect(skipNote?.msg ?? '').toMatch(/skipped/i);
  });

  it('4: user picks "no" — skips the resolver', async () => {
    state.queue.push(false);
    await runTopicCreateStep(depsBase());
    expect(resolveCallCount).toBe(0);
    const skipNote = state.notes.find((n) => n.title === 'Topic');
    expect(skipNote?.msg ?? '').toMatch(/skipped/i);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — CI flag short-circuits the prompt.
// ---------------------------------------------------------------------------

describe('runTopicCreateStep — OPENSQUID_NO_BILLED_CALLS', () => {
  it('5: skips the offer entirely when the flag is set', async () => {
    process.env.OPENSQUID_NO_BILLED_CALLS = '1';
    await runTopicCreateStep(depsBase());
    expect(state.promptCount).toBe(0);
    expect(resolveCallCount).toBe(0);
    const skipNote = state.notes.find((n) => n.title === 'Topic');
    expect(skipNote?.msg ?? '').toContain('OPENSQUID_NO_BILLED_CALLS');
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — no supergroup configured.
// ---------------------------------------------------------------------------

describe('runTopicCreateStep — no report_channel', () => {
  it('6: skips when telegram.report_channel is missing', async () => {
    routingImpl = async () => ({});
    await runTopicCreateStep(depsBase());
    expect(state.promptCount).toBe(0);
    expect(resolveCallCount).toBe(0);
    const skipNote = state.notes.find((n) => n.title === 'Topic');
    expect(skipNote?.msg ?? '').toMatch(/No Telegram supergroup/i);
  });

  it('skips when routing file is entirely missing (loadRouting returns null)', async () => {
    routingImpl = async () => null;
    await runTopicCreateStep(depsBase());
    expect(state.promptCount).toBe(0);
    expect(resolveCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — daemon not running.
// ---------------------------------------------------------------------------

describe('runTopicCreateStep — daemon stopped', () => {
  it('7: prints the start-daemon hint without prompting', async () => {
    const deps = { ...depsBase(), daemonState: daemonStopped };
    await runTopicCreateStep(deps);
    expect(state.promptCount).toBe(0);
    expect(resolveCallCount).toBe(0);
    const hintNote = state.notes.find((n) => n.title === 'Topic');
    expect(hintNote?.msg ?? '').toMatch(/chat-daemon start/i);
    expect(hintNote?.msg ?? '').toContain(daemonStopped.pidPath);
  });
});

// ---------------------------------------------------------------------------
// Scenarios 8-12 — error recovery hints.
// ---------------------------------------------------------------------------

describe('runTopicCreateStep — error recovery hints', () => {
  it('8: 403 CHAT_ADMIN_REQUIRED → "Manage Topics" hint', async () => {
    state.queue.push(true);
    resolveImpl = async () => {
      throw new Error('Telegram API: 403 Forbidden — CHAT_ADMIN_REQUIRED');
    };
    await runTopicCreateStep(depsBase());
    expect(resolveCallCount).toBe(1);
    expect(state.spinnerStops.join(' | ')).toMatch(/Topic-create failed/);
    const hintNote = state.notes.find((n) => n.title === 'Topic');
    expect(hintNote?.msg ?? '').toMatch(/Manage Topics/);
    expect(hintNote?.msg ?? '').toMatch(/Administrators/);
  });

  it('9: 429 Too Many Requests → rate-limit hint', async () => {
    state.queue.push(true);
    resolveImpl = async () => {
      throw new Error('Telegram API: 429 Too Many Requests — retry after 30');
    };
    await runTopicCreateStep(depsBase());
    const hintNote = state.notes.find((n) => n.title === 'Topic');
    expect(hintNote?.msg ?? '').toMatch(/rate-limit/);
  });

  it('10: 400 forum-disabled → "enable Topics" hint', async () => {
    state.queue.push(true);
    resolveImpl = async () => {
      throw new Error('Telegram API: 400 Bad Request — TOPICS_DISABLED in supergroup');
    };
    await runTopicCreateStep(depsBase());
    const hintNote = state.notes.find((n) => n.title === 'Topic');
    expect(hintNote?.msg ?? '').toMatch(/enable Topics/i);
    expect(hintNote?.msg ?? '').toMatch(/Group Info|Edit/);
  });

  it('11: lockfile ELOCKED → "another opensquid process" hint', async () => {
    state.queue.push(true);
    resolveImpl = async () => {
      const err = new Error('ELOCKED: Lock file is already being held') as Error & {
        code?: string;
      };
      err.code = 'ELOCKED';
      throw err;
    };
    await runTopicCreateStep(depsBase());
    const hintNote = state.notes.find((n) => n.title === 'Topic');
    expect(hintNote?.msg ?? '').toMatch(/another opensquid process/i);
  });

  it('12: unknown error → generic hint pointing at daemon log', async () => {
    state.queue.push(true);
    resolveImpl = async () => {
      throw new Error('some completely unexpected disk failure');
    };
    await runTopicCreateStep(depsBase());
    const hintNote = state.notes.find((n) => n.title === 'Topic');
    expect(hintNote?.msg ?? '').toMatch(/chat-daemon\.log/);
  });

  it('also handles persist-failed orphan-recovery message', async () => {
    state.queue.push(true);
    resolveImpl = async () => {
      throw new Error('ENOSPC: persist failed after createTopic — orphan recorded');
    };
    await runTopicCreateStep(depsBase());
    const hintNote = state.notes.find((n) => n.title === 'Topic');
    expect(hintNote?.msg ?? '').toMatch(/orphan-topics\.jsonl/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 13 — step never throws across the matrix.
// ---------------------------------------------------------------------------

describe('runTopicCreateStep — regression: never throws past the wizard', () => {
  const errorCases: { label: string; impl: () => Promise<never> }[] = [
    {
      label: '403',
      impl: async (): Promise<never> => {
        throw new Error('403 Forbidden CHAT_ADMIN_REQUIRED');
      },
    },
    {
      label: '429',
      impl: async (): Promise<never> => {
        throw new Error('429 Too Many Requests');
      },
    },
    {
      label: '400 topics disabled',
      impl: async (): Promise<never> => {
        throw new Error('400 Bad Request TOPICS_DISABLED');
      },
    },
    {
      label: 'ELOCKED',
      impl: async (): Promise<never> => {
        throw new Error('ELOCKED lock held');
      },
    },
    {
      label: 'unknown',
      impl: async (): Promise<never> => {
        throw new Error('mystery');
      },
    },
    {
      label: 'non-Error throw',
      impl: async (): Promise<never> => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'plain string thrown';
      },
    },
  ];

  for (const { label, impl } of errorCases) {
    it(`13[${label}]: returns without throwing`, async () => {
      state.queue.push(true);
      resolveImpl = impl;
      await expect(runTopicCreateStep(depsBase())).resolves.toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// UUID resolution edge — env override is honored.
// ---------------------------------------------------------------------------

describe('runTopicCreateStep — uuid resolution', () => {
  it('uses OPENSQUID_PROJECT_UUID env override when set', async () => {
    process.env.OPENSQUID_PROJECT_UUID = 'env-supplied-uuid';
    state.queue.push(true);
    let observedUuid = '';
    routingImpl = async (uuid) => {
      observedUuid = uuid;
      return DEFAULT_ROUTING;
    };
    await runTopicCreateStep(depsBase());
    expect(observedUuid).toBe('env-supplied-uuid');
    const captured = recordedResolveArgs[0];
    expect(captured?.workspaceUuid).toBe('env-supplied-uuid');
  });

  it('prints no-project-uuid hint when project.json + env var both missing', async () => {
    const orphanCwd = await mkdtemp(join(tmpdir(), 'opensquid-tps4-orphan-'));
    await runTopicCreateStep({ ...depsBase(), cwd: orphanCwd });
    expect(state.promptCount).toBe(0);
    expect(resolveCallCount).toBe(0);
    const hintNote = state.notes.find((n) => n.title === 'Topic');
    expect(hintNote?.msg ?? '').toMatch(/OPENSQUID_PROJECT_UUID/);
  });
});
