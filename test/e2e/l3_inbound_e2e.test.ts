/**
 * T-L3-LOOP LL.6 — end-to-end smoke test for the inbound communication loop.
 *
 * Closes the loop documented in [[project-opensquid-interconnected-communication-loop]]:
 * a synthetic Telegram-style row appended to inbox/telegram.jsonl reaches the
 * agent's next prompt-submit as an additionalContext envelope, and an ack
 * row appears in acked.jsonl proving the dedup ledger is durable.
 *
 * Skip-if-no-binary: the test invokes `dist/runtime/hooks/user-prompt-submit.js`
 * via child_process.spawn; if the binary isn't built (CI without prior
 * `pnpm build`), the test is skipped per the standard System integration test
 * pattern. Local setup: run `pnpm build` once before `pnpm vitest run`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readAcked } from '../../src/runtime/chat/inbox.js';
import { startInboundWatcher } from '../../src/runtime/chat/inbound_watch.js';

const HOOK_BIN = join(process.cwd(), 'dist/runtime/hooks/user-prompt-submit.js');

let home: string;
// CAT.1c: the inbox + lease are keyed by UMBRELLA. The UPS hook resolves the
// active umbrella from cwd via channels.json (`members` prefix), so the
// fixture wires a channels.json whose member prefix matches process.cwd().
const UMBRELLA = 'l3-test-umbrella';
const SESSION_ID = 'sess-l3-e2e';
let priorHome: string | undefined;
let priorSession: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  priorSession = process.env.CLAUDE_SESSION_ID;

  home = await mkdtemp(join(tmpdir(), 'opensquid-l3-'));
  process.env.OPENSQUID_HOME = home;
  process.env.CLAUDE_SESSION_ID = SESSION_ID;

  // channels.json: claim the current cwd as a member of UMBRELLA so the hook
  // (and the watcher) route this session's inbox to the umbrella.
  await writeFile(
    join(home, 'channels.json'),
    JSON.stringify({ v: 1, umbrellas: [{ id: UMBRELLA, members: [process.cwd()] }] }),
    'utf8',
  );

  const umbrellaDir = join(home, 'umbrellas', UMBRELLA);
  await mkdir(umbrellaDir, { recursive: true });
  await writeFile(
    join(umbrellaDir, 'live-session.lease'),
    JSON.stringify({
      session_id: SESSION_ID,
      pid: process.pid,
      refreshed_at: new Date().toISOString(),
    }),
    'utf8',
  );
  await mkdir(join(umbrellaDir, 'inbox'), { recursive: true });
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  if (priorSession === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = priorSession;
  await rm(home, { recursive: true, force: true });
});

interface HookResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runHook(stdinPayload: string): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [HOOK_BIN], {
      env: { ...process.env, OPENSQUID_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({ stdout: out, stderr: err, exitCode: code ?? 0 });
    });
    child.stdin.write(stdinPayload);
    child.stdin.end();
  });
}

describe('T-L3-LOOP — inbound E2E loop closure', () => {
  it.skipIf(!existsSync(HOOK_BIN))(
    'inbound row → dispatch → UPS hook → additionalContext envelope + ack write + dedup',
    async () => {
      const inboxPath = join(home, 'umbrellas', UMBRELLA, 'inbox', 'telegram.jsonl');

      const row = {
        v: 1,
        id: 'msg-42',
        platform: 'telegram',
        channel: '-1001234567890',
        sender: 'alice',
        sender_id: 'u1',
        text: 'hello from telegram',
        received_at: '2026-05-30T12:00:00Z',
        enqueued_at: '2026-05-30T12:00:00.500Z',
        mentions_bot: false,
      };
      await appendFile(inboxPath, JSON.stringify(row) + '\n', 'utf8');

      // Start watcher; let chokidar's awaitWriteFinish window (100ms +
      // 50ms poll) settle, then stop. Generous 500ms wait for CI runners.
      const stop = await startInboundWatcher();
      await new Promise((r) => setTimeout(r, 500));
      await stop();

      // Watcher dispatched (no crash). LL.7 split: watcher fires events;
      // UPS hook owns the ack ledger. No ack written yet.
      const ackedBeforeFirst = await readAcked(UMBRELLA);
      expect(ackedBeforeFirst).toHaveLength(0);

      // First UPS fire — should inject envelope + ack the row
      const upsPayload = JSON.stringify({
        session_id: SESSION_ID,
        prompt: 'continue working on the L3 loop',
      });
      const first = await runHook(upsPayload);
      expect(first.exitCode).toBe(0);

      // Hook stdout JSON envelope carries additionalContext
      const parsedFirst = JSON.parse(first.stdout) as {
        hookSpecificOutput?: { additionalContext?: string };
      };
      const ac1 = parsedFirst.hookSpecificOutput?.additionalContext ?? '';
      expect(ac1).toContain('📨 Inbound messages (1)');
      expect(ac1).toContain('alice (telegram): hello from telegram');

      // Ack ledger now has exactly one matching row
      const ackedAfterFirst = await readAcked(UMBRELLA);
      expect(ackedAfterFirst).toHaveLength(1);
      expect(ackedAfterFirst[0]).toMatchObject({
        v: 1,
        message_id: 'msg-42',
        platform: 'telegram',
        injected_at_sessionId: SESSION_ID,
      });

      // Second UPS fire — dedup must hold (no re-inject + no duplicate ack)
      const second = await runHook(upsPayload);
      expect(second.exitCode).toBe(0);
      const parsedSecond = (
        second.stdout.length > 0 ? (JSON.parse(second.stdout) as Record<string, unknown>) : {}
      ) as { hookSpecificOutput?: { additionalContext?: string } };
      const ac2 = parsedSecond.hookSpecificOutput?.additionalContext ?? '';
      expect(ac2).not.toContain('📨 Inbound messages');
      const ackedAfterSecond = await readAcked(UMBRELLA);
      expect(ackedAfterSecond).toHaveLength(1);
    },
    20_000,
  );
});
