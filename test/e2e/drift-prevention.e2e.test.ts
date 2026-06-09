/**
 * G.13 — End-to-end drift-prevention test pass.
 *
 * Composite scenario test that walks the full G-track stack against the REAL
 * libSQL backend (RES-6: engine-free), REAL settings.json / .claude.json
 * mutation in a per-run tmpdir, and REAL compiled hook bins from
 * `dist/runtime/hooks/`. Gated by `E2E=1` (see `describe.skipIf`) because the
 * embedder + 9 composite scenarios run ~30–60s — prohibitive for every-push CI
 * but within the G.13 spec's <5min budget. CI runs via `workflow_dispatch`
 * (`.github/workflows/ci.yml`); local devs run `pnpm test:e2e`.
 *
 * Scenarios covered (9 of 10 per spec line 1940 — G.11 is audit-only per
 * spec line 1970): G.1 wizard hooks, G.2 dispatch marker, G.3 memorize/
 * store_lesson/forget round-trip, G.4 prompt-submit additionalContext,
 * G.5 freshness rule warn/silent, G.6 auto-memory import + dedup, G.7
 * auto-memory write deprecation warn, G.8 user-level MCP wiring, G.12
 * D9-guard automation-mode gating.
 *
 * Memory: G.3 seeds + G.4 recalls via the libSQL backend (createBackend +
 * resolveBackendConfig) — the cross-session recall path, engine-free.
 */

import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleForget } from '../../src/mcp/tools/forget.js';
import { handleMemorize } from '../../src/mcp/tools/memorize.js';
import { createBackend } from '../../src/rag/backend_factory.js';
import { resolveBackendConfig } from '../../src/rag/config.js';
import { handleStoreLesson } from '../../src/mcp/tools/store-lesson.js';
import { wedgeLessonStore } from '../../src/rag/wedge/store.js';
import { wedgeLessonsDbUrl, wedgeLessonsDir } from '../../src/rag/wedge/paths.js';
import {
  fetchExistingImportIndex,
  importAutoMemoryDir,
} from '../../src/setup/migrate/auto_memory_importer.js';
import { makeMemoryStore } from '../../src/setup/migrate/memory_store_handle.js';
import {
  writeOpensquidHooks,
  OPENSQUID_BIN_FOR_EVENT,
} from '../../src/setup/wizard/settings-writer.js';
import { writeOpensquidMcp } from '../../src/setup/wizard/mcp-writer.js';

import { DriftPreventionReport } from './drift-prevention-report.js';
import {
  REPO_ROOT,
  buildAutoMemoryDir,
  buildSangminPack,
  spawnHookBin,
} from './__util/scenario-fixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = resolve(__dirname, 'e2e-drift-prevention-report.md');

const E2E_GATE = process.env.E2E === '1';
const SKIP_E2E = !E2E_GATE;

// ----- Composite scenario block --------------------------------------------

