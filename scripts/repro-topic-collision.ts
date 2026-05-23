#!/usr/bin/env tsx
/**
 * TPS.1 reproducer — demonstrate the current routing-index behavior
 * for `(chat_id, thread_id)` tuples, including the collision-warning
 * code path.
 *
 * What this proves:
 *   1. The routing index ALREADY supports per-topic keying
 *      (`telegram:<chat_id>:<thread_id>`). The primitive exists.
 *   2. When two workspaces claim the same `(chat_id, thread_id)`,
 *      the index silently picks "latter wins" and emits a console
 *      warning that no user ever sees (no notification surface).
 *   3. When a workspace omits `inbound_topic_ids`, ALL messages
 *      from that chat_id route there regardless of topic — the
 *      "meaningless supergroup" failure mode.
 *
 * Run with:
 *   pnpm exec tsx scripts/repro-topic-collision.ts
 */

import { buildRoutingIndex } from '../src.legacy/chat/daemon/routing.js';
import type { ProjectChatRouting } from '../src.legacy/chat/daemon/routing.js';

interface Scenario {
  label: string;
  configs: Map<string, ProjectChatRouting>;
  expectedKeys: string[];
  expectedWarnings: number;
  expectedRouting?: { key: string; uuid: string };
}

function runScenario(s: Scenario): void {
  process.stdout.write(`\n=== ${s.label} ===\n`);
  const warnings: string[] = [];
  const idx = buildRoutingIndex(s.configs, (w) => warnings.push(w));
  const keys = [...idx.keys()].sort();
  process.stdout.write(`  Index keys: ${JSON.stringify(keys)}\n`);
  process.stdout.write(`  Warnings (${warnings.length}):\n`);
  for (const w of warnings) process.stdout.write(`    - ${w}\n`);

  const keysOk = JSON.stringify(keys) === JSON.stringify([...s.expectedKeys].sort());
  const warnOk = warnings.length === s.expectedWarnings;
  let routeOk = true;
  if (s.expectedRouting) {
    const actual = idx.get(s.expectedRouting.key);
    routeOk = actual === s.expectedRouting.uuid;
    process.stdout.write(
      `  Route for ${s.expectedRouting.key}: ${actual ?? '<none>'} (expected ${s.expectedRouting.uuid}) → ${routeOk ? 'OK' : 'FAIL'}\n`,
    );
  }
  process.stdout.write(
    `  Result: keys=${keysOk ? 'OK' : 'FAIL'} warnings=${warnOk ? 'OK' : 'FAIL'} route=${routeOk ? 'OK' : 'N/A'}\n`,
  );
}

const scenarios: Scenario[] = [
  {
    label:
      'A — Two projects claim the SAME (chat_id, thread_id) → collision warning, latter wins, silent for user',
    configs: new Map<string, ProjectChatRouting>([
      ['uuid-A', { telegram: { inbound_chat_ids: ['-1001234'], inbound_topic_ids: [15] } }],
      ['uuid-B', { telegram: { inbound_chat_ids: ['-1001234'], inbound_topic_ids: [15] } }],
    ]),
    expectedKeys: ['telegram:-1001234:15'],
    expectedWarnings: 1,
    expectedRouting: { key: 'telegram:-1001234:15', uuid: 'uuid-B' },
  },
  {
    label:
      'B — Two projects, DIFFERENT topics in same supergroup → both routed cleanly, no warning. The primitive works.',
    configs: new Map<string, ProjectChatRouting>([
      ['uuid-A', { telegram: { inbound_chat_ids: ['-1001234'], inbound_topic_ids: [15] } }],
      ['uuid-B', { telegram: { inbound_chat_ids: ['-1001234'], inbound_topic_ids: [42] } }],
    ]),
    expectedKeys: ['telegram:-1001234:15', 'telegram:-1001234:42'],
    expectedWarnings: 0,
    expectedRouting: { key: 'telegram:-1001234:42', uuid: 'uuid-B' },
  },
  {
    label:
      'C — Project omits inbound_topic_ids → catches ALL traffic to that chat_id ("meaningless supergroup" mode)',
    configs: new Map<string, ProjectChatRouting>([
      ['uuid-A', { telegram: { inbound_chat_ids: ['-1001234'] /* no inbound_topic_ids */ } }],
    ]),
    expectedKeys: ['telegram:-1001234'],
    expectedWarnings: 0,
    expectedRouting: { key: 'telegram:-1001234', uuid: 'uuid-A' },
  },
  {
    label:
      'D — One project per-topic + one project catch-all → both keys exist, no collision (different key shapes)',
    configs: new Map<string, ProjectChatRouting>([
      ['uuid-A', { telegram: { inbound_chat_ids: ['-1001234'], inbound_topic_ids: [15] } }],
      ['uuid-B', { telegram: { inbound_chat_ids: ['-1001234'] } }],
    ]),
    expectedKeys: ['telegram:-1001234', 'telegram:-1001234:15'],
    expectedWarnings: 0,
    expectedRouting: { key: 'telegram:-1001234:15', uuid: 'uuid-A' },
  },
];

for (const s of scenarios) runScenario(s);

process.stdout.write(
  '\nConclusion: routing-index PRIMITIVE supports per-topic keying. Gap is workspace→topic auto-binding (TPS.3-TPS.6) + user-visible collision surface (TPS.5).\n',
);
