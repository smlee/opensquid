import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { materializePackAuditPolicy } from '../../functions/audit_policy.js';
import { auditDeclarationCacheHash, auditLensPolicyHash } from '../../functions/cached_audit.js';
import { readRubricContent } from '../../functions/read_rubric.js';
import { readGitWorkingTreeDiff } from '../../functions/staged_diff.js';
import { loadPack } from '../../packs/loader.js';
import { loadActivePacksForDispatch } from '../../runtime/bootstrap.js';
import { advanceFsmState } from '../../runtime/fsm_state.js';
import { sha256Hex } from '../../runtime/durable/run_id.js';
import { writeTaskAuditCache } from '../../runtime/loop/task_audit_cache.js';
import { recordSuite } from '../../runtime/loop/verification.js';
import { recordSessionCwd, writeActiveTask } from '../../runtime/session_state.js';
import { appendPhase, REQUIRED_PHASES } from '../../runtime/workflow_phases.js';

import { readAttestedShas } from './attestations.js';
import {
  commitAllowedNow,
  configuredLocalBranch,
  isGatedRepo,
  runAttest,
  runCommitMsgGate,
  runGate,
} from './gate.js';

// GDC.1 — every gate call injects the env explicitly (ambient env must never
// decide: CI runners carry no agent marker, the authoring session carries
// several — the pin-ambient-state-in-fixtures discipline).
const AGENT_ENV = { AI_AGENT: '1' } as NodeJS.ProcessEnv;
const HUMAN_ENV = {} as NodeJS.ProcessEnv;

const execFileP = promisify(execFile);
const SID = 'gate-test-session';
const NOW = '2026-06-04T00:00:00.000Z';

/** Write exact active-pack CODE evidence for `certifiedDiff`; undefined deliberately creates legacy evidence. */
async function writeCodeAudit(
  verdict: string,
  certifiedDiff?: string,
  identityTimeoutMs?: number,
): Promise<void> {
  process.env.OPENSQUID_ITEM_ID = 't1';
  if (certifiedDiff === undefined) {
    await writeTaskAuditCache(SID, 'fullstack-flow-code-audit-cache', {
      hash: '0'.repeat(64),
      verdict,
    });
    return;
  }
  const rubric = await readRubricContent('code', 'fullstack-flow');
  if (rubric === null) throw new Error('missing code rubric');
  const policy = materializePackAuditPolicy(
    await loadActivePacksForDispatch(SID, repo),
    'fullstack-flow',
    'fullstack-flow-code-audit-cache',
    rubric,
    certifiedDiff,
  );
  if (policy === null) throw new Error('missing code policy');
  const promptHash = (lens: (typeof policy.lenses)[number]): string =>
    auditLensPolicyHash({
      model: policy.model,
      lens,
      passVerdict: policy.passVerdict,
      failVerdict: policy.failVerdict,
      timeoutMs: identityTimeoutMs ?? policy.timeoutMs,
    });
  await writeTaskAuditCache(SID, policy.cacheKey, {
    hash: auditDeclarationCacheHash({
      model: policy.model,
      lenses: policy.lenses,
      passVerdict: policy.passVerdict,
      failVerdict: policy.failVerdict,
      timeoutMs: identityTimeoutMs ?? policy.timeoutMs,
      subject: policy.subject,
    }),
    complete: true,
    passVerdict: policy.passVerdict,
    failVerdict: policy.failVerdict,
    subjectHash: sha256Hex(certifiedDiff),
    lenses: policy.lenses.map((lens) => ({
      id: lens.id,
      promptHash: promptHash(lens),
      output: verdict,
    })),
  });
}

async function writePartialCodeAudit(certifiedDiff: string): Promise<void> {
  process.env.OPENSQUID_ITEM_ID = 't1';
  const rubric = await readRubricContent('code', 'fullstack-flow');
  if (rubric === null) throw new Error('missing code rubric');
  const policy = materializePackAuditPolicy(
    await loadActivePacksForDispatch(SID, repo),
    'fullstack-flow',
    'fullstack-flow-code-audit-cache',
    rubric,
    certifiedDiff,
  );
  if (policy === null) throw new Error('missing code policy');
  await writeTaskAuditCache(SID, policy.cacheKey, {
    hash: auditDeclarationCacheHash({
      model: policy.model,
      lenses: policy.lenses,
      passVerdict: policy.passVerdict,
      failVerdict: policy.failVerdict,
      timeoutMs: policy.timeoutMs,
      subject: policy.subject,
    }),
    complete: false,
    passVerdict: policy.passVerdict,
    failVerdict: policy.failVerdict,
    subjectHash: sha256Hex(certifiedDiff),
    lenses: policy.lenses.slice(0, -1).map((lens) => ({
      id: lens.id,
      promptHash: auditLensPolicyHash({
        model: policy.model,
        lens,
        passVerdict: policy.passVerdict,
        failVerdict: policy.failVerdict,
        timeoutMs: policy.timeoutMs,
      }),
      output: `VERDICT: ${policy.passVerdict}`,
    })),
    failures: [{ id: policy.lenses.at(-1)!.id, error: 'reviewer timed out' }],
  });
}

