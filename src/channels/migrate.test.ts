/**
 * CAT.1d — unit tests for the legacy→umbrella migration.
 *
 * fs is mocked via OPENSQUID_HOME → mkdtemp. We seed a realistic legacy layout:
 *   projects.json registry + per-uuid chat-routing.json + per-uuid inbox JSONL,
 * mirroring the da96≡0742 case (two uuids reporting to the SAME (chat, topic)
 * collapse into ONE `loop` umbrella) + a separate raumpilates uuid that carries
 * the DM allowlist (which must land on `general`, NOT on raumpilates).
 *
 * Covers:
 *   - synthChannelsConfig groups mirror uuids → one umbrella w/ both members
 *   - DM ids → general.telegram.dm_user_ids (never a project umbrella), and
 *     general claims the supergroup chat_id + owns_general_thread
 *   - umbrella ids slugged from the shared project `id`
 *   - migrateInboxData dedups mirrored rows by (platform,id), preserves order,
 *     is idempotent + non-destructive, copies acked.jsonl (dedup by message_id)
 *   - writeChannelsConfig --force semantics (default no-op-if-present)
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { channelsConfigPath } from './routing.js';
import {
  chatIdFromReportChannel,
  legacyUuidsForUmbrella,
  migrateInboxData,
  runMigration,
  slugifyUmbrellaId,
  synthChannelsConfig,
  synthFromLegacy,
  writeChannelsConfig,
} from './migrate.js';

// ---------------------------------------------------------------------------
// Fixture identifiers — the da96≡0742 mirror + a raumpilates uuid.
// ---------------------------------------------------------------------------
const SUPERGROUP = '-1003923174632';
const DA96 = 'da96';
const ZERO742 = '0742';
const RAUM = 'raum-uuid';
const DM_USER = '8075471258';

/** Typed JSON.parse — keeps the lint clean (no `any` from the parser). */
function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

/** The on-disk channels.json shape the assertions reach into. */
interface ChannelsOnDisk {
  umbrellas: { id: string; members: string[] }[];
  general?: { telegram?: { dm_user_ids?: string[] } };
}

