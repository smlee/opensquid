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
const PROJECT_UUID = 'l3-test-uuid';
const SESSION_ID = 'sess-l3-e2e';
let priorHome: string | undefined;
let priorSession: string | undefined;
let priorProjectUuid: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  priorSession = process.env.CLAUDE_SESSION_ID;
  priorProjectUuid = process.env.OPENSQUID_PROJECT_UUID;

  home = await mkdtemp(join(tmpdir(), 'opensquid-l3-'));
  process.env.OPENSQUID_HOME = home;
  process.env.CLAUDE_SESSION_ID = SESSION_ID;
  process.env.OPENSQUID_PROJECT_UUID = PROJECT_UUID;

  const leaseDir = join(home, 'projects', PROJECT_UUID);
  await mkdir(leaseDir, { recursive: true });
  await writeFile(
    join(leaseDir, 'live-session.lease'),
    JSON.stringify({
      session_id: SESSION_ID,
      pid: process.pid,
      refreshed_at: new Date().toISOString(),
    }),
    'utf8',
  );
  await mkdir(join(leaseDir, 'inbox'), { recursive: true });
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  if (priorSession === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = priorSession;
  if (priorProjectUuid === undefined) delete process.env.OPENSQUID_PROJECT_UUID;
  else process.env.OPENSQUID_PROJECT_UUID = priorProjectUuid;
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
      env: { ...process.env, OPENSQUID_HOME: home, OPENSQUID_PROJECT_UUID: PROJECT_UUID },
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
      const inboxPath = join(home, 'projects', PROJECT_UUID, 'inbox', 'telegram.jsonl');

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
      const ackedBeforeFirst = await readAcked(PROJECT_UUID);
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
      const ackedAfterFirst = await readAcked(PROJECT_UUID);
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
      const ackedAfterSecond = await readAcked(PROJECT_UUID);
      expect(ackedAfterSecond).toHaveLength(1);
    },
    20_000,
  );
});