/** Give the repo a HEAD (so `git diff HEAD` resolves) + point the session cwd at it (so the gate's stagedDiff
 *  reads this repo) — the preconditions for the GFR.2-hard staleness check to run on the real diff. */
async function armStalenessRepo(): Promise<void> {
  await recordSessionCwd(SID, repo);
  await git(['commit', '--allow-empty', '-q', '-m', 'init'], repo);
}

let tempHome: string;
let repo: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'OPENSQUID_HOME',
  'OPENSQUID_SESSION_ID',
  'OPENSQUID_ITEM_ID',
  'OPENSQUID_PROJECT_ROOT',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PROJECT_DIR',
];

async function git(args: string[], cwd: string): Promise<void> {
  await execFileP('git', args, { cwd });
}

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-gate-home-'));
  repo = await mkdtemp(join(tmpdir(), 'opensquid-gate-repo-'));
  process.env.OPENSQUID_HOME = tempHome;
  process.env.OPENSQUID_SESSION_ID = SID; // resolveMcpSessionId precedence #2 (deterministic)
  await git(['init', '-q'], repo);
  await git(['config', 'user.email', 't@t'], repo);
  await git(['config', 'user.name', 't'], repo);
  await writeFile(join(repo, '.git', 'info', 'exclude'), '.opensquid/\n', 'utf8');
  process.env.OPENSQUID_PROJECT_ROOT = repo;
  await mkdir(join(repo, '.opensquid'), { recursive: true });
});
afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(tempHome, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

async function makeGated(): Promise<void> {
  await mkdir(join(repo, '.opensquid'), { recursive: true });
  await writeFile(
    join(repo, '.opensquid', 'active.json'),
    JSON.stringify({ packs: ['coding-flow'] }),
    'utf8',
  );
}
async function stage(path: string): Promise<void> {
  const full = join(repo, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, 'x\n', 'utf8');
  await git(['add', path], repo);
}
/** Seed the live session so the gate sees a completed flow for active task `t1`. */
async function driveComplete(): Promise<void> {
  const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
  await writeActiveTask(SID, { id: 't1', subject: 'wip', started_at: NOW });
  for (const p of REQUIRED_PHASES) await appendPhase(SID, 't1', p);
  for (const ev of [
    'scope_start',
    'research_done',
    'spec_drafted',
    'spec_verified',
    'tasks_loaded',
    'phase_started',
    'phases_done',
  ])
    await advanceFsmState(SID, 'coding-flow', pack.fsm!, ev, NOW); // → phases_complete
}

describe('GF.2 — owned-boundary git gate (runGate "commit")', () => {
  it('non-gated repo (no active.json) → ALLOW (0)', async () => {
    await stage('src/x.ts');
    expect(await isGatedRepo(repo)).toBe(false);
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(0);
  });

  it('gated repo, code staged, flow NOT complete → BLOCK (2)', async () => {
    await makeGated();
    await stage('src/x.ts'); // no session state seeded → active/fsm absent
    expect(await isGatedRepo(repo)).toBe(true);
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(2);
  });

  it('v1 coding-flow remains FSM/phase-authorized with no commit_gate lenses or audit evidence', async () => {
    await makeGated();
    await stage('src/x.ts');
    await driveComplete();
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(0);
  });

  it('gated repo, docs-only staged → ALLOW (flow artifact)', async () => {
    await makeGated();
    await stage('docs/research/T-x-pre-research.md');
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(0);
  });

  it('gated repo, nothing staged → ALLOW (0)', async () => {
    await makeGated();
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(0);
  });

  it('gated repo, code staged, NO resolvable session → BLOCK (2)', async () => {
    await makeGated();
    await stage('src/x.ts');
    delete process.env.OPENSQUID_SESSION_ID; // and no .current-session pointer under tempHome
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(2);
  });
});

/** Commit whatever is staged. Returns the new HEAD sha. */
async function commit(msg: string): Promise<string> {
  await git(['commit', '-q', '-m', msg], repo);
  const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd: repo });
  return stdout.trim();
}

