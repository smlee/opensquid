/**
 * agent_bridge — runAgentTurnSubscription unit tests (WAB-SUB.1, 0.5.105).
 *
 * Fake-CLI approach (mirrors src/secrets/backends/op.test.ts):
 *   Write a tiny #!node script to a per-test temp dir. The script
 *   reads stdin to EOF, then prints / exits based on env vars
 *   (FAKE_OUTPUT, FAKE_EXIT, FAKE_STDERR, FAKE_SLEEP_MS, FAKE_ECHO_STDIN).
 *   We point `opts.cli` at the temp path. The fake-CLI lets us verify
 *   spawn happy path, exit codes, stderr propagation, and timeout
 *   without depending on the real `claude` binary or network.
 *
 * Tests cover:
 *   1. happy path — stdout flows through to replyText, entries shaped
 *   2. stdin contains the inbound text + history snippet
 *   3. MCP config flag wiring (--mcp-config <path>)
 *   4. resume session wiring (--resume <id>)
 *   5. system prompt wiring (--append-system-prompt <prompt>)
 *   6. non-zero exit → throws with stderr in error message
 *   7. timeout → throws after timeoutMs
 *   8. spawn failure (nonexistent binary) → throws with spawn error
 *   9. buildPromptBody pure function — empty history, mixed entries
 *   10. structural injection via opts.client (no spawn at all)
 *   11. LIVE (gated by WAB_SUB_LIVE=1 + claude on PATH) — real spawn
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SUBSCRIPTION_TIMEOUT_MS,
  SUBSCRIPTION_HISTORY_SNIPPET_LEN,
  buildPromptBody,
  defaultClaudeCliClient,
  runAgentTurnSubscription,
  type ClaudeCliClient,
  type ClaudeCliRunRequest,
} from './agent_loop_subscription.js';
import type { ChatHistoryEntry, SessionState } from './types.js';

// ---------------------------------------------------------------------------
// Helpers — state + fake-CLI emitter
// ---------------------------------------------------------------------------

function freshState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    key: { platform: 'telegram', chatId: '8075471258' },
    history: [],
    lastActivityMs: 0,
    projectUuid: '0742f358-c0fd-4690-ae9d-da8f4102ab4a',
    packId: 'default',
    modelAlias: 'fast_chat',
    turnInFlight: false,
    ...overrides,
  };
}

let tmpRoot: string;
const priorEnv: Record<string, string | undefined> = {};
const TRACKED_ENV_KEYS = [
  'FAKE_OUTPUT',
  'FAKE_EXIT',
  'FAKE_STDERR',
  'FAKE_SLEEP_MS',
  'FAKE_ECHO_STDIN',
  'FAKE_ECHO_ARGS',
];

beforeEach(async () => {
  for (const k of TRACKED_ENV_KEYS) {
    priorEnv[k] = process.env[k];
    delete process.env[k];
  }
  tmpRoot = await mkdtemp(join(tmpdir(), 'opensquid-sub-test-'));
});

afterEach(async () => {
  for (const k of TRACKED_ENV_KEYS) {
    if (priorEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = priorEnv[k];
    }
  }
  await rm(tmpRoot, { recursive: true, force: true });
});

/**
 * Write a #!node script that:
 *   - reads stdin to EOF
 *   - if FAKE_ECHO_STDIN=1, prints the stdin contents AFTER FAKE_OUTPUT
 *   - if FAKE_ECHO_ARGS=1, prints argv JSON AFTER FAKE_OUTPUT
 *   - emits FAKE_STDERR on stderr if set
 *   - sleeps FAKE_SLEEP_MS if set, then exits FAKE_EXIT
 */
async function writeFakeCli(): Promise<string> {
  const script = `#!${process.execPath}
let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdinBuf += d; });
process.stdin.on('end', () => {
  const output = process.env.FAKE_OUTPUT ?? '';
  const exitCode = Number(process.env.FAKE_EXIT ?? '0');
  const sleepMs = Number(process.env.FAKE_SLEEP_MS ?? '0');
  const stderrOutput = process.env.FAKE_STDERR ?? '';
  const echoStdin = process.env.FAKE_ECHO_STDIN === '1';
  const echoArgs = process.env.FAKE_ECHO_ARGS === '1';
  const done = () => {
    if (output) process.stdout.write(output);
    if (echoStdin) process.stdout.write('\\n<<STDIN>>\\n' + stdinBuf + '\\n<<END>>');
    if (echoArgs) process.stdout.write('\\n<<ARGV>>' + JSON.stringify(process.argv.slice(2)) + '<<END>>');
    if (stderrOutput) process.stderr.write(stderrOutput);
    process.exit(exitCode);
  };
  if (sleepMs > 0) setTimeout(done, sleepMs);
  else done();
});
`;
  const path = join(tmpRoot, `fake-claude-${Math.random().toString(36).slice(2, 8)}`);
  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
  return path;
}

