/**
 * T-codex-e2e-setup CE.4 element 5 — the OPT-IN LIVE acceptance (integration-codex-cli.md §7 "tests pass ≠
 * works"; the ask's BINDING LIVE bar). SKIPPED unless OPENSQUID_CODEX_LIVE=1 — it spawns the REAL `codex exec
 * --json` against the pinned binary (needs Codex installed + authed), kept OUT of hermetic CI exactly like
 * `codex_live.test.ts`. A green UNIT suite does NOT prove either property here (design §7: "a green vitest
 * proves none of these"); this is the acceptance authority, asserted on the real binary when present.
 *
 * Run locally:
 *   OPENSQUID_CODEX_LIVE=1 pnpm vitest run src/runtime/ralph/harnesses/codex_e2e_live.test.ts
 *
 * Two properties:
 *   (a) configured-MCP → the opensquid MCP registered via `writeCodexMcp` into a temp $CODEX_HOME/config.toml is
 *       LOADED by `codex exec` — the server starts (a Codex lap set up through opensquid can reach the
 *       work-graph, not run item-blind). The end-to-end workgraph_get → enforced stage → checkpoint → typed exit
 *       → close is driven by a full ralph lap on a scratch item; the real-binary-testable floor asserted here is
 *       that the required opensquid server initializes so the lap is NOT item-blind.
 *   (b) `required` fail-loud — an opensquid server marked `required = true` but pointed at an UNREACHABLE command
 *       makes `codex exec` FAIL-LOUD (non-zero) rather than run item-blind, confirming `required` is honored on
 *       the non-interactive path (the §2.1 residual). If a future binary does NOT honor it, the recorded finding
 *       is the LIVE decision point for CE.2's named `codex mcp list --json` reachability-probe degrade.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';

import { writeCodexMcp } from '../../../setup/wizard/codex-mcp-writer.js';

const LIVE = process.env.OPENSQUID_CODEX_LIVE === '1';

describe.skipIf(!LIVE)('codex e2e LIVE acceptance (opt-in, real binary)', () => {
  let codexHome: string;
  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), 'codex-e2e-'));
    // Provision the machine's REAL credential into the temp $CODEX_HOME so `codex exec` can authenticate — the
    // temp home holds only the config.toml `writeCodexMcp` wrote, and a ChatGPT/keyring login lives in the
    // machine's real CODEX_HOME (?? ~/.codex) `auth.json` (env keys already flow via `...process.env`). Without
    // this, property (a) 401s at the API before the opensquid MCP init is even exercised. This is BENIGN for
    // property (b): a `required` server pointed at a bogus bin fails at startup regardless of auth.
    const realAuth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
    if (existsSync(realAuth)) copyFileSync(realAuth, join(codexHome, 'auth.json'));
  });
  afterEach(() => {
    rmSync(codexHome, { recursive: true, force: true });
  });

  const exec = (prompt: string): SpawnSyncReturns<string> =>
    spawnSync(
      'codex',
      ['exec', '--json', '--sandbox', 'read-only', '-c', 'approval_policy=never', '-'],
      {
        input: prompt,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, CODEX_HOME: codexHome },
      },
    );

  interface CfgView {
    mcp_servers?: Record<string, { required?: boolean }>;
  }

  it('(a) the opensquid MCP registered by writeCodexMcp is LOADED by codex exec (not item-blind)', async () => {
    // Register the real shipped-bin opensquid servers into the temp $CODEX_HOME/config.toml.
    // Use the repo root so `node <root>/dist/mcp/server.js` is reachable without a global install.
    const repoRoot = join(__dirname, '..', '..', '..', '..');
    const cfgPath = join(codexHome, 'config.toml');
    await writeCodexMcp(cfgPath, repoRoot);
    const cfg = parseToml(readFileSync(cfgPath, 'utf-8')) as unknown as CfgView;
    expect(cfg.mcp_servers?.opensquid?.required).toBe(true); // the required opensquid server is configured
    const res = exec('Reply with exactly: OK');
    expect(res.error).toBeUndefined(); // codex ran (installed/authed) — the opensquid MCP init did not block it
    expect(res.status).toBe(0); // the required server initialized → the lap is NOT item-blind
  }, 130_000);

  it('(b) a required=true opensquid server with an UNREACHABLE command makes codex exec fail-loud', async () => {
    // A bogus root → `node <bogus>/dist/mcp/server.js` cannot start → required init fails.
    const cfgPath = join(codexHome, 'config.toml');
    await writeCodexMcp(cfgPath, '/nonexistent-opensquid-root');
    const res = exec('Reply with exactly: OK');
    // Honored → non-zero / init-failure diagnostic. If a future binary ignores `required` non-interactively,
    // record the finding here (status 0 despite an unreachable required server) — the CE.2 probe-degrade cue.
    expect(res.status).not.toBe(0);
  }, 130_000);
});