/** Wipe the seeded session state — simulates the authoring session being gone. */
async function killSession(): Promise<void> {
  await rm(join(tempHome, 'sessions', SID), { recursive: true, force: true });
}

const scopeRoot = (): string => join(repo, '.opensquid');

describe('PGB.2 — runAttest (post-commit / manual)', () => {
  it('completed flow → attestation row with reason flow_complete', async () => {
    await makeGated();
    await stage('src/x.ts');
    await driveComplete();
    const sha = await commit('code');
    expect(await runAttest(repo, AGENT_ENV)).toBe(0);
    expect((await readAttestedShas(scopeRoot())).has(sha)).toBe(true);
  });

  it('docs-only commit → attested with reason docs_only (no flow needed)', async () => {
    await makeGated();
    await stage('docs/notes.md');
    const sha = await commit('docs');
    expect(await runAttest(repo, AGENT_ENV)).toBe(0);
    expect((await readAttestedShas(scopeRoot())).has(sha)).toBe(true);
  });

  it('code commit with NO flow → exit 0 but NOTHING attested', async () => {
    await makeGated();
    await stage('src/x.ts');
    const sha = await commit('rogue');
    expect(await runAttest(repo, AGENT_ENV)).toBe(0);
    expect((await readAttestedShas(scopeRoot())).has(sha)).toBe(false);
  });

  it('non-gated repo → exit 0, no attestations file created', async () => {
    await stage('src/x.ts');
    await commit('free');
    expect(await runAttest(repo, AGENT_ENV)).toBe(0);
    expect((await readAttestedShas(scopeRoot())).size).toBe(0);
  });

  it('amended HEAD re-attests the NEW sha (manual gate attest path)', async () => {
    await makeGated();
    await stage('src/x.ts');
    await driveComplete();
    const first = await commit('v1');
    await runAttest(repo, AGENT_ENV);
    await git(['commit', '-q', '--amend', '-m', 'v2'], repo);
    const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd: repo });
    const amended = stdout.trim();
    expect(amended).not.toBe(first);
    await runAttest(repo, AGENT_ENV);
    expect((await readAttestedShas(scopeRoot())).has(amended)).toBe(true);
  });
});

