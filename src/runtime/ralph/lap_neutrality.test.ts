/**
 * MHL.8 — the audit-grep-empty acceptance: the machine-checkable "nothing hardcoded" contract (mirrors
 * subscription_cli.ts:8-9). The NEUTRAL core carries NO vendor INVOCATION/ENVELOPE literal — every such literal
 * lives ONLY under src/runtime/ralph/harnesses/** (the adapters) + the config schema.
 *
 * NOTE (CODE decision, citing MHL.3's neutrality note): the deny-list is the vendor INVOCATION/ENVELOPE literal
 * set (flags + envelope field names), NOT the bare `kind` discriminators 'claude'/'codex'. The resolver
 * legitimately dispatches on those discriminator VALUES — exactly like dispatcher.ts branches on the
 * user-supplied `provider === 'anthropic' | 'openai'` — so they are a legitimate dispatch point, not a vendor
 * literal (MHL.8's listing of bare `codex` is corrected here to the discriminator-exclusion the design intends).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO, rel), 'utf8');

/** Vendor INVOCATION (flags) + ENVELOPE (raw JSON/JSONL field) literals — must NOT survive in the neutral core. */
const VENDOR_LITERALS = [
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--output-format',
  '--sandbox',
  '--json',
  'total_cost_usd',
  'is_error',
  'input_tokens',
  'output_tokens',
  'agent_message',
  'turn.completed',
  'item.completed',
  'workspace-write',
  'approval_policy',
];

/** The makeSpawnLap function body (the neutral region of ralph.ts — the rest of the file wires unrelated CLI). */
function makeSpawnLapRegion(): string {
  const src = read('src/setup/cli/ralph.ts');
  const start = src.indexOf('export function makeSpawnLap');
  const end = src.indexOf('export const daemonChatSend');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('audit-grep-empty over the neutral lap core (MHL.8)', () => {
  const neutralSurfaces: Record<string, () => string> = {
    'lap_harness.ts (the resolver/seam)': () => read('src/runtime/ralph/lap_harness.ts'),
    'lap_outcome.ts (the neutral fold)': () => read('src/runtime/ralph/lap_outcome.ts'),
    'ralph.ts makeSpawnLap (the wire)': makeSpawnLapRegion,
  };

  for (const [name, load] of Object.entries(neutralSurfaces)) {
    it(`${name} contains NO vendor invocation/envelope literal`, () => {
      const body = load();
      const hits = VENDOR_LITERALS.filter((lit) => body.includes(lit));
      expect(hits).toEqual([]);
    });
  }

  it('the vendor literals DO live in the adapters (positive control — the neutrality is a real move, not vacuous)', () => {
    const claude = read('src/runtime/ralph/harnesses/claude_lap_harness.ts');
    const codex = read('src/runtime/ralph/harnesses/codex_lap_harness.ts');
    // Claude invocation/envelope literals home in its adapter.
    expect(claude).toContain('--dangerously-skip-permissions');
    expect(claude).toContain('total_cost_usd');
    expect(claude).toContain('is_error');
    // Codex invocation/envelope literals home in its adapter.
    expect(codex).toContain('--json');
    expect(codex).toContain('agent_message');
    expect(codex).toContain('approval_policy');
    expect(codex).toContain('workspace-write');
  });
});
