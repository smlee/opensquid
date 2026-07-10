/**
 * T-codex-e2e-setup CE.4 — the Codex `config.toml` MCP writer (CE.1) + `required` emit (CE.2).
 *
 * Asserts by PARSING the written TOML (`smol-toml` stringify formatting is NOT contractual — a formatting
 * change must not break the test; a semantic regression must). Covers: first-run registration + required on
 * opensquid only, idempotent re-run, preservation of foreign tables AND the pre-existing UNFENCED manual
 * `[mcp_servers.opensquid]` (no duplicate-table error), the `--opensquid-root` override, no env table by default.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';

import {
  projectCodexMcp,
  readCodexConfig,
  writeCodexMcp,
  type CodexConfig,
} from './codex-mcp-writer.js';

/** A typed view over the parsed TOML — enough to assert the semantic shape without `any`. */
interface EntryView {
  command?: string;
  args?: string[];
  required?: boolean;
  env?: Record<string, string>;
  type?: string;
  '@opensquid'?: boolean;
}
interface CfgView {
  features?: { web_search?: boolean };
  mcp_servers?: Record<string, EntryView>;
}

let tmp: string;
let cfgPath: string;
const read = (): CfgView => parseToml(readFileSync(cfgPath, 'utf-8'));
const srv = (cfg: CfgView, name: string): EntryView => cfg.mcp_servers?.[name] ?? {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'codex-mcp-writer-'));
  cfgPath = join(tmp, 'config.toml');
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('writeCodexMcp — first-run registration (CE.1/CE.2)', () => {
  it('creates [mcp_servers.opensquid] (required + marker) + [mcp_servers.opensquid-chat] (NOT required)', async () => {
    // ENOENT config → first-run.
    const res = await writeCodexMcp(cfgPath);
    const cfg = read();
    expect(srv(cfg, 'opensquid').command).toBe('opensquid-mcp'); // buildDesiredEntries SSOT (shipped bin)
    expect(srv(cfg, 'opensquid').required).toBe(true); // CE.2 — required on opensquid
    expect(srv(cfg, 'opensquid')['@opensquid']).toBe(true); // ownership marker
    expect(srv(cfg, 'opensquid-chat').command).toBe('opensquid-chat-bridge-mcp');
    expect(srv(cfg, 'opensquid-chat').required).toBeUndefined(); // NOT required (optional telemetry)
    expect(srv(cfg, 'opensquid-chat')['@opensquid']).toBe(true);
    expect(res.added.sort()).toEqual(['opensquid', 'opensquid-chat']);
    expect(res.replaced).toEqual([]);
    expect(res.backupPath).toBe(`${cfgPath}.bak`);
  });

  it('drops the JSON `type` field (Codex infers stdio from command)', async () => {
    await writeCodexMcp(cfgPath);
    expect(srv(read(), 'opensquid').type).toBeUndefined();
  });

  it('emits NO [mcp_servers.<id>.env] table by default (env locked empty)', async () => {
    await writeCodexMcp(cfgPath);
    const cfg = read();
    expect(srv(cfg, 'opensquid').env).toBeUndefined();
    expect(srv(cfg, 'opensquid-chat').env).toBeUndefined();
  });
});

describe('writeCodexMcp — idempotent re-run (CE.1)', () => {
  it('a second run REPLACES the two opensquid tables, adds nothing, and is deep-equal', async () => {
    await writeCodexMcp(cfgPath);
    const first = read();
    const res = await writeCodexMcp(cfgPath);
    expect(res.added).toEqual([]);
    expect(res.replaced.sort()).toEqual(['opensquid', 'opensquid-chat']);
    expect(read()).toEqual(first); // no duplicate tables, byte-stable after the first write
  });
});

describe('writeCodexMcp — preservation (CE.1)', () => {
  it('preserves [features] + a foreign [mcp_servers.other], and REPLACES a pre-existing UNFENCED manual opensquid table', async () => {
    // The §2.1 hazard: a manually-seeded UNFENCED [mcp_servers.opensquid] with no marker. A naive fence-append
    // would emit a duplicate table (a TOML error); the parse round-trip REPLACES it correctly.
    writeFileSync(
      cfgPath,
      '[features]\nweb_search = true\n\n[mcp_servers.opensquid]\ncommand = "old-broken"\n\n[mcp_servers.other]\ncommand = "x"\n',
    );
    const res = await writeCodexMcp(cfgPath);
    const cfg = read();
    expect(cfg.features?.web_search).toBe(true); // foreign top-level table preserved
    expect(srv(cfg, 'other').command).toBe('x'); // foreign server preserved
    expect(srv(cfg, 'opensquid').command).toBe('opensquid-mcp'); // manual table REPLACED (marker now present)
    expect(srv(cfg, 'opensquid').required).toBe(true);
    expect(srv(cfg, 'opensquid')['@opensquid']).toBe(true);
    expect(res.replaced).toContain('opensquid'); // the manual table counted as a replace, not an add
    expect(res.preserved).toBe(1); // only `other` is unrelated
  });

  it('writes a .bak snapshot of the PRIOR config before mutating', async () => {
    writeFileSync(cfgPath, '[features]\nweb_search = true\n');
    await writeCodexMcp(cfgPath);
    const bak = parseToml(readFileSync(`${cfgPath}.bak`, 'utf-8')) as unknown as CfgView;
    expect(bak.features?.web_search).toBe(true); // the .bak is the pre-mutation snapshot
    expect(bak.mcp_servers).toBeUndefined(); // opensquid tables not yet present in the snapshot
  });
});

describe('writeCodexMcp — --opensquid-root override (CE.1)', () => {
  it('a root forces the `node <root>/dist/mcp/server.js` form (via buildDesiredEntries)', async () => {
    await writeCodexMcp(cfgPath, '/opt/opensquid');
    const cfg = read();
    expect(srv(cfg, 'opensquid').command).toBe('node');
    expect(srv(cfg, 'opensquid').args).toEqual(['/opt/opensquid/dist/mcp/server.js']);
    expect(srv(cfg, 'opensquid-chat').args).toEqual([
      '/opt/opensquid/dist/mcp/chat-bridge-server.js',
    ]);
  });
});

describe('projectCodexMcp — pure projection (CE.1)', () => {
  it('is disk-untouched and reports added/replaced/preserved from an in-memory config', () => {
    const input: CodexConfig = {
      mcp_servers: { other: { command: 'x' }, opensquid: { command: 'stale' } },
    };
    const { output, added, replaced, preserved } = projectCodexMcp(input);
    expect(added).toEqual(['opensquid-chat']); // opensquid existed → replaced; chat is new → added
    expect(replaced).toEqual(['opensquid']);
    expect(preserved).toBe(1); // `other`
    expect(output.mcp_servers?.opensquid?.required).toBe(true);
    expect(input.mcp_servers?.opensquid?.command).toBe('stale'); // input NOT mutated (deep clone)
  });
});

describe('readCodexConfig (CE.1)', () => {
  it('ENOENT → {} (first-run)', async () => {
    expect(await readCodexConfig(join(tmp, 'nope.toml'))).toEqual({});
  });

  it('parses an existing TOML config', async () => {
    writeFileSync(cfgPath, '[features]\nx = 1\n');
    expect(await readCodexConfig(cfgPath)).toEqual({ features: { x: 1 } });
  });
});