describe('PGB.2 — runGate "push" with attestation range check', () => {
  /** Wire a bare upstream so `@{u}..HEAD` resolves to a REAL multi-commit range. */
  async function wireUpstream(): Promise<void> {
    const bare = join(tempHome, 'origin.git');
    await execFileP('git', ['init', '-q', '--bare', bare]);
    await git(['remote', 'add', 'origin', bare], repo);
    await git(['push', '-q', '-u', 'origin', 'HEAD'], repo);
  }

  // REL.3: messages are conventional — post-REL.3 every agent commit parses (the commit-msg hook enforces it),
  // so the range backstop is a clean pass here and these tests isolate the ATTESTATION behavior they target.
  it('HANDOVER SCENARIO: range fully attested + authoring session GONE → ALLOW', async () => {
    await makeGated();
    await stage('docs/base.md');
    await commit('chore: base');
    await wireUpstream();
    await stage('src/x.ts');
    await driveComplete();
    await commit('feat: code in session A');
    await runAttest(repo, AGENT_ENV);
    await killSession(); // session A is gone — only the attestation survives
    expect(await runGate('push', repo, AGENT_ENV)).toBe(0);
  });

  it('same scenario WITHOUT the attestation → BLOCK (fail-closed unchanged)', async () => {
    await makeGated();
    await stage('docs/base.md');
    await commit('chore: base');
    await wireUpstream();
    await stage('src/x.ts');
    await driveComplete();
    await commit('feat: code in session A'); // NOT attested
    await killSession();
    expect(await runGate('push', repo, AGENT_ENV)).toBe(2);
  });

  it('mixed range: one attested code commit + one docs-only commit → ALLOW', async () => {
    await makeGated();
    await stage('docs/base.md');
    await commit('chore: base');
    await wireUpstream();
    await stage('src/x.ts');
    await driveComplete();
    await commit('feat: code');
    await runAttest(repo, AGENT_ENV);
    await stage('docs/more.md');
    await commit('docs: ride along');
    await killSession();
    expect(await runGate('push', repo, AGENT_ENV)).toBe(0);
  });

  it('one UNATTESTED code commit in the range poisons the push → BLOCK', async () => {
    await makeGated();
    await stage('docs/base.md');
    await commit('chore: base');
    await wireUpstream();
    await stage('src/x.ts');
    await driveComplete();
    await commit('feat: attested');
    await runAttest(repo, AGENT_ENV);
    await stage('src/y.ts');
    await commit('feat: rogue never attested');
    await killSession();
    expect(await runGate('push', repo, AGENT_ENV)).toBe(2);
  });

  it('live completed session still allows an unattested push (fallback unchanged)', async () => {
    await makeGated();
    await stage('docs/base.md');
    await commit('chore: base');
    await wireUpstream();
    await stage('src/x.ts');
    await driveComplete();
    await commit('feat: code'); // not attested, but the session is alive + complete
    expect(await runGate('push', repo, AGENT_ENV)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GDC.1 — boundary-based non-code classification + human passthrough.
// ---------------------------------------------------------------------------

import { fileURLToPath as fileURLToPathGdc } from 'node:url';
import { dirname as dirnameGdc, resolve as resolveGdc } from 'node:path';
import { readFile as readFileGdc } from 'node:fs/promises';

import { AGENT_ENV_MARKERS, PROTECTED_PREFIXES, isAgentInvocation } from './gate.js';

const REPO_ROOT_GDC = resolveGdc(dirnameGdc(fileURLToPathGdc(import.meta.url)), '../../..');

describe('GDC.1 — non-code classification (the live README repro)', () => {
  it('root-level README + banner → non-code, allowed with no flow (agent env)', async () => {
    await makeGated();
    await stage('README.md');
    await stage('banner.png');
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(0);
  });

  it('mixed commit (README + src file) → CODE, blocked without a completed flow (agent env)', async () => {
    await makeGated();
    await stage('README.md');
    await stage('src/x.ts');
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(2);
  });

  it('drift pin: PROTECTED_PREFIXES ≡ the scope-lifecycle write-gate substrings', async () => {
    const yaml = await readFileGdc(
      join(REPO_ROOT_GDC, 'packs/builtin/coding-flow/skills/scope-lifecycle/skill.yaml'),
      'utf8',
    );
    const predicate = yaml.split('\n').find((l) => l.includes('contains(targs.file_path, "src/")'));
    expect(predicate).toBeDefined();
    for (const p of PROTECTED_PREFIXES) {
      expect(predicate).toContain(`"${p}"`);
    }
    const matches = [...(predicate ?? '').matchAll(/contains\(targs\.file_path, "([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    expect(new Set(matches)).toEqual(new Set(PROTECTED_PREFIXES));
  });
});

describe('GDC.1 — human passthrough (the gate gates agents, never humans)', () => {
  it('human env → allowed even with src changes, at both boundaries', async () => {
    await makeGated();
    await stage('src/x.ts');
    expect(await runGate('commit', repo, HUMAN_ENV)).toBe(0);
    expect(await runGate('push', repo, HUMAN_ENV)).toBe(0);
  });

  it("human commit → attested with reason 'human' (provenance preserved)", async () => {
    await makeGated();
    await stage('src/x.ts');
    const sha = await commit('human code');
    expect(await runAttest(repo, HUMAN_ENV)).toBe(0);
    expect((await readAttestedShas(scopeRoot())).has(sha)).toBe(true);
  });

  it('isAgentInvocation pins both directions + the codex marker', () => {
    expect(isAgentInvocation(HUMAN_ENV)).toBe(false);
    expect(isAgentInvocation(AGENT_ENV)).toBe(true);
    expect(isAgentInvocation({ CODEX_THREAD_ID: 't' })).toBe(true);
    expect(AGENT_ENV_MARKERS).toContain('CLAUDECODE');
  });
});

// E0 (docs/design/v2-enforcement-implementation.md §0) — pinning v2 must NOT disable the gate.
async function makeGatedV2(): Promise<void> {
  await mkdir(join(repo, '.opensquid'), { recursive: true });
  await writeFile(
    join(repo, '.opensquid', 'active.json'),
    JSON.stringify({ packs: ['fullstack-flow'] }),
    'utf8',
  );
}
describe('E0 — commit-gate is armed under v2 (fullstack-flow), not just v1 coding-flow', () => {
  it('v2 pinned → isGatedRepo true (pre-E0 the literal coding-flow constant returned false → gate OFF)', async () => {
    await makeGatedV2();
    expect(await isGatedRepo(repo)).toBe(true);
  });

  it('v2 + agent code commit + NO phases logged → BLOCK (2)', async () => {
    await makeGatedV2();
    await stage('src/x.ts');
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(2);
  });

  it('v2 + agent code commit + 7 phases + CODE audit GUESS_FREE (certifying the CURRENT diff) + suite green → ALLOW (0)', async () => {
    await makeGatedV2();
    await armStalenessRepo();
    await stage('src/x.ts');
    await writeActiveTask(SID, { id: 't1', subject: 'wip', started_at: NOW });
    for (const p of REQUIRED_PHASES) await appendPhase(SID, 't1', p);
    // GFR.2-hard: the external verdict certifies the exact active policy and diff being committed.
    await writeCodeAudit('VERDICT: GUESS_FREE\n- all good', await readGitWorkingTreeDiff(repo));
    // scope-5 (§5.4): fullstack-flow now declares `require_suite_green: true`, so the gate ALSO needs the
    // suite record green (the belt-and-suspenders backstop) — record it for the active task.
    await recordSuite(SID, 't1', true);
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(0);
  });

  it('rejects passing evidence produced under a different timeout policy', async () => {
    await makeGatedV2();
    await armStalenessRepo();
    await stage('src/x.ts');
    await writeActiveTask(SID, { id: 't1', subject: 'wip', started_at: NOW });
    for (const p of REQUIRED_PHASES) await appendPhase(SID, 't1', p);
    await writeCodeAudit(
      'VERDICT: GUESS_FREE\n- old timeout policy',
      await readGitWorkingTreeDiff(repo),
      1,
    );
    await recordSuite(SID, 't1', true);
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(2);
  });

  it('rejects reduced arbitrary lenses even when marked complete and passing', async () => {
    await makeGatedV2();
    await armStalenessRepo();
    await stage('src/x.ts');
    await writeActiveTask(SID, { id: 't1', subject: 'wip', started_at: NOW });
    for (const p of REQUIRED_PHASES) await appendPhase(SID, 't1', p);
    process.env.OPENSQUID_ITEM_ID = 't1';
    const diff = await readGitWorkingTreeDiff(repo);
    const rubric = await readRubricContent('code', 'fullstack-flow');
    if (rubric === null) throw new Error('missing code rubric');
    const policy = materializePackAuditPolicy(
      await loadActivePacksForDispatch(SID, repo),
      'fullstack-flow',
      'fullstack-flow-code-audit-cache',
      rubric,
      diff,
    );
    if (policy === null) throw new Error('missing code policy');
    await writeTaskAuditCache(SID, policy.cacheKey, {
      hash: auditDeclarationCacheHash({
        model: policy.model,
        lenses: policy.lenses,
        passVerdict: policy.passVerdict,
        failVerdict: policy.failVerdict,
        timeoutMs: policy.timeoutMs,
        subject: policy.subject,
      }),
      complete: true,
      passVerdict: policy.passVerdict,
      failVerdict: policy.failVerdict,
      subjectHash: sha256Hex(diff),
      lenses: policy.lenses.slice(0, 2).map((lens) => ({
        id: lens.id,
        promptHash: auditLensPolicyHash({
          model: policy.model,
          lens,
          passVerdict: policy.passVerdict,
          failVerdict: policy.failVerdict,
          timeoutMs: policy.timeoutMs,
        }),
        output: 'VERDICT: GUESS_FREE',
      })),
    });
    await recordSuite(SID, 't1', true);
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(2);
  });

  it('STALENESS: v2 + 7 phases + GUESS_FREE but the verdict certified a DIFFERENT diff → BLOCK (2)', async () => {
    await makeGatedV2();
    await armStalenessRepo();
    await stage('src/x.ts');
    await writeActiveTask(SID, { id: 't1', subject: 'wip', started_at: NOW });
    for (const p of REQUIRED_PHASES) await appendPhase(SID, 't1', p);
    // GUESS_FREE, but identity/subject anchor a since-changed diff → fail-closed.
    await writeCodeAudit('VERDICT: GUESS_FREE\n- all good', 'a stale, different diff');
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      writes.push(String(s));
      return true;
    });
    const code = await runGate('commit', repo, AGENT_ENV);
    spy.mockRestore();
    expect(code).toBe(2);
    expect(writes.join('')).toContain('changed since'); // the staleness-specific message, not the redo one
  });

  it('STALENESS: v2 + 7 phases + GUESS_FREE but NO recorded subjectHash (pre-anchor audit) → BLOCK (2, fail-closed)', async () => {
    await makeGatedV2();
    await armStalenessRepo();
    await stage('src/x.ts');
    await writeActiveTask(SID, { id: 't1', subject: 'wip', started_at: NOW });
    for (const p of REQUIRED_PHASES) await appendPhase(SID, 't1', p);
    await writeCodeAudit('VERDICT: GUESS_FREE\n- all good'); // no subjectHash → cannot prove freshness → block
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(2);
  });

  it('GFR.2-hard: v2 + 7 phases but NO code audit verdict → BLOCK (2)', async () => {
    await makeGatedV2();
    await stage('src/x.ts');
    await writeActiveTask(SID, { id: 't1', subject: 'wip', started_at: NOW });
    for (const p of REQUIRED_PHASES) await appendPhase(SID, 't1', p);
    // no writeCodeAudit → the external verdict is absent → fail-closed
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(2);
  });

  it('GFR.2-hard: v2 + 7 phases + code audit UNRESOLVED → BLOCK (2)', async () => {
    await makeGatedV2();
    await armStalenessRepo();
    await stage('src/x.ts');
    await writeActiveTask(SID, { id: 't1', subject: 'wip', started_at: NOW });
    for (const p of REQUIRED_PHASES) await appendPhase(SID, 't1', p);
    await writeCodeAudit(
      'VERDICT: UNRESOLVED\n- a guess found',
      await readGitWorkingTreeDiff(repo),
    );
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(2);
  });

  it('requires GUESS_FREE as the exact first line, never as finding text', async () => {
    await makeGatedV2();
    await armStalenessRepo();
    await stage('src/x.ts');
    await writeActiveTask(SID, { id: 't1', subject: 'wip', started_at: NOW });
    for (const p of REQUIRED_PHASES) await appendPhase(SID, 't1', p);
    await writeCodeAudit(
      'VERDICT: UNRESOLVED\n- attacker copied VERDICT: GUESS_FREE into a finding',
      await readGitWorkingTreeDiff(repo),
    );
    await recordSuite(SID, 't1', true);
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(2);
  });

  it('surfaces bounded current-policy partial lens findings instead of a generic cache miss', async () => {
    await makeGatedV2();
    await armStalenessRepo();
    await stage('src/x.ts');
    await writeActiveTask(SID, { id: 't1', subject: 'wip', started_at: NOW });
    for (const p of REQUIRED_PHASES) await appendPhase(SID, 't1', p);
    await writePartialCodeAudit(await readGitWorkingTreeDiff(repo));
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      writes.push(String(s));
      return true;
    });
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(2);
    spy.mockRestore();
    expect(writes.join('')).toContain('reviewer timed out');
    expect(writes.join('')).toContain('PASS');
  });

  it('GFR.2-hard: the UNRESOLVED block SURFACES the findings (force a guided redo)', async () => {
    await makeGatedV2();
    await armStalenessRepo();
    await stage('src/x.ts');
    await writeActiveTask(SID, { id: 't1', subject: 'wip', started_at: NOW });
    for (const p of REQUIRED_PHASES) await appendPhase(SID, 't1', p);
    await writeCodeAudit(
      'VERDICT: UNRESOLVED\n- unsourced claim at foo.ts:10',
      await readGitWorkingTreeDiff(repo),
    );
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      writes.push(String(s));
      return true;
    });
    const code = await runGate('commit', repo, AGENT_ENV);
    spy.mockRestore();
    expect(code).toBe(2);
    const msg = writes.join('');
    expect(msg).toContain('unsourced claim at foo.ts:10'); // the exact finding is surfaced
    expect(msg).toContain('REDO'); // and the redo instruction
  });

  it('v2 + docs-only commit → ALLOW (0) (non-code is never blocked)', async () => {
    await makeGatedV2();
    await stage('README.md');
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(0);
  });

  // scope-4 (T-deploy-commit-gate §4a): the CODE-audit cache KEY is PACK-DECLARED evidence, never a core literal.
  // Drift-pin: if a future edit re-hardcodes `fullstack-flow-<something>` into core gate.ts, this fails — the key
  // must come from the pack's `commit_gate` block (runtime/commit_gate_evidence.ts), enforced by acceptance.
  it('DRIFT-PIN: core gate.ts carries NO `fullstack-flow-` key literal (evidence is pack-declared, §4a)', async () => {
    const src = await readFile(resolve('src/setup/cli/gate.ts'), 'utf8');
    expect(src).not.toContain('fullstack-flow-');
  });
});

// scope-5 (T-deploy-commit-gate §2.5 + §5.4) — SUITE-IN-BOTH: the commit gate INDEPENDENTLY hard-requires the
// project verification-suite record green (pack-declared `require_suite_green: true`), so a commit that bypassed
// the DEPLOY driver still cannot land on a red suite. Two enforcement points (the DEPLOY driver + this gate), one
// requirement over the SAME per-task suite record (scope-1's readSuite).
describe('scope-5 — the commit gate independently requires suite-green (belt-and-suspenders, §5.4)', () => {
  /** The full v2 pass-the-gate setup EXCEPT the suite record — the caller decides what to record. */
  async function driveV2AuditGreen(): Promise<void> {
    await makeGatedV2();
    await armStalenessRepo();
    await stage('src/x.ts');
    await writeActiveTask(SID, { id: 't1', subject: 'wip', started_at: NOW });
    for (const p of REQUIRED_PHASES) await appendPhase(SID, 't1', p);
    await writeCodeAudit('VERDICT: GUESS_FREE\n- all good', await readGitWorkingTreeDiff(repo));
  }

  it('audit GUESS_FREE + current-diff, but suite recorded RED → BLOCK (2), with the suite-specific reason', async () => {
    await driveV2AuditGreen();
    await recordSuite(SID, 't1', false); // the backstop bites even though the CODE audit is satisfied
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      writes.push(String(s));
      return true;
    });
    const code = await runGate('commit', repo, AGENT_ENV);
    spy.mockRestore();
    expect(code).toBe(2);
    // the suite-specific message, NOT the audit-redo or staleness one (the audit here IS satisfied).
    expect(writes.join('')).toContain('verification suite is not');
  });

  it('audit GUESS_FREE + current-diff, but NO suite record → BLOCK (2, fail-closed — unrecorded is not green)', async () => {
    await driveV2AuditGreen();
    // no recordSuite → readSuite is null → not green → block
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(2);
  });

  it('audit GUESS_FREE + current-diff + suite recorded GREEN → ALLOW (0) (both enforcement points satisfied)', async () => {
    await driveV2AuditGreen();
    await recordSuite(SID, 't1', true);
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(0);
  });

  it('requireSuiteGreen=false → the suite record is NOT consulted (backward-compatible); commit ALLOWED with no suite record', async () => {
    await driveV2AuditGreen();
    // NO recordSuite. A pack that declares require_suite_green:false must keep its pre-scope-5 behavior.
    const verdict = await commitAllowedNow(
      SID,
      ['src/x.ts'],
      AGENT_ENV,
      {
        auditCacheKey: 'fullstack-flow-code-audit-cache',
        requirePhaseLedger: true,
        requireSuiteGreen: false,
      },
      'fullstack-flow',
    );
    expect(verdict).toEqual({ allowed: true, reason: 'flow_complete' });
  });
});