describe('migrate', () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(async () => {
    savedHome = process.env.OPENSQUID_HOME;
    home = await mkdtemp(join(tmpdir(), 'cat1d-migrate-'));
    process.env.OPENSQUID_HOME = home;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = savedHome;
    await rm(home, { recursive: true, force: true });
  });

  // --- helpers to seed the legacy layout ----------------------------------

  async function seedRegistry(
    entries: Record<string, { id: string; last_seen_path: string }>,
  ): Promise<void> {
    await writeFile(join(home, 'projects.json'), JSON.stringify({ version: 1, projects: entries }));
  }

  async function seedRouting(uuid: string, telegram: Record<string, unknown>): Promise<void> {
    const dir = join(home, 'projects', uuid);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'chat-routing.json'), JSON.stringify({ telegram }));
  }

  async function seedInbox(
    uuid: string,
    platform: string,
    rows: Record<string, unknown>[],
  ): Promise<void> {
    const dir = join(home, 'projects', uuid, 'inbox');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${platform}.jsonl`),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
  }

  /** The canonical mirror layout: da96 + 0742 → loop (topic 15); raum → topic
   *  281 carrying the DM allowlist. */
  async function seedMirrorLayout(): Promise<void> {
    await seedRegistry({
      [DA96]: { id: 'loop', last_seen_path: '/Users/x/projects/loop' },
      [ZERO742]: { id: 'loop', last_seen_path: '/Users/x/projects/opensquid' },
      [RAUM]: { id: 'RaumPilates-FE', last_seen_path: '/Users/x/projects/RaumPilates/FE' },
    });
    await seedRouting(DA96, { report_channel: `telegram:${SUPERGROUP}`, report_topic_id: 15 });
    await seedRouting(ZERO742, { report_channel: `telegram:${SUPERGROUP}`, report_topic_id: 15 });
    await seedRouting(RAUM, {
      report_channel: `telegram:${SUPERGROUP}`,
      report_topic_id: 281,
      inbound_dm_user_ids: [DM_USER],
    });
  }

  // --- pure helpers --------------------------------------------------------

  describe('slugifyUmbrellaId', () => {
    it('lowercases + hyphenates non-alnum runs, trims edges', () => {
      expect(slugifyUmbrellaId('RaumPilates-FE')).toBe('raumpilates-fe');
      expect(slugifyUmbrellaId('loop')).toBe('loop');
      expect(slugifyUmbrellaId('  Foo / Bar!! ')).toBe('foo-bar');
    });
  });

  describe('chatIdFromReportChannel', () => {
    it('extracts the bare chat id from a telegram:<id> report_channel', () => {
      expect(chatIdFromReportChannel(`telegram:${SUPERGROUP}`)).toBe(SUPERGROUP);
    });
    it('returns null for undefined or non-telegram channels', () => {
      expect(chatIdFromReportChannel(undefined)).toBeNull();
      expect(chatIdFromReportChannel('discord:123')).toBeNull();
      expect(chatIdFromReportChannel('telegram:')).toBeNull();
    });
  });

  // --- synthFromLegacy (pure grouping) ------------------------------------

  describe('synthFromLegacy', () => {
    it('collapses mirror uuids reporting to the same (chat,topic) into ONE umbrella', () => {
      const { config, uuidsByUmbrella } = synthFromLegacy([
        {
          uuid: DA96,
          id: 'loop',
          lastSeenPath: '/Users/x/projects/loop',
          routing: { telegram: { report_channel: `telegram:${SUPERGROUP}`, report_topic_id: 15 } },
        },
        {
          uuid: ZERO742,
          id: 'loop',
          lastSeenPath: '/Users/x/projects/opensquid',
          routing: { telegram: { report_channel: `telegram:${SUPERGROUP}`, report_topic_id: 15 } },
        },
      ]);
      expect(config.umbrellas).toHaveLength(1);
      const loop = config.umbrellas[0]!;
      expect(loop.id).toBe('loop');
      expect(loop.members).toEqual(['/Users/x/projects/loop', '/Users/x/projects/opensquid']);
      expect(loop.telegram).toEqual({ chat_id: SUPERGROUP, topic_id: 15 });
      expect(uuidsByUmbrella.loop).toEqual([DA96, ZERO742]);
    });

    it('routes ANY inbound_dm_user_ids to general (NOT the project umbrella)', () => {
      const { config } = synthFromLegacy([
        {
          uuid: RAUM,
          id: 'RaumPilates-FE',
          lastSeenPath: '/Users/x/projects/raum',
          routing: {
            telegram: {
              report_channel: `telegram:${SUPERGROUP}`,
              report_topic_id: 281,
              inbound_dm_user_ids: [DM_USER],
            },
          },
        },
      ]);
      // The DM must NOT appear on the raumpilates umbrella row.
      const raum = config.umbrellas[0];
      expect(JSON.stringify(raum)).not.toContain(DM_USER);
      // It lands on general, which claims the supergroup + owns the thread.
      expect(config.general?.telegram?.dm_user_ids).toEqual([DM_USER]);
      expect(config.general?.telegram?.chat_id).toBe(SUPERGROUP);
      expect(config.general?.telegram?.owns_general_thread).toBe(true);
    });

    it('slugs the umbrella id from the shared project id', () => {
      const { config } = synthFromLegacy([
        {
          uuid: RAUM,
          id: 'RaumPilates-FE',
          lastSeenPath: '/Users/x/projects/raum',
          routing: { telegram: { report_channel: `telegram:${SUPERGROUP}`, report_topic_id: 281 } },
        },
      ]);
      expect(config.umbrellas[0]!.id).toBe('raumpilates-fe');
    });
  });

  // --- synthChannelsConfig (fs wrapper) -----------------------------------

  it('synthChannelsConfig produces loop (2 members) + raumpilates + general(DM)', async () => {
    await seedMirrorLayout();
    const cfg = await synthChannelsConfig();
    const loop = cfg.umbrellas.find((u) => u.id === 'loop');
    const raum = cfg.umbrellas.find((u) => u.id === 'raumpilates-fe');
    expect(loop?.members).toEqual(['/Users/x/projects/loop', '/Users/x/projects/opensquid']);
    expect(loop?.telegram).toEqual({ chat_id: SUPERGROUP, topic_id: 15 });
    expect(raum?.telegram).toEqual({ chat_id: SUPERGROUP, topic_id: 281 });
    expect(cfg.general?.telegram?.dm_user_ids).toEqual([DM_USER]);
    // legacyUuidsForUmbrella round-trips the mirror grouping.
    expect(await legacyUuidsForUmbrella('loop')).toEqual([DA96, ZERO742]);
  });

  it('synthChannelsConfig returns an empty config when there is no legacy data', async () => {
    const cfg = await synthChannelsConfig();
    expect(cfg).toEqual({ v: 1, umbrellas: [] });
  });

  // --- writeChannelsConfig ------------------------------------------------

  describe('writeChannelsConfig', () => {
    const cfg = { v: 1 as const, umbrellas: [{ id: 'loop', members: ['/a'] }] };

    it('writes when absent', async () => {
      const res = await writeChannelsConfig(cfg);
      expect(res.written).toBe(true);
      const onDisk = parseJson<ChannelsOnDisk>(await readFile(channelsConfigPath(), 'utf8'));
      expect(onDisk.umbrellas[0]!.id).toBe('loop');
    });

    it('is a no-op when the file already exists (idempotent)', async () => {
      await writeChannelsConfig(cfg);
      const res = await writeChannelsConfig({ v: 1, umbrellas: [{ id: 'changed', members: [] }] });
      expect(res.written).toBe(false);
      const onDisk = parseJson<ChannelsOnDisk>(await readFile(channelsConfigPath(), 'utf8'));
      expect(onDisk.umbrellas[0]!.id).toBe('loop'); // unchanged
    });

    it('overwrites with --force', async () => {
      await writeChannelsConfig(cfg);
      const res = await writeChannelsConfig(
        { v: 1, umbrellas: [{ id: 'changed', members: [] }] },
        { force: true },
      );
      expect(res.written).toBe(true);
      const onDisk = parseJson<ChannelsOnDisk>(await readFile(channelsConfigPath(), 'utf8'));
      expect(onDisk.umbrellas[0]!.id).toBe('changed');
    });
  });

  // --- migrateInboxData ---------------------------------------------------

  describe('migrateInboxData', () => {
    function row(id: string, receivedAt: string): Record<string, unknown> {
      return {
        v: 1,
        id,
        platform: 'telegram',
        channel: `telegram:${SUPERGROUP}`,
        sender: 'a',
        sender_id: 's',
        text: `t-${id}`,
        received_at: receivedAt,
        enqueued_at: receivedAt,
        mentions_bot: false,
      };
    }

    async function readUmbrellaInbox(): Promise<Record<string, unknown>[]> {
      const raw = await readFile(
        join(home, 'umbrellas', 'loop', 'inbox', 'telegram.jsonl'),
        'utf8',
      );
      return raw
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => parseJson<Record<string, unknown>>(l));
    }

    it('dedups mirrored rows by (platform,id), preserving received_at order', async () => {
      await seedMirrorLayout();
      // da96 + 0742 share message m2 (the mirror); each has a unique one too.
      await seedInbox(DA96, 'telegram', [
        row('m1', '2026-01-01T00:00:00Z'),
        row('m2', '2026-01-01T00:01:00Z'),
      ]);
      await seedInbox(ZERO742, 'telegram', [
        row('m2', '2026-01-01T00:01:00Z'),
        row('m3', '2026-01-01T00:02:00Z'),
      ]);

      const cfg = await synthChannelsConfig();
      const { copied } = await migrateInboxData(cfg);
      expect(copied.loop).toBe(3); // m1, m2, m3 — m2 deduped once
      const ids = (await readUmbrellaInbox()).map((r) => r.id);
      expect(ids).toEqual(['m1', 'm2', 'm3']);
    });

    it('is idempotent — a second run copies nothing', async () => {
      await seedMirrorLayout();
      await seedInbox(DA96, 'telegram', [row('m1', '2026-01-01T00:00:00Z')]);
      await seedInbox(ZERO742, 'telegram', [row('m2', '2026-01-01T00:01:00Z')]);
      const cfg = await synthChannelsConfig();
      await migrateInboxData(cfg);
      const second = await migrateInboxData(cfg);
      expect(second.copied.loop).toBe(0);
      const ids = (await readUmbrellaInbox()).map((r) => r.id);
      expect(ids).toEqual(['m1', 'm2']); // no duplicates
    });

    it('is non-destructive — source inbox files are untouched', async () => {
      await seedMirrorLayout();
      await seedInbox(DA96, 'telegram', [row('m1', '2026-01-01T00:00:00Z')]);
      const before = await readFile(
        join(home, 'projects', DA96, 'inbox', 'telegram.jsonl'),
        'utf8',
      );
      const cfg = await synthChannelsConfig();
      await migrateInboxData(cfg);
      const after = await readFile(join(home, 'projects', DA96, 'inbox', 'telegram.jsonl'), 'utf8');
      expect(after).toBe(before);
    });

    it('copies + dedups acked.jsonl by message_id', async () => {
      await seedMirrorLayout();
      const ackDir96 = join(home, 'projects', DA96, 'inbox');
      const ackDir742 = join(home, 'projects', ZERO742, 'inbox');
      await mkdir(ackDir96, { recursive: true });
      await mkdir(ackDir742, { recursive: true });
      await writeFile(
        join(ackDir96, 'acked.jsonl'),
        JSON.stringify({ message_id: 'a1' }) +
          '\n' +
          JSON.stringify({ message_id: 'shared' }) +
          '\n',
      );
      await writeFile(
        join(ackDir742, 'acked.jsonl'),
        JSON.stringify({ message_id: 'shared' }) +
          '\n' +
          JSON.stringify({ message_id: 'a2' }) +
          '\n',
      );
      const cfg = await synthChannelsConfig();
      await migrateInboxData(cfg);
      const acked = (
        await readFile(join(home, 'umbrellas', 'loop', 'inbox', 'acked.jsonl'), 'utf8')
      )
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => parseJson<{ message_id: string }>(l).message_id);
      expect(acked).toEqual(['a1', 'shared', 'a2']);
    });
  });

  // --- runMigration (orchestrator) ----------------------------------------

  it('runMigration synthesizes + writes channels.json + copies inbox in one shot', async () => {
    await seedMirrorLayout();
    await seedInbox(DA96, 'telegram', [
      {
        v: 1,
        id: 'm1',
        platform: 'telegram',
        channel: `telegram:${SUPERGROUP}`,
        sender: 'a',
        sender_id: 's',
        text: 't',
        received_at: '2026-01-01T00:00:00Z',
        enqueued_at: '2026-01-01T00:00:00Z',
        mentions_bot: false,
      },
    ]);
    const res = await runMigration();
    expect(res.configWritten).toBe(true);
    expect(res.config.umbrellas.map((u) => u.id).sort()).toEqual(['loop', 'raumpilates-fe']);
    expect(res.copied.loop).toBe(1);
    // channels.json is on disk + parseable.
    const onDisk = parseJson<ChannelsOnDisk>(await readFile(channelsConfigPath(), 'utf8'));
    expect(onDisk.general?.telegram?.dm_user_ids).toEqual([DM_USER]);
  });
});
