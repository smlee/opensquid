#!/usr/bin/env node
/**
 * Claude Code `UserPromptSubmit` hook binary.
 *
 * Fires when the user submits a prompt (every turn). Payload carries the
 * raw prompt text — useful for skills that classify intent up-front or
 * surface heartbeat / recall reminders before the agent starts.
 *
 * Wired in `~/.claude/settings.json`:
 *
 *   { "hooks": { "UserPromptSubmit": [{ "hooks": [{ "type": "command",
 *     "command": "opensquid-hook-userpromptsubmit" }] }] } }
 *
 * stdin = prompt-submit JSON. exit 0 = let the prompt through, exit 2 =
 * block the prompt (Claude Code refuses to send it). Stderr is surfaced.
 *
 * Fail-open on any internal error.
 */
import { buildRegistry, loadActivePacks } from '../bootstrap.js';
import { readChainStage, transitionChainStage } from '../chain_state.js';
import { resetTurnLedger } from '../session_state.js';
import { Event } from '../types.js';

import { dispatchEvent } from './dispatch.js';
import { SCOPE_INTENT_REGEX } from './scope_intent.js';
import { extractSessionId, recordCurrentSession } from './session_id.js';

interface PromptSubmitPayload {
  prompt?: string;
  user_prompt?: string;
}

function parsePayload(raw: string): unknown {
  const obj = JSON.parse(raw) as PromptSubmitPayload;
  return {
    kind: 'prompt_submit',
    prompt: obj.prompt ?? obj.user_prompt ?? '',
  };
}

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk as string;
  return data;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    process.stderr.write('opensquid: empty UserPromptSubmit payload — proceeding\n');
    process.exit(0);
  }

  let normalized: unknown;
  try {
    normalized = parsePayload(raw);
  } catch (e) {
    process.stderr.write(`opensquid: invalid UserPromptSubmit JSON — ${String(e)}\n`);
    process.exit(0);
  }

  const parsed = Event.safeParse(normalized);
  if (!parsed.success) {
    process.stderr.write('opensquid: invalid UserPromptSubmit payload schema\n');
    process.exit(0);
  }

  const sessionId = extractSessionId(raw);
  // Record the live session id so out-of-band processes (the `opensquid
  // automation on|off` CLI, run from a terminal that never sees this stdin)
  // can target the session the hooks actually key on. Best-effort.
  await recordCurrentSession(sessionId);
  // G.5 — a new turn starts on every UserPromptSubmit. Reset the per-turn
  // slice of the tool-call ledger so the freshness rule (read on the next
  // Stop event) sees only tools called during THIS turn. Session-wide list
  // is untouched. Best-effort: never crash the hook over ledger plumbing.
  try {
    await resetTurnLedger(sessionId);
  } catch (e) {
    process.stderr.write(`opensquid: tool-ledger turn-reset failed — ${String(e)}\n`);
  }
  // ASC.1 — chain-state 'scoping' writer. Transition idle → scoping ONLY when
  // the prompt looks like scope-authoring intent AND the chain is currently
  // idle. The `currentStage === 'idle'` guard is load-bearing: many in-flight
  // prompts contain 'plan' / 'design' / 'spec' even when no new scope work is
  // starting; without the guard, every such prompt would reset the chain
  // mid-flight ('researched' or 'spec_authored' would silently regress to
  // 'scoping'). Best-effort — a chain-state failure must never block the
  // turn from starting.
  if (parsed.data.kind === 'prompt_submit') {
    try {
      const currentStage = await readChainStage(sessionId);
      if (currentStage === 'idle' && SCOPE_INTENT_REGEX.test(parsed.data.prompt)) {
        await transitionChainStage(sessionId, 'scoping');
      }
    } catch (e) {
      process.stderr.write(`opensquid: chain-state scoping-transition failed — ${String(e)}\n`);
    }
  }
  const packs = await loadActivePacks(sessionId);
  const registry = await buildRegistry();
  const { exitCode, stderr, contextInjections } = await dispatchEvent(
    parsed.data,
    packs,
    registry,
    sessionId,
  );

  // G.4 — emit Claude Code's UserPromptSubmit JSON envelope on stdout when
  // any rule contributed an inject_context payload. Per VERIFIED 2026-05-24
  // behavior, raw stdout text is silently DISCARDED by Claude Code 2.x; only
  // the `hookSpecificOutput.additionalContext` JSON shape actually injects
  // additional prompt context. (The older `dist/anti-drift/evaluator.js`
  // legacy code that wrote raw stdout was relying on a deprecated path.)
  //
  // Multiple skills' injections are joined with `\n\n` so the agent sees a
  // single coherent block of pre-prompt context. The dispatcher already
  // dropped any `inject_context` payloads that fired on non-prompt_submit
  // events (with a stderr warning), so by the time we get here the array
  // is safe to emit verbatim.
  //
  // Block-verdict coexistence (Phase-2 lock #7): if the block verdict fired
  // AFTER an inject_context payload, both ride through — the block wins on
  // exitCode (2), but the injection still lands on stdout so the user sees
  // the recall context alongside the block message on the next prompt.
  if (contextInjections.length > 0) {
    const envelope = {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: contextInjections.join('\n\n'),
      },
    };
    process.stdout.write(JSON.stringify(envelope));
  }

  if (stderr) process.stderr.write(stderr + '\n');
  process.exit(exitCode);
}

main().catch((e: unknown) => {
  process.stderr.write(`opensquid hook crash (user-prompt-submit): ${String(e)}\n`);
  process.exit(0);
});
