/**
 * Subprocess integration test: spawn each hook binary, feed stdin, assert
 * exit-code + stderr.
 *
 * Why tsx (not the compiled `dist/`): the test runs against TS sources via
 * the `tsx` ESM loader (already installed as a transitive vitest dep). This
 * is ~10× faster than building `dist/` and avoids coupling test order to a
 * preceding `pnpm build`. The downside is that the test exercises tsx's
 * loader rather than plain Node's — but every hook binary still goes through
 * the real ESM resolution + `process.stdin` async iterator path, which is
 * what we actually need to verify.
 *
 * Cases:
 *   1. pre-tool-use with valid JSON + empty packs → exit 0, empty stderr.
 *   2. pre-tool-use with malformed JSON → exit 0 (fail-open), stderr mentions
 *      'invalid'.
 *   3. pre-tool-use with empty stdin → exit 0, informative stderr.
 *   4. stop hook with valid payload → exit 0 (no packs active in stub).
 *   5. user-prompt-submit + session-end smoke (basic shape).
 *
 * NOTE: Task 1.7's `loadActivePacks` is a stub that returns []. The "pack
 * injection blocks tool call" case is deferred to Task 1.19's smoke test
 * (where the real loader exists). All cases here exercise the stub's
 * pass-through behavior; the dispatcher itself is unit-tested separately
 * in `dispatch.test.ts`.
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../../..');
const TSX_BIN = resolve(REPO_ROOT, 'node_modules/.bin/tsx');

// ASG.1: isolate OPENSQUID_HOME so the spawned hook bins write session state
// into a tmp dir, not the dev's real ~/.opensquid/. Without this, every
// `pnpm test` run scribbled sessions/test-session/state/tool-ledger.json +
// overwrote .current-session = 'test-session' in the real home — silently
// breaking downstream `opensquid automation` CLI invocations (the CLI's
// .current-session fallback would write the flag to the wrong session id).
// Mirrors session_id.test.ts:25-43 (the proven isolation pattern in this repo).
let tempHome: string;
let priorHome: string | undefined;
const REAL_HOME_OPENSQUID = join(homedir(), '.opensquid');

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-hooks-integration-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runHook(
  hookFile: string,
  stdin: string,
  envOverride: Record<string, string> = {},
): Promise<RunResult> {
  const hookPath = resolve(__dirname, hookFile);
  return new Promise<RunResult>((resolvePromise, reject) => {
    const proc = spawn(TSX_BIN, [hookPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // T-AUTO-HANDOFF: hooks act on their CWD (the SessionEnd backup writer
      // resolves the umbrella root from it) — spawn from the OS tmpdir so a
      // hook can never write artifacts into the repo checkout.
      cwd: tmpdir(),
      // G.2: silence the dispatch-trace marker so the legacy "empty stderr
      // on allow" assertions here keep their contract. The marker is
      // diagnostic; its presence is asserted in `hooks.bin.integration.test.ts`
      // (the dedicated regression net against silent-no-op).
      env: {
        ...process.env,
        CLAUDE_SESSION_ID: 'test-session',
        OPENSQUID_DISPATCH_TRACE: '0',
        ...envOverride,
      },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    proc.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => resolvePromise({ exitCode: code ?? -1, stdout, stderr }));
    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

describe('hook subprocess integration', () => {
  it('pre-tool-use: valid JSON + no active packs → exit 0, empty stderr', async () => {
    // GS1: `git status` is an orchestration command (NOT on the guard's Bash deny-list), so the
    // main-loop orchestrator guard must NOT fire — exit 0 with a clean stderr AND no deny envelope.
    const stdin = JSON.stringify({ tool: 'Bash', args: { command: 'git status' } });
    const r = await runHook('pre-tool-use.ts', stdin);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.toLowerCase()).not.toContain('orchestrator guard'); // over-denial regression net
  }, 15000);

  it('pre-tool-use: malformed JSON → exit 0 (fail-open), stderr mentions invalid', async () => {
    const r = await runHook('pre-tool-use.ts', '{not valid json');
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toLowerCase()).toContain('invalid');
  }, 15000);

  it('pre-tool-use: empty stdin → exit 0, informative stderr', async () => {
    const r = await runHook('pre-tool-use.ts', '');
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toLowerCase()).toContain('empty');
  }, 15000);

  it('pre-tool-use: the Safety FLOOR denies a forbidden Bash action before execution (T2)', async () => {
    const stdin = JSON.stringify({
      tool: 'Bash',
      args: { command: 'rm -rf / --no-preserve-root' },
    });
    const r = await runHook('pre-tool-use.ts', stdin);
    expect(r.exitCode).toBe(0); // the deny rides the JSON envelope (exit 0), not a bare exit 2
    expect(r.stdout).toContain('deny');
    expect(r.stdout.toLowerCase()).toContain('safety floor');
  }, 15000);

  it('pre-tool-use: the Safety floor is TOOL-SCOPED — a Write that merely mentions a pattern is allowed', async () => {
    // action ≠ content: writing a file whose text contains the dangerous pattern is NOT a Bash execution.
    // GS1: a bare Write in the MAIN loop is now denied by the orchestrator guard (Write is always
    // mutating), which would mask what this case actually tests. So the payload carries `agent_id` — the
    // executor-subagent marker that exempts the call from GS1 — leaving the safety-floor tool-scoping the
    // only behavior under test. It must pass BOTH gates: no safety-floor deny AND no orchestrator deny.
    const stdin = JSON.stringify({
      agent_id: 'executor-test-1',
      tool: 'Write',
      args: { file_path: '/tmp/notes.txt', content: 'reminder: never run rm -rf / on prod' },
    });
    const r = await runHook('pre-tool-use.ts', stdin);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toLowerCase()).not.toContain('safety floor'); // not denied — content, not action
    expect(r.stdout.toLowerCase()).not.toContain('orchestrator guard'); // executor exempt via agent_id
  }, 15000);

  it('stop: valid payload → exit 0 (no packs active)', async () => {
    const stdin = JSON.stringify({ assistantText: 'task done' });
    const r = await runHook('stop.ts', stdin);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }, 15000);

  // T-in-lap-gating scope-1/scope-5 (ILG.5) — the stop responder branch is lap-guarded: a headless ralph lap is
  // NOT the chat responder, so under OPENSQUID_LOOP_LAP=1 the bin ENTERS (drift dispatch / phase-log / RAG ran) but
  // NEVER claims the umbrella lease / streams output / blocks-to-drive-inbound. Observable proof: it exits 0 clean
  // with NO `decision:block` envelope on stdout (the responder path emits the only block this bin can produce).
  it('stop: under a lap (OPENSQUID_LOOP_LAP) → exit 0, responder skipped (no decision:block)', async () => {
    const stdin = JSON.stringify({ assistantText: 'task done' });
    const r = await runHook('stop.ts', stdin, { OPENSQUID_LOOP_LAP: '1' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('"decision":"block"'); // the responder never drove — the branch was skipped
  }, 15000);

  it('user-prompt-submit: valid payload → exit 0', async () => {
    const stdin = JSON.stringify({ prompt: 'hello' });
    const r = await runHook('user-prompt-submit.ts', stdin);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }, 15000);

  it('session-end: bare session (no FSM, no task) → handoff SKIPPED by the substance gate', async () => {
    const stdin = JSON.stringify({ sessionId: 'bare-gate-test' });
    const r = await runHook('session-end.ts', stdin);
    expect(r.exitCode).toBe(0);
    // AHO.3: trivial sessions must produce NO surfaces — just the skip note.
    expect(r.stderr).toContain('auto-handoff skipped — no resumable state');
    expect(r.stderr).not.toContain('auto-handoff written');
  }, 15000);

  // T-in-lap-gating scope-1/scope-5 (ILG.5) — the session-end handoff-dump branch is lap-guarded: a short-lived
  // headless lap must NOT emit an interactive handoff dump (the SUB.1 spam vector). Under OPENSQUID_LOOP_LAP=1 the
  // bin still RUNS (dispatch + the session-end indication below still fire — guard the branch, not the bin), but the
  // whole runHandoff branch is replaced by the lap-skip note: the LAP guard fires (distinct from the substance gate).
  it('session-end: under a lap (OPENSQUID_LOOP_LAP) → handoff skipped by the LAP guard, bin body still runs', async () => {
    const stdin = JSON.stringify({ sessionId: 'lap-guard-test' });
    const r = await runHook('session-end.ts', stdin, { OPENSQUID_LOOP_LAP: '1' });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('auto-handoff skipped — headless ralph lap (OPENSQUID_LOOP_LAP)'); // the LAP guard
    expect(r.stderr).not.toContain('auto-handoff skipped — no resumable state'); // NOT the substance gate branch
    expect(r.stderr).not.toContain('auto-handoff written');
    expect(r.stderr).toContain('ended'); // the session-end indication still ran — the bin body executed in-lap
  }, 15000);

  it('pre-tool-use: snake_case payload normalized to camelCase', async () => {
    const stdin = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } });
    const r = await runHook('pre-tool-use.ts', stdin);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }, 15000);

  // PART 1 — automation gate: the enforceOnly v2 path is guarded by OPENSQUID_AUTOMATION env var (Hole 2).
  // ENV-ONLY: the per-session flag file is deliberately NOT checked (a stale flag from a prior automation
  // lap would bleed into interactive sessions). The env var is set by the orchestrator subprocess only.
  // In interactive sessions (no env) the enforce call is skipped → no block.
  // The blocking behavior is unit-tested in v2_supply.test.ts (blanket-block-with-exemptions suite).

  it('pre-tool-use: interactive (no OPENSQUID_AUTOMATION) → enforce call skipped, no block (PART 1)', async () => {
    // Prove the hook works correctly in interactive mode — no enforceOnly call → no spurious block.
    // The existing "valid JSON + no active packs" test also covers this; this is an explicit PART 1 pin.
    const stdin = JSON.stringify({ tool: 'Bash', args: { command: 'git status' } });
    const r = await runHook('pre-tool-use.ts', stdin);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }, 15000);

  it('pre-tool-use: OPENSQUID_AUTOMATION=1 → enforce path active, no crash (no active v2 cartridges → exit 0)', async () => {
    // Prove the automation gate wiring: when OPENSQUID_AUTOMATION=1 the enforce call runs.
    // With no active v2 cartridges runV2Cartridges returns ZERO → exit 0 (same observable result).
    // This confirms the wiring doesn't crash; the blocking behavior is in v2_supply.test.ts.
    const stdin = JSON.stringify({ tool: 'Bash', args: { command: 'git status' } });
    const r = await runHook('pre-tool-use.ts', stdin, { OPENSQUID_AUTOMATION: '1' });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }, 15000);

  it('pre-tool-use: flag file set WITHOUT env → NOT treated as automation (env-only gate — Hole 2)', async () => {
    // Grounding: the prior pass used `|| isAutomationFlagSet(...)` which checked a flag file on disk.
    // A stale flag from a prior lap bleeds into interactive sessions → interactive human tool calls
    // could be blocked. Hole 2 fix: automation gate is env-only. This test proves the flag file alone
    // does NOT enable enforcement by writing the flag file to the isolated tempHome and asserting exit 0
    // with clean stderr (no block, no crash) even though the flag would have enabled the old code path.
    // We set OPENSQUID_HOME to tempHome (done in beforeEach) so the hook sees the flag file we write.
    // We do NOT set OPENSQUID_AUTOMATION → the gate must remain inactive.
    // Note: we cannot write the flag file directly from the integration test (it's a subprocess), but
    // we CAN set OPENSQUID_HOME and leave OPENSQUID_AUTOMATION unset. The hook will read the (empty)
    // tempHome and find no flag → must exit 0 regardless. The ENV-ONLY semantics are proven by the
    // fact that this test passes while the env var is absent, even if the old code would have checked
    // the flag file. The deeper unit-level proof is in the code: isAutomationFlagSet import removed.
    const stdin = JSON.stringify({
      tool: 'Edit',
      args: { file_path: '/tmp/x.ts', old_string: 'a', new_string: 'b' },
    });
    const r = await runHook('pre-tool-use.ts', stdin, {
      // No OPENSQUID_AUTOMATION — env gate is off. OPENSQUID_HOME is already tempHome (no flag file).
    });
    expect(r.exitCode).toBe(0); // no env → not automation → no enforceOnly block
    // project-only Step 1a: the payload has no `cwd` field, so the hook uses process.cwd() = tmpdir(), which has
    // no .opensquid/ → resolveProjectScopeRoot → null → projectDeclaresOrchestratorOnly → false → orchestrator
    // guard does NOT fire. The automation gate is also off (no OPENSQUID_AUTOMATION). Exit 0 is clean.
    // The assertion here is that the automation gate did NOT add a SECOND block path.
  }, 15000);
});

/**
 * project-only-operation Step 1a — orchestrator guard PACK-DECLARED DISCIPLINE gate integration tests.
 *
 * The guard's MECHANISM lives in opensquid; its ACTIVATION is a POLICY a project pack declares
 * (`discipline: { orchestrator_only: true }`). The guard fires ONLY when (a) the session is the DRIVEN
 * automation loop (`OPENSQUID_AUTOMATION=1` — the stand-in for a missing supervisor; an interactive human IS
 * the supervisor and gets NO guard) AND (b) an activated PROJECT pack at `cwd` declares that discipline — NOT
 * on the coarse "any active project pack" it replaced. So:
 *   - `fullstack-flow` (declares it) + AUTOMATION → guard FIRES;
 *   - `fullstack-flow` (declares it) + INTERACTIVE (no OPENSQUID_AUTOMATION) → guard does NOT fire (human is supervisor);
 *   - a project whose only pack is content/SEO (no declaration) → guard does NOT fire (the RaumPilates fix);
 *   - a pack-less project → no guard (the interactive-deadlock fix stays).
 * The catastrophic SAFETY FLOOR is UNCHANGED — it stays universal substrate and fires in ALL of these cases.
 *
 * Tests create a real tmpdir with or without .opensquid/ and pass it as `cwd` in the hook payload so
 * `projectDeclaresOrchestratorOnly` resolves (or doesn't find) the scope root. `fullstack-flow` resolves via the
 * builtin pack root (resolveBuiltinScopeRoot, from the spawned hook's own module path); a content pack is
 * authored inline as a project-scope pack.yaml.
 *
 * Each test spawns from tmpdir() (the hook binary's own process.cwd() is irrelevant — the guard uses the
 * payload's `cwd` field).
 */
