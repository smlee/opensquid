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
import { buildRegistry, loadActivePacks, loadActiveV2Cartridges } from '../bootstrap.js';
import { orchestrate } from '../loop/orchestrate.js';
import { exitIfSubagent } from './subagent_guard.js';
import { claimUmbrellaLeaseForSession } from '../chat/claim_lease.js';
import { drainUmbrellaInbox } from '../chat/inbox_drain.js';
import { resetTurnLedger, writeRequestType } from '../session_state.js';
import { classifyRequestType } from '../request_type.js';
import { sha256Hex } from '../durable/run_id.js';
import { Event } from '../types.js';

import { dispatchEvent } from './dispatch.js';
import { detectNewProject } from './new_project_detect.js';
import { extractSessionId, recordCurrentSession } from './session_id.js';
import { emitDriftStderrAndExit } from './hook_output.js';
import { readLastAssistantText, readLastNTurns } from './transcript.js';
import { readOpenTasksFromTranscript } from './transcript_tasks.js';

/** FU.2: how many recent text-bearing turns lesson-capture classifies. Small to
 *  bound the classifier prompt size (the wedge gate runs every prompt_submit). */
const RECENT_TURNS_N = 6;

interface PromptSubmitPayload {
  prompt?: string;
  user_prompt?: string;
  transcript_path?: string;
  transcriptPath?: string;
}

function parsePayload(raw: string): unknown {
  const obj = JSON.parse(raw) as PromptSubmitPayload;
  return {
    kind: 'prompt_submit',
    prompt: obj.prompt ?? obj.user_prompt ?? '',
  };
}