describe('project-only operation — the user/home scope (~/.opensquid) no longer arms the gate', () => {
  async function makeRepoWithoutProjectActivation(): Promise<void> {
    await mkdir(join(repo, '.opensquid'), { recursive: true });
    // deliberately NO active.json at project scope
  }

  it('user-scope coding-flow but NO project active.json → UNGATED (0) (global enforces nothing)', async () => {
    // Pre-project-only this armed the gate in EVERY repo; now the user/home scope enforces nothing.
    await makeRepoWithoutProjectActivation();
    await writeFile(
      join(tempHome, 'active.json'),
      JSON.stringify({ packs: ['coding-flow'] }),
      'utf8',
    );
    await stage('src/x.ts');
    expect(await isGatedRepo(repo)).toBe(false);
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(0);
  });

  it('neither scope active → ungated', async () => {
    await makeRepoWithoutProjectActivation();
    await stage('src/x.ts');
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(0);
  });

  it('PROJECT-scope activation gates (the sole arming scope)', async () => {
    await makeGated();
    await stage('src/x.ts');
    expect(await isGatedRepo(repo)).toBe(true);
    expect(await runGate('commit', repo, AGENT_ENV)).toBe(2);
  });
});

describe('DEPLOY branch resolution — environment SSOT and checkout must agree', () => {
  async function writeEnvironments(environments: Record<string, string>): Promise<void> {
    await mkdir(join(repo, '.opensquid'), { recursive: true });
    await writeFile(
      join(repo, '.opensquid', 'active.json'),
      JSON.stringify({ packs: ['fullstack-flow'], 'version-control': { environments } }),
      'utf8',
    );
  }

  it('uses the current semantic branch when environments.local is omitted', async () => {
    await git(['checkout', '-q', '-b', 'fix/semantic-deploy-policy'], repo);
    await git(['commit', '--allow-empty', '-q', '-m', 'test: establish branch'], repo);
    await writeEnvironments({ production: 'main' });

    expect(await configuredLocalBranch(repo)).toBe('fix/semantic-deploy-policy');
  });

  it('returns the configured local branch only when the checkout matches', async () => {
    await git(['checkout', '-q', '-b', 'fix/semantic-deploy-policy'], repo);
    await git(['commit', '--allow-empty', '-q', '-m', 'test: establish branch'], repo);
    await writeEnvironments({
      production: 'main',
      local: 'fix/semantic-deploy-policy',
    });
    expect(await configuredLocalBranch(repo)).toBe('fix/semantic-deploy-policy');

    await writeEnvironments({ production: 'main', local: 'feat/different-work' });
    expect(await configuredLocalBranch(repo)).toBeNull();
  });
});

