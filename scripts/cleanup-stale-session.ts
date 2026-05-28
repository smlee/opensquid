#!/usr/bin/env node
/**
 * Dev-only utility — NOT in `package.json` bin. One-time cleanup for the
 * specific contamination the pre-ASG.1 bug left under a user's real
 * `~/.opensquid/`: a stale `sessions/test-session/` dir + a `.current-session`
 * pointer that resolves to the literal string `'test-session'`.
 *
 * Idempotent + intentionally narrow:
 *   - Removes `<home>/sessions/test-session/` only if it exists; never touches
 *     any other session dir.
 *   - Removes `<home>/.current-session` ONLY if its content equals the literal
 *     `'test-session'`; preserves the file otherwise so a real live-session
 *     pointer is never destroyed.
 *
 * Honors `OPENSQUID_HOME` so tests / non-default installs can target their
 * own root. Prints what it did + what it preserved. Never re-creates state.
 *
 * Run:
 *   node --experimental-strip-types scripts/cleanup-stale-session.ts
 *   # or, post-build:
 *   node dist/scripts/cleanup-stale-session.js
 */

import { readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function main(): Promise<void> {
  const home = process.env.OPENSQUID_HOME ?? join(homedir(), '.opensquid');
  const target = join(home, 'sessions', 'test-session');
  const pointer = join(home, '.current-session');

  const st = await stat(target).catch(() => null);
  if (st !== null) {
    await rm(target, { recursive: true, force: true });
    process.stdout.write(`removed ${target}\n`);
  } else {
    process.stdout.write(`absent: ${target}\n`);
  }

  const raw = await readFile(pointer, 'utf8').catch(() => null);
  if (raw === null) {
    process.stdout.write(`absent: ${pointer}\n`);
    return;
  }
  if (raw.trim() === 'test-session') {
    await rm(pointer, { force: true });
    process.stdout.write(`removed ${pointer} (contained 'test-session')\n`);
  } else {
    process.stdout.write(`preserved ${pointer} (contained '${raw.trim()}')\n`);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`cleanup-stale-session failed: ${String(e)}\n`);
  process.exitCode = 1;
});
