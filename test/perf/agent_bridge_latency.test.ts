/**
 * WAB.8 — Perf harness for warm-pool agent-loop latency.
 *
 * Gated by `WAB_PERF=1` AND `ANTHROPIC_API_KEY`. Skips cleanly otherwise.
 *
 * Measures p50/p95/p99 per-turn latency across N iterations to quantify:
 *   - Cold cache (first turn — no prompt-cache hit)
 *   - Warm cache (subsequent turns — full system + last-2-user-msg cache hits)
 *
 * The harness wires `runAgentTurn` directly against the real Anthropic SDK
 * client; it does NOT spawn the daemon (the daemon adds its own startup +
 * inbox-watcher cost which is orthogonal to per-turn latency). The
 * `SimpleToolDispatcher` is given a single no-op `noop_echo` tool so the
 * loop terminates after one turn even if the model emits tool_use.
 *
 * Default: 20 iterations (set WAB_PERF_ITER=N to override, max 200).
 * Prints a summary table to stdout. Operator can also pipe to
 * `tee perf-results.txt` for archival.
 *
 * Cost note: 20 Haiku 4.5 turns @ ~200 tokens each ≈ $0.0001-$0.001.
 *
 * Spec source: docs/tasks/T-warm-agent-chat-bridge.md WAB.8 §F + §G.
 */

import { describe, it } from 'vitest';

import {
  runAgentTurn,
  type AnthropicMessageClient,
} from '../../src/runtime/agent_bridge/agent_loop.js';
import { SimpleToolDispatcher } from '../../src/runtime/agent_bridge/tool_dispatcher.js';
import type { SessionKey, SessionState, ToolSpec } from '../../src/runtime/agent_bridge/types.js';

const PERF_ENABLED =
  process.env.WAB_PERF === '1' &&
  typeof process.env.ANTHROPIC_API_KEY === 'string' &&
  process.env.ANTHROPIC_API_KEY.length > 0;

const ITERATIONS = Math.min(
  Math.max(parseInt(process.env.WAB_PERF_ITER ?? '20', 10) || 20, 5),
  200,
);

const MODEL = process.env.WAB_PERF_MODEL ?? 'claude-haiku-4-5-20251001';

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

function summarize(label: string, samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sorted.length > 0 ? sum / sorted.length : 0;
  return [
    `  ${label.padEnd(12)} n=${sorted.length}`,
    `min=${(sorted[0] ?? 0).toFixed(0)}ms`,
    `p50=${pct(sorted, 50).toFixed(0)}ms`,
    `p95=${pct(sorted, 95).toFixed(0)}ms`,
    `p99=${pct(sorted, 99).toFixed(0)}ms`,
    `max=${(sorted[sorted.length - 1] ?? 0).toFixed(0)}ms`,
    `mean=${mean.toFixed(0)}ms`,
  ].join('  ');
}

describe.skipIf(!PERF_ENABLED)('WAB.8 — agent_bridge perf harness', () => {
  it(
    `cold vs warm latency (N=${ITERATIONS}, model=${MODEL})`,
    async () => {
      // Dynamic-import the SDK so the test file remains parseable when the
      // optional peer dep is not installed.
      const mod = (await import('@anthropic-ai/sdk')) as {
        default: new (opts: { apiKey: string }) => { messages: AnthropicMessageClient };
      };
      const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
      const client = new mod.default({ apiKey }).messages;

      // One no-op tool — model can choose to call it or not; doesn't matter
      // for latency measurement, the round-trip cost is the same.
      const echoSpec: ToolSpec = {
        name: 'noop_echo',
        description: 'No-op echo tool (returns input verbatim).',
        input_schema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      };
      const dispatcher = new SimpleToolDispatcher([
        {
          spec: echoSpec,
          handler: (input) => Promise.resolve(`echoed: ${JSON.stringify(input)}`),
        },
      ]);

      const key: SessionKey = { platform: 'telegram', chatId: 'perf', threadId: 't1' };
      const state: SessionState = {
        key,
        history: [],
        lastActivityMs: Date.now(),
        projectUuid: '00000000-0000-0000-0000-000000000001',
        packId: 'perf-pack',
        modelAlias: MODEL,
        turnInFlight: false,
      };

      const opts = {
        client,
        model: MODEL,
        systemPrompt:
          'You are a perf-test stub. Reply with the single token OK only. Do not call any tools.',
        tools: dispatcher.list(),
        dispatcher,
        maxTokens: 64,
        maxToolIterations: 2,
      };

      const cold: number[] = [];
      const warm: number[] = [];

      for (let i = 0; i < ITERATIONS; i++) {
        const text = `iter=${i} please reply OK`;
        const startedAt = Date.now();
        const result = await runAgentTurn(state, text, opts);
        const elapsed = Date.now() - startedAt;
        if (i === 0) cold.push(elapsed);
        else warm.push(elapsed);
        // Mutate state.history so the next iteration carries the previous
        // turn's context — that's what enables prompt-cache hits.
        state.history.push(...result.assistantEntries);
      }

      process.stdout.write(
        [
          '',
          '=== WAB.8 perf summary ===',
          `model=${MODEL}  iterations=${ITERATIONS}`,
          summarize('cold (1st)', cold),
          summarize('warm (2..N)', warm),
          '=== end ===',
          '',
        ].join('\n') + '\n',
      );

      // No hard expectations — perf gates are operator-judged via the
      // printed table against the WAB.8 §F targets (p50≤1s, p95≤2s, p99≤4s
      // on Haiku 4.5 warm). The test PASSES if the harness ran end-to-end.
    },
    { timeout: 10 * 60 * 1000 },
  );
});