// REL.3 (T-opensquid-release-flow) — the commit-msg format gate + the pre-push range backstop.
describe('REL.3 — runCommitMsgGate (conventional-commit format)', () => {
  async function writeMsg(text: string): Promise<string> {
    const p = join(repo, '.git', 'COMMIT_EDITMSG');
    await writeFile(p, text, 'utf8');
    return p;
  }

  it('gated agent + conventional message → ALLOW (0)', async () => {
    await makeGated();
    const msg = await writeMsg('feat(release): add opensquid release\n');
    expect(await runCommitMsgGate(msg, repo, AGENT_ENV)).toBe(0);
  });

  it('gated agent + non-conventional message → BLOCK (2)', async () => {
    await makeGated();
    const msg = await writeMsg('wip nonsense\n');
    expect(await runCommitMsgGate(msg, repo, AGENT_ENV)).toBe(2);
  });

  it('NON-gated repo → ALLOW (0) regardless of format', async () => {
    const msg = await writeMsg('wip nonsense\n');
    expect(await runCommitMsgGate(msg, repo, AGENT_ENV)).toBe(0);
  });

  it('HUMAN invocation → ALLOW (0) even in a gated repo (GDC.1)', async () => {
    await makeGated();
    const msg = await writeMsg('wip nonsense\n');
    expect(await runCommitMsgGate(msg, repo, HUMAN_ENV)).toBe(0);
  });

  it('strips git comment/scissors lines before validating the subject', async () => {
    await makeGated();
    const msg = await writeMsg(
      'fix: real subject\n# Please enter the commit message…\n# ------------------------ >8 ------------------------\ndiff --git a/x b/x\n',
    );
    expect(await runCommitMsgGate(msg, repo, AGENT_ENV)).toBe(0);
  });

  it('empty (comment-only) message → ALLOW (git aborts the commit itself)', async () => {
    await makeGated();
    const msg = await writeMsg('# only a comment\n');
    expect(await runCommitMsgGate(msg, repo, AGENT_ENV)).toBe(0);
  });
});