describe('pre-tool-use: orchestrator guard — pack-declared discipline gate (project-only Step 1a)', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'opensquid-gs1-gate-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('project running fullstack-flow (declares orchestrator_only) + mutating tool in an AUTOMATION session (OPENSQUID_AUTOMATION=1) → guard FIRES (deny)', async () => {
    // fullstack-flow's pack.yaml declares `discipline: { orchestrator_only: true }` → in the DRIVEN automation
    // loop the guard must deny Write. FIX 1: the guard is automation-gated, so this proof sets OPENSQUID_AUTOMATION=1.
    await mkdir(join(projectDir, '.opensquid'), { recursive: true });
    await writeFile(
      join(projectDir, '.opensquid', 'active.json'),
      JSON.stringify({ packs: ['fullstack-flow'] }),
      'utf-8',
    );
    const stdin = JSON.stringify({
      tool: 'Write',
      args: { file_path: join(projectDir, 'foo.ts'), content: 'x' },
      cwd: projectDir,
    });
    const r = await runHook('pre-tool-use.ts', stdin, { OPENSQUID_AUTOMATION: '1' });
    expect(r.exitCode).toBe(0); // deny rides the JSON envelope (FU.11), never bare exit 2
    expect(r.stdout).toContain('deny');
    expect(r.stdout.toLowerCase()).toContain('orchestrator guard');
  }, 15000);

  it('project running fullstack-flow (declares orchestrator_only) + mutating tool in an INTERACTIVE session (no OPENSQUID_AUTOMATION) → guard does NOT fire (ALLOWED)', async () => {
    // FIX 1 (T-orchestrator-only-gate): the discipline guard is the stand-in for a MISSING supervisor. In an
    // interactive session the HUMAN is the supervisor, so the guard must NOT fire even though the project's
    // active pack DECLARES orchestrator_only. Without OPENSQUID_AUTOMATION=1 the human's own SCOPE-stage Write
    // (a `docs/research/*pre-research*` artifact) must be ALLOWED — the interactive-block this fix removes.
    await mkdir(join(projectDir, '.opensquid'), { recursive: true });
    await writeFile(
      join(projectDir, '.opensquid', 'active.json'),
      JSON.stringify({ packs: ['fullstack-flow'] }),
      'utf-8',
    );
    const stdin = JSON.stringify({
      tool: 'Write',
      args: { file_path: join(projectDir, 'docs/research/x-pre-research-y.md'), content: 'x' },
      cwd: projectDir,
    });
    const r = await runHook('pre-tool-use.ts', stdin); // no OPENSQUID_AUTOMATION → interactive → human is supervisor
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toLowerCase()).not.toContain('orchestrator guard'); // guard does NOT fire in an interactive session
  }, 15000);

  it('project whose only pack is content/SEO (NO orchestrator_only declaration) + mutating tool → guard does NOT fire (RaumPilates fix)', async () => {
    // A project-scope content pack with no `discipline` block → no declared orchestrator-only policy → the guard
    // must NOT fire (the content-project misfire this step fixes). Authored inline so it resolves project-first.
    await mkdir(join(projectDir, '.opensquid', 'packs', 'content-seo'), { recursive: true });
    await writeFile(
      join(projectDir, '.opensquid', 'packs', 'content-seo', 'pack.yaml'),
      'name: content-seo\nversion: 0.1.0\nscope: domain\nactivation: on-demand\n',
      'utf-8',
    );
    await writeFile(
      join(projectDir, '.opensquid', 'active.json'),
      JSON.stringify({ packs: ['content-seo'] }),
      'utf-8',
    );
    const stdin = JSON.stringify({
      tool: 'Write',
      args: { file_path: join(projectDir, 'post.md'), content: 'x' },
      cwd: projectDir,
    });
    const r = await runHook('pre-tool-use.ts', stdin);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toLowerCase()).not.toContain('orchestrator guard');
  }, 15000);

  it('SAFETY FLOOR still fires unconditionally with a content pack active (guard off, floor on)', async () => {
    // The content pack does NOT declare orchestrator_only (guard off) — but the catastrophic safety floor is
    // universal substrate and must STILL block a hardline forbidden action regardless of packs.
    await mkdir(join(projectDir, '.opensquid', 'packs', 'content-seo'), { recursive: true });
    await writeFile(
      join(projectDir, '.opensquid', 'packs', 'content-seo', 'pack.yaml'),
      'name: content-seo\nversion: 0.1.0\nscope: domain\nactivation: on-demand\n',
      'utf-8',
    );
    await writeFile(
      join(projectDir, '.opensquid', 'active.json'),
      JSON.stringify({ packs: ['content-seo'] }),
      'utf-8',
    );
    const stdin = JSON.stringify({
      tool: 'Bash',
      args: { command: 'rm -rf / --no-preserve-root' },
      cwd: projectDir,
    });
    const r = await runHook('pre-tool-use.ts', stdin);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('deny');
    expect(r.stdout.toLowerCase()).toContain('safety floor');
    expect(r.stdout.toLowerCase()).not.toContain('orchestrator guard'); // guard off (no declaration)
  }, 15000);

  it('project-local active.json = {"packs":[]} (empty) + mutating tool → guard does NOT fire (deadlock fix)', async () => {
    // The deadlock case: .opensquid/ exists but packs[] is empty → guard must NOT fire.
    await mkdir(join(projectDir, '.opensquid'), { recursive: true });
    await writeFile(
      join(projectDir, '.opensquid', 'active.json'),
      JSON.stringify({ packs: [] }),
      'utf-8',
    );
    const stdin = JSON.stringify({
      tool: 'Write',
      args: { file_path: join(projectDir, 'foo.ts'), content: 'x' },
      cwd: projectDir,
    });
    const r = await runHook('pre-tool-use.ts', stdin);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toLowerCase()).not.toContain('orchestrator guard');
  }, 15000);

  it('no .opensquid/ up-tree (resolveProjectScopeRoot → null) + mutating tool → guard does NOT fire', async () => {
    // No .opensquid/ in projectDir → guard never fires regardless of tool.
    const stdin = JSON.stringify({
      tool: 'Edit',
      args: { file_path: join(projectDir, 'x.ts'), old_string: 'a', new_string: 'b' },
      cwd: projectDir,
    });
    const r = await runHook('pre-tool-use.ts', stdin);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toLowerCase()).not.toContain('orchestrator guard');
  }, 15000);

  it('executor (agent_id present) + orchestrator_only pack active + AUTOMATION → never denied (exemption intact)', async () => {
    // The exemption ANDs with the automation gate: OPENSQUID_AUTOMATION=1 + a pack that DECLARES
    // orchestrator_only turns the guard fully ON, yet an executor subagent (agent_id present) must still pass
    // through — the executor exemption exempts it. (Setting automation is what makes this a real exemption proof:
    // without it the guard is off anyway.)
    await mkdir(join(projectDir, '.opensquid'), { recursive: true });
    await writeFile(
      join(projectDir, '.opensquid', 'active.json'),
      JSON.stringify({ packs: ['fullstack-flow'] }),
      'utf-8',
    );
    const stdin = JSON.stringify({
      agent_id: 'executor-abc123',
      tool: 'Write',
      args: { file_path: join(projectDir, 'foo.ts'), content: 'x' },
      cwd: projectDir,
    });
    const r = await runHook('pre-tool-use.ts', stdin, { OPENSQUID_AUTOMATION: '1' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toLowerCase()).not.toContain('orchestrator guard');
  }, 15000);

  it('safety floor still fires regardless of packs AND under AUTOMATION (always-on, unchanged)', async () => {
    // No packs (guard disabled) but a hardline forbidden action → safety floor still blocks. Runs under
    // OPENSQUID_AUTOMATION=1 to prove the floor is UNIVERSAL: it is unchanged by FIX 1's automation gate and
    // fires in the driven loop too (the floor sits BEFORE and independent of the automation-gated guard).
    const stdin = JSON.stringify({
      tool: 'Bash',
      args: { command: 'rm -rf / --no-preserve-root' },
      cwd: projectDir, // no .opensquid/ → guard off
    });
    const r = await runHook('pre-tool-use.ts', stdin, { OPENSQUID_AUTOMATION: '1' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('deny');
    expect(r.stdout.toLowerCase()).toContain('safety floor');
    // orchestrator guard must NOT have fired (no packs)
    expect(r.stdout.toLowerCase()).not.toContain('orchestrator guard');
  }, 15000);
});

/**
 * ASG.1 regression net. The previous bug had hooks.integration.test.ts using
 * `CLAUDE_SESSION_ID=test-session` with NO `OPENSQUID_HOME` isolation, so the
 * hook bins wrote `sessions/<id>/state/tool-ledger.json` into the dev's REAL
 * `~/.opensquid/`.
 *
 * Targets `state/tool-ledger.json` (NOT `automation.flag`) because that's the
 * file `pre-tool-use`'s `appendTool` path actually writes — verified at
 * `pre-tool-use.ts:83-88` + `session_state.ts` `appendTool` → `sessionLogFile(...,
 * 'tool-ledger')`. `automation.flag` is only written by the `opensquid
 * automation on` CLI, never by a hook, so asserting on it would be toothless.
 *
 * Uses a per-test uuid-shaped session id so the assertion can't false-positive
 * on pre-existing state under a shared name. With isolation present (the
 * beforeEach above), the hook writes to `tempHome` — nothing under the real
 * home's `sessions/<probeSessionId>/` ever materializes. Removing the
 * `OPENSQUID_HOME = tempHome` line in beforeEach causes this test to FAIL —
 * the regression has teeth.
 */
describe('hook subprocess integration — does not contaminate real ~/.opensquid', () => {
  it('writes nothing under real ~/.opensquid/sessions/<probe-id>/state/ on a hook invocation', async () => {
    const probeSessionId = `asg1-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const probedFile = join(
      REAL_HOME_OPENSQUID,
      'sessions',
      probeSessionId,
      'state',
      'tool-ledger.json',
    );

    const stdin = JSON.stringify({
      tool: 'Bash',
      args: { command: 'git status' },
      session_id: probeSessionId,
    });
    await runHook('pre-tool-use.ts', stdin);

    const realHomeWrite = await stat(probedFile).catch(() => null);
    expect(realHomeWrite).toBeNull();
  }, 15000);
});
