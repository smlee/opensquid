#!/usr/bin/env node
/**
 * Claude Code `PreToolUse` hook binary.
 *
 * Wired in `~/.claude/settings.json` (or per-project `.claude/settings.json`):
 *
 *   { "hooks": { "PreToolUse": [{ "matcher": "Bash",
 *     "hooks": [{ "type": "command",
 *       "command": "opensquid-hook-pretooluse" }] }] } }
 *
 * stdin = Claude Code's tool-call JSON. stdout = empty. stderr = drift
 * messages (shown to the user/agent). exit code 0 = allow, 2 = block.
 *
 * Payload normalization: Claude Code may use snake_case (`tool_name`,
 * `tool_input`, `session_id`); the runtime Event schema uses camelCase. We
 * normalize in `parsePayload` BEFORE handing to Zod so the schema stays pure.
 *
 * Fail-open: any internal crash exits 0 with a stderr message. NEVER block
 * the parent agent because of an opensquid bug. The `main().catch()` at the
 * bottom is the last line of defense.
 */
import { buildRegistry, loadActivePacks } from '../bootstrap.js';
import { transitionChainStage } from '../chain_state.js';
import { appendTool, recordSessionCwd } from '../session_state.js';
import { Event } from '../types.js';

import { mirrorActiveTask } from './active_task_mirror.js';
import { dispatchEvent } from './dispatch.js';
import { buildPreToolUseDeny } from './permission_decision.js';
import { extractSessionId } from './session_id.js';

/** ASC.1 PreToolUse chain-state writers — file-path / metadata patterns. */
const RESEARCH_ARTIFACT_RE = /docs\/research\/.*-pre-research-.*\.md$/;
const TRACK_SPEC_RE = /docs\/tasks\/T-.*\.md$/;

interface PreToolUsePayload {
  tool?: string;
  tool_name?: string;
  args?: Record<string, unknown>;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

function parsePayload(raw: string): unknown {
  const obj = JSON.parse(raw) as PreToolUsePayload;
  // Claude Code uses snake_case (tool_name / tool_input). Normalize to the
  // runtime Event shape (tool / args). Either form accepted.
  return {
    kind: 'tool_call',
    tool: obj.tool ?? obj.tool_name ?? '',
    args: obj.args ?? obj.tool_input ?? {},
    ...(obj.cwd !== undefined ? { cwd: obj.cwd } : {}),
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
    process.stderr.write('opensquid: empty PreToolUse payload — proceeding\n');
    process.exit(0);
  }

  let normalized: unknown;
  try {
    normalized = parsePayload(raw);
  } catch (e) {
    process.stderr.write(`opensquid: invalid PreToolUse JSON — ${String(e)}\n`);
    process.exit(0);
  }

  const parsed = Event.safeParse(normalized);
  if (!parsed.success) {
    process.stderr.write('opensquid: invalid PreToolUse payload schema\n');
    process.exit(0);
  }

  const sessionId = extractSessionId(raw);
  // G.5 — append this tool name to the session's per-turn ledger BEFORE
  // dispatching. Best-effort: a ledger-write failure must never block the
  // pending tool call (fail-open guarantee of the hook bin). The Stop-event
  // freshness rule reads this ledger via `session_tool_history`.
  if (parsed.data.kind === 'tool_call') {
    try {
      await appendTool(sessionId, parsed.data.tool);
    } catch (e) {
      process.stderr.write(`opensquid: tool-ledger append failed — ${String(e)}\n`);
    }
    // MAU.3 — record the session cwd so the SessionEnd memory reconcile can
    // resolve this project's auto-memory dir (SessionEnd carries no cwd).
    if (parsed.data.cwd !== undefined && parsed.data.cwd !== '') {
      try {
        await recordSessionCwd(sessionId, parsed.data.cwd);
      } catch (e) {
        process.stderr.write(`opensquid: session-cwd record failed — ${String(e)}\n`);
      }
    }
    // AP.1 — mirror the harness task store into active-task.json (the
    // tasks-loaded signal the gate-set keys off). Best-effort, like the writes
    // above: a mirror failure must never block the pending tool call.
    try {
      await mirrorActiveTask(sessionId, parsed.data.tool, parsed.data.args ?? {});
    } catch (e) {
      process.stderr.write(`opensquid: active-task mirror failed — ${String(e)}\n`);
    }
    // ASC.1 — chain-state PreToolUse writers. Detect research-artifact /
    // track-spec writes by file_path regex and TaskCreate/TaskUpdate by
    // metadata.taskId. transitionChainStage is idempotent on same-stage so
    // re-entering a stage doesn't double-write history. Ordered AFTER the
    // active-task mirror so ASC.2's `Skill.requires: chain_stage` (read by
    // the dispatcher below) sees the post-transition value.
    try {
      const tool = parsed.data.tool;
      const args = parsed.data.args ?? {};
      if (tool === 'Write' || tool === 'Edit') {
        const filePath =
          typeof (args as { file_path?: unknown }).file_path === 'string'
            ? (args as { file_path: string }).file_path
            : '';
        if (RESEARCH_ARTIFACT_RE.test(filePath)) {
          await transitionChainStage(sessionId, 'researched', { pre_research_path: filePath });
        } else if (TRACK_SPEC_RE.test(filePath)) {
          await transitionChainStage(sessionId, 'spec_authored', { spec_path: filePath });
        }
      } else if (tool === 'TaskCreate' || tool === 'TaskUpdate') {
        const meta = (args as { metadata?: { taskId?: unknown } }).metadata;
        if (meta !== undefined && typeof meta.taskId === 'string' && meta.taskId.length > 0) {
          await transitionChainStage(sessionId, 'tasks_loaded', { task_ids: [meta.taskId] });
        }
      }
    } catch (e) {
      process.stderr.write(`opensquid: chain-state write failed — ${String(e)}\n`);
    }
  }
  const packs = await loadActivePacks(sessionId);
  const registry = await buildRegistry();
  const { exitCode, stderr } = await dispatchEvent(parsed.data, packs, registry, sessionId);
  // T-RJ-FOLLOWUPS FU.11: a block must be signalled as a PreToolUse
  // `permissionDecision: "deny"` JSON decision, NOT a bare `exit 2`. Proven live:
  // under `--dangerously-skip-permissions` (= bypassPermissions) Claude Code
  // IGNORES a hook's `exit 2` (the tool runs anyway), but it HONORS a
  // `permissionDecision: "deny"` envelope. Emitting the JSON (exit 0) makes drift
  // gates enforce in BOTH normal and bypass modes. Gated strictly on
  // `exitCode === 2` so a non-block never accidentally denies the tool.
  if (exitCode === 2) {
    process.stdout.write(JSON.stringify(buildPreToolUseDeny(stderr)));
    process.exit(0);
  }
  if (stderr) process.stderr.write(stderr + '\n');
  process.exit(exitCode);
}

main().catch((e: unknown) => {
  // Fail-open: never crash the parent agent on opensquid's own bug.
  process.stderr.write(`opensquid hook crash (pre-tool-use): ${String(e)}\n`);
  process.exit(0);
});