/** Extract the transcript `.jsonl` path from a UserPromptSubmit payload (snake/camel). */
export function extractTranscriptPath(raw: string): string | null {
  try {
    const obj = JSON.parse(raw) as PromptSubmitPayload;
    const p = obj.transcript_path ?? obj.transcriptPath;
    return typeof p === 'string' && p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk as string;
  return data;
}

async function main(): Promise<void> {
  exitIfSubagent('user-prompt-submit'); // SUB.1: before stdin read / any state write
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

  // RJ.1: recover the SETTLED prior assistant turn from the transcript so
  // response-judging gates (honesty-ledger, phase-logging, d9-guard) can run
  // here at UserPromptSubmit instead of Stop. CC provides `transcript_path` and
  // the prior turn is already flushed at fire-time, so this has NO off-by-one
  // (contrast `stop.ts`, where the triggering response isn't flushed yet).
  // Fail-open: a read failure leaves `priorAssistantText` undefined (gates see
  // no claim) and never blocks the prompt — UPS always exits 0 on the happy
  // path; the prompt rides through regardless.
  if (parsed.data.kind === 'prompt_submit') {
    const transcriptPath = extractTranscriptPath(raw);
    if (transcriptPath !== null) {
      parsed.data.priorAssistantText = await readLastAssistantText(transcriptPath);
      // FU.2: multi-turn context for the wedge-gate lesson-capture skill.
      parsed.data.recentTurns = await readLastNTurns(transcriptPath, RECENT_TURNS_N);
      // ATM.2: the OPEN-task list for Gate B (task_list_generated). THIS CC
      // version keeps tasks in the transcript, not ~/.claude/tasks/, and the
      // function layer has no transcript_path — so the hook derives it here.
      parsed.data.openTasks = await readOpenTasksFromTranscript(transcriptPath);
    }
  }

  const sessionId = extractSessionId(raw);
  // Record the live session id so out-of-band processes (the `opensquid
  // automation on|off` CLI, run from a terminal that never sees this stdin)
  // can target the session the hooks actually key on. Best-effort.
  await recordCurrentSession(sessionId, process.cwd());
  // Interactive responder (chat mirrors the live session): claim/refresh this
  // umbrella's chat lease with the session id so the Stop-hook drive owns the
  // turn + the headless stands down. acquire-if-free; no-op in headless mode.
  await claimUmbrellaLeaseForSession(sessionId, process.cwd());
  // G.5 — a new turn starts on every UserPromptSubmit. Reset the per-turn
  // slice of the tool-call ledger so the freshness rule (read on the next
  // Stop event) sees only tools called during THIS turn. Session-wide list
  // is untouched. Best-effort: never crash the hook over ledger plumbing.
  try {
    await resetTurnLedger(sessionId);
  } catch (e) {
    process.stderr.write(`opensquid: tool-ledger turn-reset failed — ${String(e)}\n`);
  }
  // wg-3d175ec06767: classify the prompt ONCE here (the harness-neutral pre-dispatch
  // chokepoint — fires under Claude Code AND codex) and persist the request-type record, so
  // enter-scoping + the stop guards read ONE classification instead of re-deriving intent.
  // Deterministic + research-default-on-low-confidence; the llm refinement is a pack rule
  // (RTC.5, needs pack model config). Best-effort: never crash the hook over classification.
  if (parsed.data.kind === 'prompt_submit') {
    try {
      const cls = classifyRequestType(parsed.data.prompt);
      await writeRequestType(sessionId, {
        ...cls,
        source: 'deterministic',
        prompt_hash: sha256Hex(parsed.data.prompt).slice(0, 16),
        at: new Date().toISOString(),
      });
    } catch (e) {
      process.stderr.write(`opensquid: request-type classification failed — ${String(e)}\n`);
    }
  }
  // The idle → scoping transition is no longer hardcoded here — the opt-in
  // `coding-flow` pack's `enter-scoping` rule (entry-and-handoffs) matches
  // scope-authoring intent
  // through the dispatcher and advances its lifecycle FSM (the FSM's totality
  // makes scope_start a no-op once the workflow has already started). See
  // T-FSM-UNIFY.
  const packs = await loadActivePacks(sessionId);
  const registry = await buildRegistry();
  const { exitCode, stderr, contextInjections, directives } = await dispatchEvent(
    parsed.data,
    packs,
    registry,
    sessionId,
  );

  // G.4 — emit Claude Code's UserPromptSubmit JSON envelope on stdout when
  // any rule contributed an inject_context payload OR (T-ASC ASC.3) a
  // directive-level verdict. Per VERIFIED 2026-05-24 behavior, raw stdout
  // text is silently DISCARDED by Claude Code 2.x; only the
  // `hookSpecificOutput.additionalContext` JSON shape actually injects
  // additional prompt context. (The older `dist/anti-drift/evaluator.js`
  // legacy code that wrote raw stdout was relying on a deprecated path.)
  //
  // T-ASC L8: ONE envelope key (`additionalContext`) carries BOTH surfaces —
  // inject_context paragraphs first, then directives as a fenced JSON block
  // under a `⛔ DIRECTIVE` marker. No new envelope keys: Claude Code 2.x
  // doesn't reliably honor unknown ones. The fenced JSON gives the agent
  // human-readable context AND a future enforcer a machine-parseable
  // structured handoff (parse the JSON between the marker and the closing
  // fence). Per project_opensquid_no_agent_loop the AGENT dispatches — the
  // directive names skill/tool/args/rationale; opensquid never invokes it.
  //
  // Block-verdict coexistence (Phase-2 lock #7 + L8 extension): if the
  // block verdict fired AFTER an inject_context or directive payload, all
  // ride through — block wins on exitCode (2), but the additionalContext
  // still lands on stdout so the agent sees the recall context + directive
  // alongside the block message on the next prompt.
  // T-CTX-LOOP CTX.4 — surface a "new project detected" prompt at most
  // once per session. Routes through additionalContext alongside the
  // existing inject_context + directive surfaces.
  const newProjectLine = await detectNewProject(sessionId);
  // LL.4 — drain the inbound-message backlog into the same additionalContext
  // envelope as inject_context + directives + new-project. The drain block
  // runs under its own fail-open wrapper (drainInboxEnvelope returns '' on
  // any error). Inbox envelope appears FIRST in contextParts so it's the
  // most prominent surface in the agent's next-turn context.
  const inboxEnvelope = await drainUmbrellaInbox(sessionId);

  // ORCH.5 — the hard-coded general orchestrator. Classify the prompt, match a `serves`-bearing pack against the
  // active v2 catalog, and ACTIVATE it (write active.json → the existing runV2Cartridges runs its FSM next event);
  // a tie surfaces an ask. ADDITIVE + inert today (zero serves-packs → ZERO result). orchestrate() is fail-open.
  let orchInjections: string[] = [];
  if (parsed.data.kind === 'prompt_submit') {
    const v2packs = (await loadActiveV2Cartridges(sessionId)).map((c) => c.pack);
    const orch = await orchestrate(
      process.cwd(),
      parsed.data.prompt,
      true,
      v2packs,
      new Date().toISOString(),
    );
    orchInjections = orch.injections;
  }

  const contextParts: string[] = [];
  if (inboxEnvelope.length > 0) contextParts.push(inboxEnvelope);
  contextParts.push(...contextInjections);
  contextParts.push(...orchInjections);
  if (newProjectLine !== null) contextParts.push(newProjectLine);
  if (directives.length > 0) {
    const block =
      '⛔ DIRECTIVE — next action required:\n' +
      '```json\n' +
      JSON.stringify(directives, null, 2) +
      '\n```';
    contextParts.push(block);
  }
  if (contextParts.length > 0) {
    const envelope = {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: contextParts.join('\n\n'),
      },
    };
    process.stdout.write(JSON.stringify(envelope));
  }

  emitDriftStderrAndExit(exitCode, stderr);
}

main().catch((e: unknown) => {
  process.stderr.write(`opensquid hook crash (user-prompt-submit): ${String(e)}\n`);
  process.exit(0);
});
