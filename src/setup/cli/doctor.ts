/**
 * `opensquid doctor hooks` — health check for Claude Code hook wiring (G.2).
 *
 * Reads `~/.claude/settings.json` + `<cwd>/.claude/settings.json`, finds
 * opensquid-managed hook entries (regex `/opensquid-hook|opensquid.*anti-drift/`),
 * spawns each with a canonical Claude Code event payload, checks STDERR for
 * the `[opensquid-dispatch]` marker. Marker absence = silent-no-op (the G.1
 * root-cause failure mode). Exit 0 if all green, 1 if any red (CI-friendly).
 *
 * Security gate: NEVER spawns a command the shared ownership predicate
 * (`isOpensquidHookCommand`, settings-writer.ts) doesn't claim —
 * non-matching entries SKIPPED with note ("not opensquid-managed").
 * D9-guard prompt-type hooks SKIPPED ("non-spawnable hook type").
 *
 * Engine-vocabulary discipline: consumer-side file — knows about Claude
 * Code's settings.json + hook events. Runtime stays harness-agnostic.
 *
 * Imported by: src/cli.ts.
 */

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Command } from 'commander';

import { computeMemoryDrift, renderMemoryDrift } from '../migrate/memory_drift.js';
import { makeMemoryStore } from '../migrate/memory_store_handle.js';
import { readSettingsHooks, type ParsedHookEntry } from '../wizard/settings-reader.js';
import { OPENSQUID_BIN_FOR_EVENT, isOpensquidHookCommand } from '../wizard/settings-writer.js';

/** `/`→`-`, matching Claude Code's auto-memory dir naming. Mirrors the inline
 * copies in `memory.ts` / `memory_reconcile.ts` (stable one-liner; no shared
 * import to avoid a cli→hooks layering edge). */
function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, '-');
}

// T-FIX-WIZARD-HOOK-RECOGNITION: the spawn/managed gate now uses the SHARED
// ownership predicate `isOpensquidHookCommand` (settings-writer.ts) — the old
// local substring regex was one of three divergent classifiers and could both
// miss real entries and spawn lookalikes (`opensquid-hook-typo-not-ours`).

/** Maps Claude Code event names → canonical event-kind label + minimal
 * snake_case stdin payload satisfying each hook bin's parser. */
const PROBE_PAYLOADS: Record<string, { kind: string; stdin: string }> = {
  PreToolUse: {
    kind: 'tool_call',
    stdin: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'echo probe' },
      session_id: 'doctor-probe',
    }),
  },
  UserPromptSubmit: {
    kind: 'prompt_submit',
    stdin: JSON.stringify({ prompt: 'doctor-probe', session_id: 'doctor-probe' }),
  },
  Stop: {
    kind: 'stop',
    stdin: JSON.stringify({ assistant_text: 'doctor-probe', session_id: 'doctor-probe' }),
  },
  SessionEnd: { kind: 'session_end', stdin: JSON.stringify({ session_id: 'doctor-probe' }) },
  // T-POSTPUSH POSTPUSH.1 — PostToolUse is in OPENSQUID_BIN_FOR_EVENT, so a
  // setup re-run installs it; doctor must have a probe so it greens instead
  // of red-flagging "no probe payload registered".
  PostToolUse: {
    kind: 'post_tool_call',
    stdin: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'echo probe' },
      tool_result: { exit_code: 0 },
      session_id: 'doctor-probe',
    }),
  },
  // T-HANDOFF-HARDENING HH6.1 — SessionStart probe MUST use a dispatching
  // source (startup), not clear/compact, so the dispatch marker is emitted
  // and the probe greens.
  SessionStart: {
    kind: 'session_start',
    stdin: JSON.stringify({ session_id: 'doctor-probe', source: 'startup' }),
  },
};

type Status = 'green' | 'red' | 'skipped';

export interface DoctorResult {
  scope: 'user' | 'project';
  event: string;
  command: string;
  status: Status;
  reason: string;
}

export interface DoctorOptions {
  userSettingsPath: string;
  projectSettingsPath: string;
  /** Override for unit tests — defaults to spawning real subprocesses. */
  spawnProbe?: (command: string, stdin: string) => Promise<{ exitCode: number; stderr: string }>;
}

