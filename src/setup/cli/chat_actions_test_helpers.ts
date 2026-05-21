/* eslint-disable @typescript-eslint/require-await */
/**
 * Shared @clack/prompts mock harness + tmpdir scaffolding for
 * chat_actions.test.ts + chat_actions_wab_sub.test.ts.
 *
 * Extracted in WAB-SUB.3 to keep both test files under the 450-LOC cap.
 * Each test file imports the mock setup + state object + helpers from
 * this module. Critical: this module installs `vi.mock('@clack/prompts')`
 * as a top-level side effect; importing it triggers the mock. Test files
 * must import this BEFORE the wizard module to ensure the mock wins.
 *
 * Why a `.ts` (not `.test.ts`): vitest treats `.test.ts` as a test file
 * and would try to run zero-test modules. This is shared infra, not a
 * spec.
 */

import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @clack/prompts — every interactive function pulls from a shared
// queue. `pushPrompts` lets each test prime the queue; the wizard then
// "asks questions" by calling the mocked function, which returns the head
// of the queue.
// ---------------------------------------------------------------------------

export interface PromptState {
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

export const promptState: PromptState = {
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
  promptState.promptCount += 1;
  if (
    promptState.injectCancelOnPrompt !== null &&
    promptState.promptCount === promptState.injectCancelOnPrompt
  ) {
    return CANCEL_SYMBOL;
  }
  if (promptState.queue.length === 0) {
    throw new Error('test setup error: prompt queue ran dry');
  }
  return promptState.queue.shift();
}

vi.mock('@clack/prompts', () => ({
  intro: (msg?: string): void => {
    if (msg !== undefined) promptState.introMessages.push(msg);
  },
  outro: (msg?: string): void => {
    if (msg !== undefined) promptState.outroMessages.push(msg);
  },
  cancel: (msg?: string): void => {
    if (msg !== undefined) promptState.cancelMessages.push(msg);
  },
  note: (msg?: string, title?: string): void => {
    const entry: { msg?: string; title?: string } = {};
    if (msg !== undefined) entry.msg = msg;
    if (title !== undefined) entry.title = title;
    promptState.notes.push(entry);
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

// ---------------------------------------------------------------------------
// Per-test scaffolding — call setupChatWizardTest() at the top of each
// describe(); the returned getters expose the per-test tmpdirs.
// ---------------------------------------------------------------------------

export interface WizardTestContext {
  homeDir: () => string;
  envPath: () => string;
}

export function setupChatWizardTest(): WizardTestContext {
  let homeDir = '';
  let envHome = '';
  let envPath = '';
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
    promptState.queue = [];
    promptState.cancelMessages = [];
    promptState.outroMessages = [];
    promptState.introMessages = [];
    promptState.notes = [];
    promptState.injectCancelOnPrompt = null;
    promptState.promptCount = 0;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    if (priorNoBilled === undefined) delete process.env.OPENSQUID_NO_BILLED_CALLS;
    else process.env.OPENSQUID_NO_BILLED_CALLS = priorNoBilled;
  });

  return {
    homeDir: () => homeDir,
    envPath: () => envPath,
  };
}

export function queue(...values: unknown[]): void {
  promptState.queue.push(...values);
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