const FIXED_TS = '2026-05-21T19:00:00.000Z';
const nowFixed = (): string => FIXED_TS;

// ---------------------------------------------------------------------------
// Tunable sanity
// ---------------------------------------------------------------------------

describe('agent_loop_subscription tunables', () => {
  it('exports locked WAB-SUB.1 constants', () => {
    expect(DEFAULT_SUBSCRIPTION_TIMEOUT_MS).toBe(120_000);
    expect(SUBSCRIPTION_HISTORY_SNIPPET_LEN).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Pure buildPromptBody
// ---------------------------------------------------------------------------

describe('buildPromptBody', () => {
  it('returns inbound text alone when history empty', () => {
    expect(buildPromptBody([], 'hi there', 6)).toBe('hi there');
  });

  it('serializes last N entries with role prefixes + history framing', () => {
    const history: ChatHistoryEntry[] = [
      { role: 'user', content: [{ type: 'text', text: 'old-1' }], timestamp: FIXED_TS },
      { role: 'assistant', content: [{ type: 'text', text: 'reply-1' }], timestamp: FIXED_TS },
      { role: 'user', content: [{ type: 'text', text: 'old-2' }], timestamp: FIXED_TS },
    ];
    const out = buildPromptBody(history, 'now-msg', 6);
    expect(out).toContain('<conversation_history>');
    expect(out).toContain('User: old-1');
    expect(out).toContain('Assistant: reply-1');
    expect(out).toContain('User: old-2');
    expect(out).toContain('</conversation_history>');
    expect(out).toContain('now-msg');
    // Inbound text is last.
    expect(out.endsWith('now-msg')).toBe(true);
  });

  it('respects snippetLen — only last N entries included', () => {
    const history: ChatHistoryEntry[] = Array.from({ length: 10 }, (_, i) => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text: `msg-${i}` }],
      timestamp: FIXED_TS,
    }));
    const out = buildPromptBody(history, 'now', 3);
    expect(out).not.toContain('msg-0');
    expect(out).not.toContain('msg-6');
    expect(out).toContain('msg-7');
    expect(out).toContain('msg-8');
    expect(out).toContain('msg-9');
  });

  it('skips entries without text blocks (tool_use / tool_result only)', () => {
    const history: ChatHistoryEntry[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'echo', input: {} }],
        timestamp: FIXED_TS,
      },
      { role: 'user', content: [{ type: 'text', text: 'visible' }], timestamp: FIXED_TS },
    ];
    const out = buildPromptBody(history, 'now', 6);
    expect(out).toContain('visible');
    expect(out).not.toContain('tu_1');
    expect(out).not.toContain('echo');
  });
});

// ---------------------------------------------------------------------------
// runAgentTurnSubscription — structural client injection (no spawn)
// ---------------------------------------------------------------------------

