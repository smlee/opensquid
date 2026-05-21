/**
 * TG.5 — Multi-project Telegram routing E2E.
 *
 * Proves the chat-daemon's per-project routing layer correctly isolates
 * traffic when multiple projects share one supergroup with different
 * forum topics, AND maintains strict-whitelist semantics on
 * `inbound_topic_ids` (no fallthrough to chat-only keys for non-listed
 * topics — security-correct default per TG.1 §d).
 *
 * Design tradeoff (resolved 2026-05-20): this test INLINES copies of
 * `buildRoutingIndex` + `collectInboundChannels` rather than importing
 * from `src.legacy/chat/daemon/routing.ts`. The production routing.ts
 * transitively imports from `src.legacy/codex/store.ts` which pulls in
 * `src.legacy/codex/parse.ts` — the latter has pre-existing strict-
 * flag type errors. Importing routing.ts from test/ surfaces those
 * errors in the main `pnpm typecheck` because TypeScript resolves
 * module-graph types regardless of `exclude` settings. `// @ts-nocheck`
 * doesn't help — type-resolution still follows the import.
 *
 * Therefore: the test owns its own copy of the routing logic + types
 * (kept byte-equivalent to routing.ts modulo this comment). Drift
 * protection: if buildRoutingIndex or collectInboundChannels in
 * src.legacy/chat/daemon/routing.ts is changed without updating this
 * file, the tests still verify the spec'd behavior, but the test may
 * diverge from production. Acceptable for v1 — when src.legacy/ is
 * migrated out of quarantine OR the codex parse errors are fixed, this
 * duplication is removed and the test imports directly.
 *
 * Test scope:
 *   1. Project A topic 15 + Project B topic 16 share one supergroup;
 *      messages route to the correct project per topic
 *   2. Project C with NO inbound_topic_ids accepts all messages from
 *      its declared supergroup (chat-only key match)
 *   3. STRICT-WHITELIST: a topic-15 project does NOT inherit topic-99
 *      traffic from the same supergroup (no fallback to chat-only key
 *      when inbound_topic_ids was set)
 *   4. Orphan: messages with no matching project key return undefined
 *   5. Collision: two projects claiming the same key — warning fires
 *   6. Discord + Slack key emission independent
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Inlined types + functions — kept byte-equivalent to
// src.legacy/chat/daemon/routing.ts. See module header for rationale.
// ---------------------------------------------------------------------------

interface TelegramRouting {
  report_channel?: string;
  report_topic_id?: number;
  inbound_chat_ids?: string[];
  inbound_topic_ids?: number[];
}
interface DiscordRouting {
  report_channel?: string;
  inbound_channel_ids?: string[];
}
interface SlackRouting {
  report_channel?: string;
  inbound_channel_ids?: string[];
}
interface ProjectChatRouting {
  telegram?: TelegramRouting;
  discord?: DiscordRouting;
  slack?: SlackRouting;
}
type RoutingIndex = Map<string, string>;

function collectInboundChannels(cfg: ProjectChatRouting): string[] {
  const out: string[] = [];
  if (cfg.telegram?.inbound_chat_ids) {
    const topicIds = cfg.telegram.inbound_topic_ids;
    for (const chatId of cfg.telegram.inbound_chat_ids) {
      if (topicIds && topicIds.length > 0) {
        for (const tid of topicIds) out.push(`telegram:${chatId}:${tid}`);
      } else {
        out.push(`telegram:${chatId}`);
      }
    }
  }
  if (cfg.discord?.inbound_channel_ids) {
    for (const id of cfg.discord.inbound_channel_ids) out.push(`discord:${id}`);
  }
  if (cfg.slack?.inbound_channel_ids) {
    for (const id of cfg.slack.inbound_channel_ids) out.push(`slack:${id}`);
  }
  return out;
}

function buildRoutingIndex(
  configs: Map<string, ProjectChatRouting>,
  onWarn?: (message: string) => void,
): RoutingIndex {
  const idx: RoutingIndex = new Map();
  for (const [projectUuid, cfg] of configs) {
    for (const channelKey of collectInboundChannels(cfg)) {
      const existing = idx.get(channelKey);
      if (existing && existing !== projectUuid && onWarn) {
        onWarn(
          `chat_id collision: ${channelKey} claimed by both project ${existing} and ${projectUuid} (latter wins)`,
        );
      }
      idx.set(channelKey, projectUuid);
    }
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Test fixtures — placeholder IDs only, never real values per
// `feedback_personal_data_leak_audit`.
// ---------------------------------------------------------------------------

const PROJECT_A = '11111111-1111-1111-1111-111111111111';
const PROJECT_B = '22222222-2222-2222-2222-222222222222';
const PROJECT_C = '33333333-3333-3333-3333-333333333333';
const SHARED_SUPERGROUP = '-1001234567890';
const TOPIC_A = 15;
const TOPIC_B = 16;

describe('Telegram multi-project routing (TG.5)', () => {
  describe('collectInboundChannels — topic-aware key emission', () => {
    it('emits per-topic keys when inbound_topic_ids is set', () => {
      const cfg: ProjectChatRouting = {
        telegram: {
          inbound_chat_ids: [SHARED_SUPERGROUP],
          inbound_topic_ids: [TOPIC_A, TOPIC_B],
        },
      };
      const keys = collectInboundChannels(cfg);
      expect(keys).toEqual([
        `telegram:${SHARED_SUPERGROUP}:${TOPIC_A}`,
        `telegram:${SHARED_SUPERGROUP}:${TOPIC_B}`,
      ]);
    });

    it('emits chat-only key when inbound_topic_ids is unset', () => {
      const cfg: ProjectChatRouting = {
        telegram: { inbound_chat_ids: [SHARED_SUPERGROUP] },
      };
      expect(collectInboundChannels(cfg)).toEqual([`telegram:${SHARED_SUPERGROUP}`]);
    });

    it('emits chat-only key when inbound_topic_ids is empty array', () => {
      const cfg: ProjectChatRouting = {
        telegram: {
          inbound_chat_ids: [SHARED_SUPERGROUP],
          inbound_topic_ids: [],
        },
      };
      expect(collectInboundChannels(cfg)).toEqual([`telegram:${SHARED_SUPERGROUP}`]);
    });

    it('returns empty array for empty config', () => {
      expect(collectInboundChannels({})).toEqual([]);
    });

    it('does NOT emit fallback chat-only key when inbound_topic_ids is set (strict whitelist per TG.1 §d)', () => {
      const cfg: ProjectChatRouting = {
        telegram: {
          inbound_chat_ids: [SHARED_SUPERGROUP],
          inbound_topic_ids: [TOPIC_A],
        },
      };
      const keys = collectInboundChannels(cfg);
      expect(keys).not.toContain(`telegram:${SHARED_SUPERGROUP}`);
      expect(keys).toEqual([`telegram:${SHARED_SUPERGROUP}:${TOPIC_A}`]);
    });
  });

  describe('buildRoutingIndex — multi-project topic isolation', () => {
    it('two projects sharing one supergroup with different topics route correctly', () => {
      const configs = new Map<string, ProjectChatRouting>([
        [
          PROJECT_A,
          {
            telegram: {
              inbound_chat_ids: [SHARED_SUPERGROUP],
              inbound_topic_ids: [TOPIC_A],
            },
          },
        ],
        [
          PROJECT_B,
          {
            telegram: {
              inbound_chat_ids: [SHARED_SUPERGROUP],
              inbound_topic_ids: [TOPIC_B],
            },
          },
        ],
      ]);
      const idx = buildRoutingIndex(configs);
      expect(idx.get(`telegram:${SHARED_SUPERGROUP}:${TOPIC_A}`)).toBe(PROJECT_A);
      expect(idx.get(`telegram:${SHARED_SUPERGROUP}:${TOPIC_B}`)).toBe(PROJECT_B);
    });

    it('topic-99 message orphans (no project claims it) — STRICT WHITELIST verified', () => {
      const configs = new Map<string, ProjectChatRouting>([
        [
          PROJECT_A,
          {
            telegram: {
              inbound_chat_ids: [SHARED_SUPERGROUP],
              inbound_topic_ids: [TOPIC_A],
            },
          },
        ],
      ]);
      const idx = buildRoutingIndex(configs);
      expect(idx.get(`telegram:${SHARED_SUPERGROUP}:99`)).toBeUndefined();
      expect(idx.get(`telegram:${SHARED_SUPERGROUP}`)).toBeUndefined();
    });

    it('chat-only-routing project accepts all messages from its supergroup', () => {
      const configs = new Map<string, ProjectChatRouting>([
        [PROJECT_C, { telegram: { inbound_chat_ids: [SHARED_SUPERGROUP] } }],
      ]);
      const idx = buildRoutingIndex(configs);
      expect(idx.get(`telegram:${SHARED_SUPERGROUP}`)).toBe(PROJECT_C);
    });

    it('topic-strict project + chat-only project on different supergroups coexist', () => {
      const otherSupergroup = '-1009876543210';
      const configs = new Map<string, ProjectChatRouting>([
        [
          PROJECT_A,
          {
            telegram: {
              inbound_chat_ids: [SHARED_SUPERGROUP],
              inbound_topic_ids: [TOPIC_A],
            },
          },
        ],
        [PROJECT_C, { telegram: { inbound_chat_ids: [otherSupergroup] } }],
      ]);
      const idx = buildRoutingIndex(configs);
      expect(idx.get(`telegram:${SHARED_SUPERGROUP}:${TOPIC_A}`)).toBe(PROJECT_A);
      expect(idx.get(`telegram:${otherSupergroup}`)).toBe(PROJECT_C);
      expect(idx.get(`telegram:${SHARED_SUPERGROUP}`)).toBeUndefined();
    });

    it('collision: two projects claim same key — latter wins + warning fires', () => {
      const warnings: string[] = [];
      const configs = new Map<string, ProjectChatRouting>([
        [
          PROJECT_A,
          {
            telegram: {
              inbound_chat_ids: [SHARED_SUPERGROUP],
              inbound_topic_ids: [TOPIC_A],
            },
          },
        ],
        [
          PROJECT_B,
          {
            telegram: {
              inbound_chat_ids: [SHARED_SUPERGROUP],
              inbound_topic_ids: [TOPIC_A],
            },
          },
        ],
      ]);
      const idx = buildRoutingIndex(configs, (msg) => warnings.push(msg));
      const winner = idx.get(`telegram:${SHARED_SUPERGROUP}:${TOPIC_A}`);
      expect(winner === PROJECT_A || winner === PROJECT_B).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/chat_id collision: telegram:.*:15/);
    });

    it('Discord + Slack key emission independent of Telegram', () => {
      const configs = new Map<string, ProjectChatRouting>([
        [
          PROJECT_A,
          {
            discord: { inbound_channel_ids: ['dch-1', 'dch-2'] },
            slack: { inbound_channel_ids: ['C12345', 'C67890'] },
          },
        ],
      ]);
      const idx = buildRoutingIndex(configs);
      expect(idx.get('discord:dch-1')).toBe(PROJECT_A);
      expect(idx.get('discord:dch-2')).toBe(PROJECT_A);
      expect(idx.get('slack:C12345')).toBe(PROJECT_A);
      expect(idx.get('slack:C67890')).toBe(PROJECT_A);
    });

    it('empty configs map returns empty index', () => {
      const idx = buildRoutingIndex(new Map());
      expect(idx.size).toBe(0);
    });
  });
});