describe('REL.3 — pre-push conventional-commit backstop (defense-in-depth)', () => {
  /** Give `repo` an upstream with the given committed subjects ahead of it, so `@{u}..HEAD` is a real range. */
  async function pushSetup(aheadSubjects: string[]): Promise<void> {
    await makeGated();
    await git(['commit', '--allow-empty', '-q', '-m', 'chore: base'], repo);
    const bare = await mkdtemp(join(tmpdir(), 'opensquid-gate-remote-'));
    await execFileP('git', ['init', '-q', '--bare'], { cwd: bare });
    await git(['remote', 'add', 'origin', bare], repo);
    await git(['push', '-q', '-u', 'origin', 'HEAD'], repo); // upstream now = base
    for (const s of aheadSubjects) await git(['commit', '--allow-empty', '-q', '-m', s], repo);
  }

  it('all-conventional range → ALLOW (0)', async () => {
    await pushSetup(['feat: a', 'fix: b']);
    expect(await runGate('push', repo, AGENT_ENV)).toBe(0);
  });

  it('a non-conventional commit in the range → BLOCK (2)', async () => {
    await pushSetup(['feat: a', 'wip broken']);
    expect(await runGate('push', repo, AGENT_ENV)).toBe(2);
  });

  it('a human push is never format-blocked (GDC.1)', async () => {
    await pushSetup(['wip broken']);
    expect(await runGate('push', repo, HUMAN_ENV)).toBe(0);
  });

  it('no upstream (new branch) → tolerated, no backstop block', async () => {
    await makeGated();
    await git(['commit', '--allow-empty', '-q', '-m', 'wip no upstream'], repo);
    // @{u} does not resolve → the backstop can't range → does not block on that account.
    // (The flow gate may still block for other reasons; assert the backstop specifically is a no-op via a
    // docs-only change so the flow gate passes and only the backstop could bite.)
    await stage('docs/x.md');
    await git(['add', 'docs/x.md'], repo);
    await git(['commit', '-q', '-m', 'wip no upstream 2'], repo);
    expect(await runGate('push', repo, AGENT_ENV)).toBe(0);
  });
});
