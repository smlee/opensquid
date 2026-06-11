/**
 * T-handoff-nested-session-spam SUB.2 (wg-627effbb2c38) — the ONE spawn
 * lifecycle for one-shot CLI children, shared by both spawn sites
 * (models/strategies/subscription_cli.ts — the audit reviewer — and
 * runtime/agent_bridge/agent_loop_subscription.ts — the chat working
 * agent), replacing their deliberately-mirrored copies.
 *
 * Lifecycle FSM (lexicon: explicit total transitions; the promise settles
 * exactly once, on the FIRST transition out of `running`):
 *
 *   running ──close──────────────► closed        (resolve/reject by exit code)
 *   running ──spawn 'error'──────► spawn_failed  (reject)
 *   running ──timeout────────────► term_sent     (reject NOW; grace timer armed, REF'D)
 *   term_sent ──close────────────► closed_late   (clear grace; child obeyed SIGTERM)
 *   term_sent ──grace expiry─────► group_killed  (kill(-pid) sweep; ESRCH = already gone)
 *
 * `term_sent → supervisor SIGKILLed externally` leaks the child by design —
 * enumerated residual: the REF'D grace timer holds the supervisor alive
 * through grace in every non-forced teardown (an unref'd timer dies when a
 * hook bin exits right after the rejection — observed live as SIGTERM-
 * ignoring `claude -p` orphans piling up on the subscription bucket), and a
 * forced external SIGKILL of the supervisor is outside any in-process
 * guarantee.
 *
 * Two ORTHOGONAL env markers — never merge them:
 *   - OPENSQUID_SUBAGENT  (hook policy, SUB.1): set only when
 *     `markSubagent: true` (reviewer spawns). Hook bins short-circuit.
 *   - OPENSQUID_SUPERVISED (kill-tree, THIS module): set on EVERY helper
 *     spawn. The OUTERMOST helper spawn in a tree detaches as group leader;
 *     every deeper helper spawn joins the ancestor's group — a reviewer
 *     spawned from a bridge child's hooks must NOT escape the bridge
 *     group's sweep (spec-audit finding 1).
 *
 * Phase-1 limitation carried over verbatim from subscription_cli.ts: pipe
 * stdio can mutually deadlock on prompts >64KB (kernel pipe buffer); the
 * temp-file fallback is Phase-2 scope — do NOT bolt on a partial drain
 * handler here.
 *
 * Imports from: node:child_process.
 * Imported by: models/strategies/subscription_cli.ts,
 *   runtime/agent_bridge/agent_loop_subscription.ts.
 */

import { spawn } from 'node:child_process';

export interface OneShotOpts {
  cli: string;
  args: string[];
  /** Prompt body written to the child's stdin then EOF. */
  prompt: string;
  timeoutMs: number;
  /** SUB.1 hook-policy marker: reviewer spawns mark the child tree; bridge spawns do not. */
  markSubagent: boolean;
  /** Typed rejection factory — each site keeps its own timeout error contract. */
  timeoutError: (timeoutMs: number) => Error;
  /** Prefix for spawn/exit/stdin error messages (bridge: 'subscription cli '). */
  errorPrefix?: string;
  /** Grace before the group SIGKILL. Default 5_000. */
  graceMs?: number;
}

type LifecyclePhase =
  | { phase: 'running' }
  | { phase: 'spawn_failed' }
  | { phase: 'term_sent' }
  | { phase: 'closed' }
  | { phase: 'closed_late' }
  | { phase: 'group_killed' };

/** Kill-tree marker: true when THIS process already runs under a helper-supervised tree. */
export const insideSupervisedTree = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.OPENSQUID_SUPERVISED === '1';

export function runOneShotCli(opts: OneShotOpts): Promise<string> {
  const prefix = opts.errorPrefix ?? '';
  return new Promise<string>((resolve, reject) => {
    // Detach predicate = the SUPERVISED marker, NOT the hook-policy marker
    // (spec-audit finding 1): a reviewer spawned from an UNMARKED bridge
    // tree must still join the bridge group, or it escapes the sweep. Every
    // helper spawn sets SUPERVISED; only the outermost detaches.
    const detached = !insideSupervisedTree();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENSQUID_SUPERVISED: '1',
      ...(opts.markSubagent ? { OPENSQUID_SUBAGENT: '1' } : {}),
    };
    const proc = spawn(opts.cli, opts.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached,
      env,
    });

    let state: LifecyclePhase = { phase: 'running' };
    let stdout = '';
    let stderr = '';
    let graceTimer: NodeJS.Timeout | undefined;

    const groupKill = (): void => {
      state = { phase: 'group_killed' };
      try {
        if (detached && typeof proc.pid === 'number') {
          process.kill(-proc.pid, 'SIGKILL');
        } else {
          proc.kill('SIGKILL'); // nested: the ancestor's group sweep covers the rest
        }
      } catch {
        /* ESRCH — already reaped */
      }
    };

    const timer = setTimeout(() => {
      if (state.phase !== 'running') return;
      state = { phase: 'term_sent' };
      proc.kill('SIGTERM');
      // REF'D on purpose: an unref'd timer is destroyed when the hook bin
      // exits right after this rejection — SIGKILL would never fire exactly
      // where SIGTERM-ignoring orphans were observed. The ≤graceMs tail
      // sits far inside the 360s outer hook cap; 'closed_late' clears it
      // for well-behaved children.
      graceTimer = setTimeout(groupKill, opts.graceMs ?? 5_000);
      reject(opts.timeoutError(opts.timeoutMs));
    }, opts.timeoutMs);

    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });

    proc.on('error', (e) => {
      if (state.phase !== 'running') return;
      state = { phase: 'spawn_failed' };
      clearTimeout(timer);
      reject(new Error(`${prefix}spawn failed: ${e.message}`));
    });

    proc.on('close', (code) => {
      if (state.phase === 'running') {
        state = { phase: 'closed' };
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`${prefix}exit ${code}: ${stderr.trim()}`));
      } else if (state.phase === 'term_sent') {
        state = { phase: 'closed_late' }; // child obeyed SIGTERM inside grace
        if (graceTimer !== undefined) clearTimeout(graceTimer);
      }
      // closed / spawn_failed / group_killed: terminal — nothing to do.
    });

    try {
      proc.stdin.write(opts.prompt);
      proc.stdin.end();
    } catch (e) {
      if (state.phase === 'running') {
        state = { phase: 'spawn_failed' };
        clearTimeout(timer);
        reject(new Error(`${prefix}stdin write failed: ${String(e)}`));
      }
    }
  });
}