/** Pure runner — disk + spawn injectable for tests. */
export async function runDoctorHooks(opts: DoctorOptions): Promise<DoctorResult[]> {
  const probe = opts.spawnProbe ?? defaultSpawnProbe;
  const results: DoctorResult[] = [];
  const scopes: ['user' | 'project', string][] = [
    ['user', opts.userSettingsPath],
    ['project', opts.projectSettingsPath],
  ];

  for (const [scope, path] of scopes) {
    let entries: ParsedHookEntry[];
    try {
      entries = await readSettingsHooks(path);
    } catch (e) {
      results.push(mk(scope, '-', path, 'red', `could not parse ${path}: ${String(e)}`));
      continue;
    }
    if (entries.length === 0) {
      results.push(mk(scope, '-', path, 'skipped', `no hooks at ${path}`));
      continue;
    }
    for (const entry of entries) results.push(await probeEntry(scope, entry, probe));

    // FC.5 coverage: a scope that manages opensquid hooks must register the FULL
    // canonical set — flag any OPENSQUID_BIN_FOR_EVENT event ENTIRELY ABSENT (a
    // present-but-broken event is already RED via probeEntry, so no double-count).
    // A scope with zero opensquid hooks is exempt (project scope is optional).
    const managed = entries.filter(
      (e) => e.type === 'command' && isOpensquidHookCommand(e.command),
    );
    if (managed.length > 0) {
      const present = new Set(managed.map((e) => e.event));
      for (const [event, command] of Object.entries(OPENSQUID_BIN_FOR_EVENT)) {
        if (!present.has(event)) {
          results.push(
            mk(
              scope,
              event,
              command,
              'red',
              'not registered in settings.json — run `opensquid setup wizard hooks`',
            ),
          );
        }
      }
    }
  }
  return results;
}

function mk(
  scope: 'user' | 'project',
  event: string,
  command: string,
  status: Status,
  reason: string,
): DoctorResult {
  return { scope, event, command, status, reason };
}

async function probeEntry(
  scope: 'user' | 'project',
  entry: ParsedHookEntry,
  probe: NonNullable<DoctorOptions['spawnProbe']>,
): Promise<DoctorResult> {
  // D9-guard prompt-type → not a subprocess; cannot probe.
  if (entry.type === 'prompt') {
    return mk(
      scope,
      entry.event,
      entry.prompt,
      'skipped',
      'non-spawnable hook type (inline prompt)',
    );
  }
  // Security gate: only spawn commands the shared ownership predicate claims.
  if (!isOpensquidHookCommand(entry.command)) {
    return mk(scope, entry.event, entry.command, 'skipped', 'not opensquid-managed');
  }
  const probePayload = PROBE_PAYLOADS[entry.event];
  if (!probePayload) {
    return mk(
      scope,
      entry.event,
      entry.command,
      'red',
      `unknown event "${entry.event}" — no probe payload registered`,
    );
  }
  let result: { exitCode: number; stderr: string };
  try {
    result = await probe(entry.command, probePayload.stdin);
  } catch (e) {
    return mk(scope, entry.event, entry.command, 'red', `spawn failed: ${String(e)}`);
  }
  const expectedMarker = `[opensquid-dispatch] event=${probePayload.kind}`;
  if (!result.stderr.includes(expectedMarker)) {
    return mk(
      scope,
      entry.event,
      entry.command,
      'red',
      `marker absent (expected "${expectedMarker}"), likely silent no-op (G.1 broken-path bug); exit=${String(result.exitCode)}`,
    );
  }
  return mk(scope, entry.event, entry.command, 'green', 'marker present');
}

/** Default subprocess probe — spawn `sh -c <command>` so PATH-resolved bin
 * names work the same way Claude Code itself spawns them. Times out after
 * 10s so a misbehaving hook can't hang the doctor CLI. */
function defaultSpawnProbe(
  command: string,
  stdin: string,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((res, rej) => {
    // OPENSQUID_DISPATCH_TRACE forced on for the probe — the user may have it
    // off in their normal env, but doctor MUST see the marker to assess.
    const env = { ...process.env, OPENSQUID_DISPATCH_TRACE: '1' };
    const p = spawn(command, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    let stderr = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      rej(new Error('probe timeout (10s)'));
    }, 10_000);
    p.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    p.on('error', (err) => {
      clearTimeout(timer);
      rej(err);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      res({ exitCode: code ?? -1, stderr });
    });
    p.stdin.write(stdin);
    p.stdin.end();
  });
}

