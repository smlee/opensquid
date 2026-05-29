/**
 * T-ASC ASC.6 — fixture-sync byte-identity matcher.
 *
 * Every (live skill, CI fixture) pair declared in
 * `test/fixtures/sync-whitelist.json` must be byte-identical. Drift = CI
 * fail. The matcher loads each pair's live source under `~/.opensquid/
 * packs/<pack-id>/skills/<name>/skill.yaml` and the fixture under the
 * repo's `test/fixtures/<...>/skill.yaml` and compares the bytes.
 *
 * Dev-only enforcement compromise (L9): CI runners (GitHub Actions,
 * fresh checkouts) don't have the user's `~/.opensquid/packs/` tree.
 * When the live tree is absent the matcher SKIPS the pair without
 * failure — the user's machine pre-push is the enforcement point. A
 * live skill that's individually absent (e.g. mid-edit between user
 * machines) also skips that single pair, NOT the whole suite.
 *
 * Schema validation (sync-whitelist.schema.json): the matcher parses
 * the JSON through a strict Zod schema, so a typo in the whitelist
 * surfaces as a Zod error at the FIRST test (parses the whitelist) —
 * before any byte comparison runs. Adding a new pair requires updating
 * the whitelist; updating the live skill without updating the fixture
 * (or vice versa) trips the matcher with the offending skill name in
 * the failure message.
 *
 * Imports: node:fs/promises, node:os, node:path, vitest, zod.
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');

const SyncWhitelistEntry = z
  .object({
    live_pack_id: z.string().min(1),
    live_skill_name: z.string().min(1),
    fixture_path: z.string().min(1),
  })
  .strict();
const SyncWhitelist = z.object({ pairs: z.array(SyncWhitelistEntry) }).passthrough(); // allow $schema + _doc top-level keys

const WHITELIST_PATH = join(REPO_ROOT, 'test/fixtures/sync-whitelist.json');
const PACKS_ROOT = join(homedir(), '.opensquid', 'packs');

describe('T-ASC ASC.6 — fixture-sync byte-identity', () => {
  it('parses the whitelist and lists at least one pair', async () => {
    const raw = await readFile(WHITELIST_PATH, 'utf8');
    const parsed = SyncWhitelist.parse(JSON.parse(raw));
    expect(parsed.pairs.length).toBeGreaterThan(0);
    // No duplicate fixture_path entries (each fixture has exactly one source).
    const seen = new Set<string>();
    for (const p of parsed.pairs) {
      expect(seen.has(p.fixture_path), `duplicate fixture_path: ${p.fixture_path}`).toBe(false);
      seen.add(p.fixture_path);
    }
  });

  it('every whitelisted (live, fixture) pair is byte-identical when the live tree exists', async () => {
    const parsed = SyncWhitelist.parse(JSON.parse(await readFile(WHITELIST_PATH, 'utf8')));
    const packsExists = await stat(PACKS_ROOT)
      .then(() => true)
      .catch(() => false);
    if (!packsExists) {
      // Dev-only enforcement (L9): no live tree → CI runner case → skip.
      return;
    }
    for (const pair of parsed.pairs) {
      const livePath = join(
        PACKS_ROOT,
        pair.live_pack_id,
        'skills',
        pair.live_skill_name,
        'skill.yaml',
      );
      const fixturePath = join(REPO_ROOT, pair.fixture_path);
      const liveExists = await stat(livePath)
        .then(() => true)
        .catch(() => false);
      if (!liveExists) {
        // Individual live skill absent — skip this pair (mid-edit / not deployed).
        continue;
      }
      const live = await readFile(livePath, 'utf8');
      const fixture = await readFile(fixturePath, 'utf8');
      expect(
        fixture,
        `fixture-sync drift on "${pair.live_skill_name}" — run \`pnpm sync-fixtures\` to update the fixture from the live source`,
      ).toBe(live);
    }
  });
});