describe('runAgentTurnSubscription — structural client injection', () => {
  it('returns replyText + entries built from the client stdout', async () => {
    const captured: ClaudeCliRunRequest[] = [];
    const client: ClaudeCliClient = {
      run: (req) => {
        captured.push(req);
        return Promise.resolve('  hello back  \n');
      },
    };

    const { replyText, assistantEntries } = await runAgentTurnSubscription(freshState(), 'hi', {
      cli: 'claude',
      args: ['--print', '--model', 'm'],
      systemPrompt: 'be terse',
      client,
      nowIso: nowFixed,
    });

    expect(replyText).toBe('hello back');
    expect(assistantEntries).toHaveLength(2);
    expect(assistantEntries[0]?.role).toBe('user');
    expect(assistantEntries[0]?.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(assistantEntries[0]?.timestamp).toBe(FIXED_TS);
    expect(assistantEntries[1]?.role).toBe('assistant');
    expect(assistantEntries[1]?.content).toEqual([{ type: 'text', text: 'hello back' }]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.cli).toBe('claude');
    expect(captured[0]?.timeoutMs).toBe(DEFAULT_SUBSCRIPTION_TIMEOUT_MS);
  });

  it('passes inbound text through stdin (no history)', async () => {
    let receivedStdin = '';
    const client: ClaudeCliClient = {
      run: (req) => {
        receivedStdin = req.stdin;
        return Promise.resolve('ok');
      },
    };
    await runAgentTurnSubscription(freshState(), 'just this', {
      cli: 'claude',
      args: ['--print'],
      systemPrompt: 's',
      client,
    });
    expect(receivedStdin).toBe('just this');
  });

  it('bundles last 6 history entries into stdin', async () => {
    let receivedStdin = '';
    const client: ClaudeCliClient = {
      run: (req) => {
        receivedStdin = req.stdin;
        return Promise.resolve('ok');
      },
    };
    const state = freshState({
      history: [
        { role: 'user', content: [{ type: 'text', text: 'h-old' }], timestamp: FIXED_TS },
        { role: 'assistant', content: [{ type: 'text', text: 'h-reply' }], timestamp: FIXED_TS },
      ],
    });
    await runAgentTurnSubscription(state, 'inbound', {
      cli: 'claude',
      args: ['--print'],
      systemPrompt: 's',
      client,
    });
    expect(receivedStdin).toContain('h-old');
    expect(receivedStdin).toContain('h-reply');
    expect(receivedStdin).toContain('inbound');
    expect(receivedStdin).toContain('<conversation_history>');
  });

  it('wires --append-system-prompt + base args (no MCP/resume by default)', async () => {
    let capturedArgs: string[] = [];
    const client: ClaudeCliClient = {
      run: (req) => {
        capturedArgs = req.args;
        return Promise.resolve('ok');
      },
    };
    await runAgentTurnSubscription(freshState(), 'hi', {
      cli: 'claude',
      args: ['--print', '--model', 'fast'],
      systemPrompt: 'be brief',
      client,
    });
    expect(capturedArgs).toEqual([
      '--print',
      '--model',
      'fast',
      '--append-system-prompt',
      'be brief',
    ]);
  });

  it('wires --mcp-config when mcpConfigPath set', async () => {
    let capturedArgs: string[] = [];
    const client: ClaudeCliClient = {
      run: (req) => {
        capturedArgs = req.args;
        return Promise.resolve('ok');
      },
    };
    await runAgentTurnSubscription(freshState(), 'hi', {
      cli: 'claude',
      args: ['--print'],
      systemPrompt: 's',
      mcpConfigPath: '/tmp/mcp.json',
      client,
    });
    expect(capturedArgs).toContain('--mcp-config');
    expect(capturedArgs[capturedArgs.indexOf('--mcp-config') + 1]).toBe('/tmp/mcp.json');
  });

  it('wires --resume when resumeSessionId set', async () => {
    let capturedArgs: string[] = [];
    const client: ClaudeCliClient = {
      run: (req) => {
        capturedArgs = req.args;
        return Promise.resolve('ok');
      },
    };
    await runAgentTurnSubscription(freshState(), 'hi', {
      cli: 'claude',
      args: ['--print'],
      systemPrompt: 's',
      resumeSessionId: 'abc-123',
      client,
    });
    expect(capturedArgs).toContain('--resume');
    expect(capturedArgs[capturedArgs.indexOf('--resume') + 1]).toBe('abc-123');
  });

  it('forwards custom timeoutMs to client.run', async () => {
    let capturedTimeout = 0;
    const client: ClaudeCliClient = {
      run: (req) => {
        capturedTimeout = req.timeoutMs;
        return Promise.resolve('ok');
      },
    };
    await runAgentTurnSubscription(freshState(), 'hi', {
      cli: 'claude',
      args: ['--print'],
      systemPrompt: 's',
      timeoutMs: 5000,
      client,
    });
    expect(capturedTimeout).toBe(5000);
  });

  it('does not mutate caller state.history', async () => {
    const client: ClaudeCliClient = {
      run: () => Promise.resolve('ok'),
    };
    const state = freshState({
      history: [{ role: 'user', content: [{ type: 'text', text: 'x' }], timestamp: FIXED_TS }],
    });
    const snapshot = JSON.stringify(state.history);
    await runAgentTurnSubscription(state, 'y', {
      cli: 'claude',
      args: [],
      systemPrompt: 's',
      client,
    });
    expect(JSON.stringify(state.history)).toBe(snapshot);
  });

  it('propagates client errors (non-zero exit, spawn fail, timeout)', async () => {
    const client: ClaudeCliClient = {
      run: () => Promise.reject(new Error('subscription cli exit 1: boom')),
    };
    await expect(
      runAgentTurnSubscription(freshState(), 'hi', {
        cli: 'claude',
        args: [],
        systemPrompt: 's',
        client,
      }),
    ).rejects.toThrow(/subscription cli exit 1: boom/);
  });
});

// ---------------------------------------------------------------------------
// defaultClaudeCliClient — real spawn against fake-CLI
// ---------------------------------------------------------------------------

describe('defaultClaudeCliClient — spawn lifecycle (fake CLI)', () => {
  it('returns stdout for exit 0', async () => {
    process.env.FAKE_OUTPUT = 'hello world';
    const cli = await writeFakeCli();
    const out = await defaultClaudeCliClient.run({
      cli,
      args: [],
      stdin: 'ignored',
      timeoutMs: 10_000,
    });
    expect(out).toBe('hello world');
  });

  it('echoes stdin back when configured (verifies stdin pipe works)', async () => {
    process.env.FAKE_OUTPUT = 'OK';
    process.env.FAKE_ECHO_STDIN = '1';
    const cli = await writeFakeCli();
    const out = await defaultClaudeCliClient.run({
      cli,
      args: [],
      stdin: 'my-prompt-body',
      timeoutMs: 10_000,
    });
    expect(out).toContain('OK');
    expect(out).toContain('<<STDIN>>');
    expect(out).toContain('my-prompt-body');
  });

  it('forwards argv exactly (verifies args wiring through spawn)', async () => {
    process.env.FAKE_OUTPUT = '';
    process.env.FAKE_ECHO_ARGS = '1';
    const cli = await writeFakeCli();
    const out = await defaultClaudeCliClient.run({
      cli,
      args: ['--print', '--model', 'fast', '--mcp-config', '/tmp/x.json'],
      stdin: '',
      timeoutMs: 10_000,
    });
    expect(out).toContain('<<ARGV>>');
    expect(out).toContain('"--print"');
    expect(out).toContain('"--model"');
    expect(out).toContain('"fast"');
    expect(out).toContain('"--mcp-config"');
    expect(out).toContain('"/tmp/x.json"');
  });

  it('throws with stderr included on non-zero exit', async () => {
    process.env.FAKE_OUTPUT = '';
    process.env.FAKE_EXIT = '2';
    process.env.FAKE_STDERR = 'something broke';
    const cli = await writeFakeCli();
    await expect(
      defaultClaudeCliClient.run({ cli, args: [], stdin: '', timeoutMs: 10_000 }),
    ).rejects.toThrow(/exit 2.*something broke/);
  });

  it('throws on spawn failure (nonexistent binary)', async () => {
    await expect(
      defaultClaudeCliClient.run({
        cli: join(tmpRoot, 'does-not-exist'),
        args: [],
        stdin: '',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/spawn failed/);
  });

  it('throws on timeout (SIGTERMs the child)', async () => {
    process.env.FAKE_OUTPUT = 'late';
    process.env.FAKE_SLEEP_MS = '5000';
    const cli = await writeFakeCli();
    const start = Date.now();
    await expect(
      defaultClaudeCliClient.run({ cli, args: [], stdin: '', timeoutMs: 200 }),
    ).rejects.toThrow(/timeout after 200ms/);
    const elapsed = Date.now() - start;
    // Should fire near the timeout, well before the 5s sleep would complete.
    expect(elapsed).toBeLessThan(2000);
  }, 8000);
});

// ---------------------------------------------------------------------------
// runAgentTurnSubscription — end-to-end through defaultClaudeCliClient
// ---------------------------------------------------------------------------

describe('runAgentTurnSubscription — end-to-end (real spawn, fake CLI)', () => {
  it('completes a full turn through the real spawn path', async () => {
    process.env.FAKE_OUTPUT = 'spawned reply';
    const cli = await writeFakeCli();
    const { replyText, assistantEntries } = await runAgentTurnSubscription(freshState(), 'hello', {
      cli,
      args: ['--print'],
      systemPrompt: 'be brief',
      timeoutMs: 10_000,
      nowIso: nowFixed,
    });
    expect(replyText).toBe('spawned reply');
    expect(assistantEntries).toHaveLength(2);
    expect(assistantEntries[1]?.content[0]).toMatchObject({
      type: 'text',
      text: 'spawned reply',
    });
  });
});

// ---------------------------------------------------------------------------
// Live (gated)
//
// Skipped unless WAB_SUB_LIVE=1 + `claude` on PATH. Spawns the real
// binary. Requires subscription auth in the user's Claude Code state.
// ---------------------------------------------------------------------------

const LIVE_ENABLED = process.env.WAB_SUB_LIVE === '1';

describe.skipIf(!LIVE_ENABLED)('runAgentTurnSubscription — live spawn', () => {
  it('completes a real `claude --print` turn under 90s', async () => {
    const { replyText } = await runAgentTurnSubscription(freshState(), 'say "pong"', {
      cli: 'claude',
      args: ['--print'],
      systemPrompt: 'Reply with one short word.',
      timeoutMs: 90_000,
    });
    expect(replyText.length).toBeGreaterThan(0);
  }, 100_000);
});