/** Pretty-print to stdout. Returns the number of RED results (caller maps to
 * process exit code). */
export function printReport(results: DoctorResult[]): number {
  let red = 0;
  for (const r of results) {
    const tag = r.status === 'green' ? '[GREEN]  ' : r.status === 'red' ? '[RED]    ' : '[SKIPPED]';
    if (r.status === 'red') red += 1;
    const cmdTrunc = r.command.length > 60 ? r.command.slice(0, 57) + '...' : r.command;
    process.stdout.write(`${tag} ${r.scope}/${r.event}: ${cmdTrunc}\n`);
    if (r.reason) process.stdout.write(`           reason: ${r.reason}\n`);
  }
  process.stdout.write(
    `\nsummary: ${String(results.filter((r) => r.status === 'green').length)} green, ${String(red)} red, ${String(results.filter((r) => r.status === 'skipped').length)} skipped\n`,
  );
  return red;
}

export function registerDoctor(program: Command): void {
  const doc = program.command('doctor').description('Health checks for opensquid configuration');
  doc
    .command('hooks')
    .description('Check that configured Claude Code hooks actually dispatch (G.2)')
    .action(async () => {
      const userPath = resolve(process.env.HOME ?? '', '.claude/settings.json');
      const projectPath = join(process.cwd(), '.claude/settings.json');
      const results = await runDoctorHooks({
        userSettingsPath: userPath,
        projectSettingsPath: projectPath,
      });
      const red = printReport(results);
      process.exit(red === 0 ? 0 : 1);
    });

  doc
    .command('memory')
    .description('Check the auto-memory ↔ engine-RAG store are in sync (MAU.4)')
    .action(async () => {
      // The doctor CLI runs in the project dir, so cwd resolves the auto-memory
      // dir directly (unlike the SessionEnd hook, which needs the recorded cwd).
      const dir = join(
        homedir(),
        '.claude',
        'projects',
        encodeProjectPath(process.cwd()),
        'memory',
      );
      try {
        await stat(dir);
      } catch {
        process.stdout.write(`memory: no auto-memory dir for this project (${dir})\n`);
        process.exit(0);
      }
      const store = await makeMemoryStore();
      try {
        const drift = await computeMemoryDrift(dir, store);
        process.stdout.write(renderMemoryDrift(drift) + '\n');
        if (!drift.inSync) {
          if (drift.missing.length > 0)
            process.stdout.write(`  missing:  ${drift.missing.join(', ')}\n`);
          if (drift.stale.length > 0)
            process.stdout.write(`  stale:    ${drift.stale.join(', ')}\n`);
          if (drift.orphaned.length > 0)
            process.stdout.write(`  orphaned: ${drift.orphaned.join(', ')}\n`);
        }
        process.exit(drift.inSync ? 0 : 1); // non-zero on drift → fail loud for CI/wrappers
      } catch (e) {
        // FAIL-LOUD: a probe failure must never read as "in sync".
        process.stderr.write(`memory: drift check FAILED — ${String(e)}\n`);
        process.exit(1);
      } finally {
        await store.close();
      }
    });

  doc
    .command('git-hooks')
    .description('Check the opensquid git pre-commit/pre-push hooks are installed (GF.2)')
    .action(async () => {
      const { gitRoot } = await import('./gate.js');
      const { checkGitHooks } = await import('../wizard/git-hooks.js');
      const root = await gitRoot(process.cwd());
      if (root === null) {
        process.stdout.write('[SKIPPED] git-hooks: not inside a git work tree\n');
        process.exit(0);
      }
      const res = await checkGitHooks(root);
      for (const h of res) {
        const tag = h.state === 'installed' ? 'GREEN' : h.state === 'foreign' ? 'WARN' : 'RED';
        process.stdout.write(`[${tag}]\t${h.name}: ${h.state}\n`);
      }
      const incomplete = res.some((h) => h.state !== 'installed');
      if (incomplete) process.stdout.write('remediation: opensquid gate install\n');
      // `unreachable` (a dead managed block below a foreign exec/exit) is as absent as
      // `missing` — the gate never runs. Both are RED + exit 1.
      process.exit(res.some((h) => h.state === 'missing' || h.state === 'unreachable') ? 1 : 0);
    });
}
