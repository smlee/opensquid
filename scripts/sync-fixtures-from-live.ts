#!/usr/bin/env node
/**
 * T-ASC ASC.6 dev tool — sync CI fixtures from the live personal-pack
 * source under `~/.opensquid/codexes/<pack-id>/skills/<name>/skill.yaml`.
 *
 * Reads `test/fixtures/sync-whitelist.json`, copies each whitelisted
 * live skill verbatim to its declared fixture path. Idempotent: re-runs
 * print 'unchanged' for pairs whose bytes already match.
 *
 * Usage:
 *   pnpm sync-fixtures                # sync every whitelisted pair
 *   pnpm sync-fixtures <skill-name>   # sync only the pair matching this live_skill_name
 *
 * Output per pair:
 *   synced:      <skill> → <fixture-path>
 *   unchanged:   <skill> (bytes already match)
 *   live-absent: <skill> (skip — live source not deployed on this machine)
 *
 * Must run from the repo root (the whitelist path is resolved against
 * process.cwd()). Convention: NOT in package.json's bin — this is a
 * developer utility, not a shipping CLI surface.
 */

import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

interface Pair {
  live_pack_id: string;
  live_skill_name: string;
  fixture_path: string;
}

interface Whitelist {
  pairs: Pair[];
}

async function main(): Promise<void> {
  const codexesRoot = join(homedir(), '.opensquid', 'codexes');
  const whitelistPath = join(process.cwd(), 'test/fixtures/sync-whitelist.json');
  const filter = process.argv[2];

  const parsed = JSON.parse(await readFile(whitelistPath, 'utf8')) as Whitelist;
  if (!Array.isArray(parsed.pairs)) {
    throw new Error('sync-whitelist.json has no `pairs` array');
  }

  let synced = 0;
  let unchanged = 0;
  let absent = 0;
  let filteredOut = 0;

  for (const pair of parsed.pairs) {
    if (filter !== undefined && pair.live_skill_name !== filter) {
      filteredOut++;
      continue;
    }
    const livePath = join(
      codexesRoot,
      pair.live_pack_id,
      'skills',
      pair.live_skill_name,
      'skill.yaml',
    );
    const fixturePath = join(process.cwd(), pair.fixture_path);

    const liveExists = await stat(livePath)
      .then(() => true)
      .catch(() => false);
    if (!liveExists) {
      process.stdout.write(`live-absent: ${pair.live_skill_name}\n`);
      absent++;
      continue;
    }
    // Check if bytes already match — short-circuit so idempotent runs are clean.
    const liveBytes = await readFile(livePath, 'utf8');
    const fixtureBytes = await readFile(fixturePath, 'utf8').catch(() => null);
    if (fixtureBytes === liveBytes) {
      process.stdout.write(`unchanged:   ${pair.live_skill_name}\n`);
      unchanged++;
      continue;
    }
    await mkdir(dirname(fixturePath), { recursive: true });
    await copyFile(livePath, fixturePath);
    process.stdout.write(`synced:      ${pair.live_skill_name} → ${pair.fixture_path}\n`);
    synced++;
  }

  process.stdout.write(
    `\nSummary: ${String(synced)} synced, ${String(unchanged)} unchanged, ${String(absent)} live-absent${filter !== undefined ? `, ${String(filteredOut)} filtered out by name` : ''}\n`,
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`sync-fixtures failed: ${String(e)}\n`);
  process.exitCode = 1;
});