describe.skipIf(SKIP_E2E)('G.13 — end-to-end drift prevention', () => {
  let tmpOpensquidHome: string;
  let tmpClaudeHome: string;
  let priorEnv: Record<string, string | undefined> = {};
  const report = new DriftPreventionReport();

  beforeAll(async () => {
    tmpOpensquidHome = await mkdtemp(join(tmpdir(), 'opensquid-e2e-'));
    tmpClaudeHome = await mkdtemp(join(tmpdir(), 'opensquid-e2e-claude-'));
    priorEnv = {
      OPENSQUID_HOME: process.env.OPENSQUID_HOME,
      LOOP_HOME: process.env.LOOP_HOME,
      OPENSQUID_AUTOMATION: process.env.OPENSQUID_AUTOMATION,
    };
    process.env.OPENSQUID_HOME = tmpOpensquidHome;
    process.env.LOOP_HOME = tmpOpensquidHome;
    await buildSangminPack(tmpOpensquidHome);
  }, 30_000);

  afterAll(async () => {
    await rm(tmpOpensquidHome, { recursive: true, force: true });
    await rm(tmpClaudeHome, { recursive: true, force: true });
    for (const [k, v] of Object.entries(priorEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await report.writeReport(REPORT_PATH);
    process.stderr.write(`[G.13] report written to ${REPORT_PATH}\n`);
  });

  // ------- Scenario helper: record + run -----------------------------------

  type Runner = () => Promise<void> | void;
  async function scenario(id: string, desc: string, runner: Runner): Promise<void> {
    const start = Date.now();
    try {
      await runner();
      report.recordScenario({
        id,
        description: desc,
        status: 'pass',
        durationMs: Date.now() - start,
        notes: '',
      });
    } catch (e) {
      report.recordScenario({
        id,
        description: desc,
        status: 'fail',
        durationMs: Date.now() - start,
        notes: (e as Error).message,
      });
      throw e;
    }
  }

  // ------- Scenarios -------------------------------------------------------

  it('G.1: wizard writes settings.json with @opensquid markers', async () => {
    await scenario('G.1', 'wizard writes settings.json with @opensquid markers', async () => {
      const settingsPath = join(tmpClaudeHome, 'settings.json');
      await writeFile(settingsPath, JSON.stringify({ hooks: {} }));
      const result = await writeOpensquidHooks(settingsPath);
      expect(result.added).toBe(4);
      const written = JSON.parse(await readFile(settingsPath, 'utf8')) as {
        hooks: Record<string, { hooks: { '@opensquid'?: boolean; command?: string }[] }[]>;
      };
      for (const event of Object.keys(OPENSQUID_BIN_FOR_EVENT)) {
        const groups = written.hooks[event] ?? [];
        const opensquidGroup = groups.find((g) => g.hooks.some((h) => h['@opensquid'] === true));
        expect(
          opensquidGroup,
          `event ${event} should have an @opensquid-marked group`,
        ).toBeDefined();
      }
    });
  }, 30_000);

  it('G.2: hook bins emit [opensquid-dispatch] marker on stderr', async () => {
    await scenario('G.2', 'hook bins emit dispatch marker', async () => {
      // Use a fresh OPENSQUID_HOME for this scenario so the active pack
      // doesn't influence the marker shape (rules=N would shift).
      const isolated = await mkdtemp(join(tmpdir(), 'opensquid-e2e-g2-'));
      try {
        const r = await spawnHookBin(
          'stop.js',
          JSON.stringify({ session_id: 'g13-g2', stop_hook_active: false }),
          { OPENSQUID_HOME: isolated, LOOP_HOME: isolated },
        );
        expect(r.exitCode).toBe(0);
        expect(r.stderr).toContain('[opensquid-dispatch]');
        expect(r.stderr).toContain('event=stop');
      } finally {
        await rm(isolated, { recursive: true, force: true });
      }
    });
  }, 30_000);

  it('G.3: memorize/store_lesson/forget MCP tools round-trip', async () => {
    await scenario('G.3', 'memorize/store_lesson/forget round-trip', async () => {
      const mem = await handleMemorize(
        {
          description: 'g13 round-trip memory',
          content: 'G.13 round-trip body. Should survive forget(force=true).',
          scope: 'user',
          authored_by: 'user',
          origin_label: 'explicit',
          // T-CTX-LOOP CTX.0 verify-probe gate. Synthetic e2e quote — the test
          // simulates the user's verbatim confirmation that would normally
          // accompany an agent-driven memorize call.
          verified: true,
          confirmed_quote: 'e2e fixture: synthetic verbatim user confirmation',
        },
        createBackend(await resolveBackendConfig()),
      );
      expect(mem.id).toMatch(/.+/);
      // RES-3c: store_lesson is now backed by the wedge store (engine-free).
      const wStore = wedgeLessonStore({ dbUrl: wedgeLessonsDbUrl(), sourceDir: wedgeLessonsDir() });
      await wStore.init();
      const lesson = await handleStoreLesson(
        {
          description: 'g13 round-trip lesson',
          content: 'G.13 round-trip lesson body',
          classification: 'workflow',
          source_signal: 'g13_e2e',
        },
        wStore,
      );
      expect(lesson.id).toMatch(/.+/);
      expect(lesson.status).toBe('pending');
      const del = await handleForget(
        { id: mem.id, force: true },
        createBackend(await resolveBackendConfig()),
      );
      expect(del.deleted).toBe(true);
      expect(del.forced).toBe(true);
    });
  }, 30_000);

  it('G.4: prompt-submit emits hookSpecificOutput.additionalContext', async () => {
    await scenario('G.4', 'prompt-submit emits additionalContext envelope', async () => {
      // RES-6: recall is libSQL (engine-free) — seed + search via the same backend.
      const backend = createBackend(await resolveBackendConfig());
      // Seed a memory the recall will surface for the prompt below.
      const marker = `OPENSQUID_G13_MARKER_${String(Date.now())}`;
      await handleMemorize(
        {
          description: `G.13 marker memory ${marker} for recall pre-inject`,
          content: `${marker}: golden answer for the G.13 e2e recall pre-injection test. The recall_pre_inject primitive should find this entry and surface it as additionalContext.`,
          scope: 'user',
          authored_by: 'user',
          origin_label: 'explicit',
          // T-CTX-LOOP CTX.0 verify-probe gate (synthetic e2e quote).
          verified: true,
          confirmed_quote: 'e2e fixture: synthetic verbatim user confirmation',
        },
        backend,
      );
      // Poll recall ~3s — semantic-index writes are async vs the store ack.
      const query = `what was the ${marker} golden answer for the recall pre-injection test (need at least 20 chars)?`;
      let inProcHits = 0;
      const pollDeadline = Date.now() + 3000;
      while (Date.now() < pollDeadline) {
        const search = await backend.recall(query, 5, { namespace: null });
        if (search.length > 0) {
          inProcHits = search.length;
          break;
        }
        await new Promise<void>((r) => setTimeout(r, 100));
      }
      if (inProcHits === 0) {
        throw new Error(
          `libSQL recall returned 0 hits for marker ${marker} after 3s — embedder/RAG backend not operational; check the fastembed/libSQL config`,
        );
      }
      const r = await spawnHookBin(
        'user-prompt-submit.js',
        JSON.stringify({ prompt: query, session_id: 'g13-g4' }),
      );
      expect(r.exitCode).toBe(0);
      expect(
        r.stdout,
        `expected JSON envelope (in-process search found ${String(inProcHits)} hits); stderr: ${r.stderr}`,
      ).toContain('hookSpecificOutput');
      expect(r.stdout).toContain('additionalContext');
    });
  }, 30_000);

  it('G.5: drift phrase without verification warns; with verification silent', async () => {
    await scenario('G.5', 'drift-phrase freshness rule (warn / silent)', async () => {
      // No verification tools called → drift phrase should warn.
      const noVerify = await spawnHookBin(
        'stop.js',
        JSON.stringify({
          session_id: 'g13-g5-warn',
          assistant_text: 'per memory the spec said the feature is deferred',
        }),
      );
      expect(noVerify.stderr).toContain('opensquid drift-flag');

      // Simulate a verification tool earlier this turn. Append to the per-
      // turn ledger by spawning pre-tool-use (Read tool), then stop.
      await spawnHookBin(
        'pre-tool-use.js',
        JSON.stringify({
          tool_name: 'Read',
          tool_input: { file_path: '/tmp/g13.txt' },
          session_id: 'g13-g5-verify',
        }),
      );
      const verified = await spawnHookBin(
        'stop.js',
        JSON.stringify({
          session_id: 'g13-g5-verify',
          assistant_text: 'per memory the spec said the feature is deferred',
        }),
      );
      expect(verified.stderr).not.toContain('opensquid drift-flag');
    });
  }, 30_000);

  it('G.6: auto-memory import succeeds + is idempotent on re-run', async () => {
    await scenario('G.6', 'auto-memory import + dedup on re-run', async () => {
      // RES-5b: the auto-memory path is engine-free — it uses the libSQL MemoryStore. This exercises
      // the real store (incl the origin:import: marker tag round-trip via listImportIndex).
      const autoDir = join(tmpClaudeHome, 'projects', 'g13-fixture', 'memory');
      await buildAutoMemoryDir(autoDir, 3);
      const store = await makeMemoryStore();
      try {
        const existing = await fetchExistingImportIndex(store);
        const first = await importAutoMemoryDir(autoDir, store, {
          dryRun: false,
          existingIndex: existing,
        });
        expect(first.imported).toBe(3);
        expect(first.skipped).toBe(0);
        // Re-run: same files, same names + unchanged content → all 3 should dedupe (skip).
        const existing2 = await fetchExistingImportIndex(store);
        const second = await importAutoMemoryDir(autoDir, store, {
          dryRun: false,
          existingIndex: existing2,
        });
        expect(second.imported).toBe(0);
        expect(second.skipped).toBe(3);
      } finally {
        await store.close();
      }
    });
  }, 30_000);

  it('G.7: Write to auto-memory path → deprecation warn', async () => {
    await scenario('G.7', 'auto-memory write deprecation warn', async () => {
      const r = await spawnHookBin(
        'pre-tool-use.js',
        JSON.stringify({
          tool_name: 'Write',
          tool_input: {
            file_path: join(homedir(), '.claude/projects/-foo/memory/g13.md'),
            content: 'fake auto-memory content',
          },
          session_id: 'g13-g7',
        }),
      );
      // The skill emits `warn`, which today routes through the dispatcher's
      // hard-coded `block_tool` default policy → exit code 2 + stderr message.
      // The load-bearing assertion is the message text, NOT the exit code.
      expect(r.stderr.toLowerCase()).toMatch(/prefer mcp__opensquid__memorize|auto-memory/);
    });
  }, 30_000);

  it('G.8: user-level MCP wiring (~/.claude.json) registers correctly', async () => {
    await scenario('G.8', 'user-level MCP wiring', async () => {
      const claudeJson = join(tmpClaudeHome, '.claude.json');
      await writeFile(claudeJson, JSON.stringify({ mcpServers: {} }));
      const result = await writeOpensquidMcp(claudeJson, REPO_ROOT);
      expect(result.added.length + result.replaced.length).toBe(2);
      const written = JSON.parse(await readFile(claudeJson, 'utf8')) as {
        mcpServers: Record<string, { command?: string; args?: string[]; '@opensquid'?: boolean }>;
      };
      expect(written.mcpServers.opensquid?.['@opensquid']).toBe(true);
      expect(written.mcpServers['opensquid-chat']?.['@opensquid']).toBe(true);
      expect(written.mcpServers.opensquid?.args?.[0]).toMatch(/dist\/mcp\/server\.js$/);
    });
  }, 30_000);

  it('G.12: D9-guard llm_classify gated on OPENSQUID_AUTOMATION flag', async () => {
    await scenario('G.12', 'D9-guard automation-mode gating', async () => {
      // Stub `fast_classifier` so llm_classify completes (instead of silently
      // clamping to UNCERTAIN on missing models.yaml). G.13 finding: without
      // this stub the gate fires invisibly because llm_classify clamps errors
      // → UNCERTAIN silently AND the dispatcher drops `kind: 'error'` rule
      // results without stderr. The stub proves the GATING WORKS when the
      // LLM call doesn't fail upstream.
      const modelStub = JSON.stringify({
        fast_classifier: { mode: 'subscription', impl: 'cli', cli: 'echo', args: ['BLOCK'] },
      });
      const stop = (sid: string, env: Record<string, string>): Promise<{ stderr: string }> =>
        spawnHookBin(
          'stop.js',
          JSON.stringify({ session_id: sid, assistant_text: 'Should I run the build for you?' }),
          { OPENSQUID_MODELS_CONFIG_INLINE: modelStub, ...env },
        );
      const noAuto = await stop('g13-g12-off', {});
      expect(noAuto.stderr).toContain('[opensquid-dispatch]');
      expect(noAuto.stderr).not.toContain('D9-guard:');
      const withAuto = await stop('g13-g12-on', { OPENSQUID_AUTOMATION: '1' });
      expect(
        withAuto.stderr,
        `expected D9-guard verdict under automation; stderr: ${withAuto.stderr}`,
      ).toContain('D9-guard');
    });
  }, 30_000);
});
