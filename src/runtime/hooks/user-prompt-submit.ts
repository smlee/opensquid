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
import { exitIfSubagent } from './subagent_guard.js';
import type { PromptSubmitEvent } from '../event.js';
import { Event } from '../types.js';

import { defaultLifecyclePipeline } from './lifecycle/pipeline.js';
import {
  formatDirectiveBlock,
  projectExistingHostLifecycleContext,
} from './lifecycle/projector.js';
import { extractSessionId } from './session_id.js';
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
  agent_id?: string;
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
  const event = parsed.data as PromptSubmitEvent;
  const { exitCode, stderr, contextInjections, directives } =
    await defaultLifecyclePipeline.runPromptSubmit(
      { event },
      projectExistingHostLifecycleContext({
        sessionId,
        cwd: process.cwd(),
        raw,
      }),
    );

  const contextParts: string[] = [...contextInjections];
  const directiveBlock = formatDirectiveBlock(directives);
  if (directiveBlock !== null) contextParts.push(directiveBlock);
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
