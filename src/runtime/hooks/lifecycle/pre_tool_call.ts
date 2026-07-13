import {
  buildRegistry,
  loadActivePacksForDispatch,
  loadActiveV2Cartridges,
  projectDeclaresOrchestratorOnly,
} from '../../bootstrap.js';
import type { FunctionRegistry } from '../../../functions/registry.js';
import type { LoadedPackV2 } from '../../../packs/loader_v2.js';
import type { Pack } from '../../types.js';
import { runV2SkillHost } from '../../loop/v2_skill_host.js';
import { runV2Cartridges, type V2Decision } from '../../loop/v2_supply.js';
import { parseApplyPatch } from '../apply_patch.js';
import { appendTool, recordSessionCwd } from '../../session_state.js';
import { mirrorActiveTask } from '../active_task_mirror.js';
import { runHarnessGraphSync } from '../harness_graph_sync.js';
import { dispatchEvent } from '../dispatch.js';
import { checkSafety } from '../../guard/safety_floor.js';
import { loadSafetyPolicy } from '../../guard/safety_policy.js';
import { isYoloMode } from '../../guard/yolo.js';
import { checkDesignDocRewrite, checkOrchestratorGuard } from '../../guard/orchestrator_guard.js';
import { scopeAuditCacheKey } from '../../scope_audit_cache_key.js';
import { appendProjectDriftEvent } from '../../drift_catalog.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveProjectScopeRoot, sessionStateFile } from '../../paths.js';
import { readSettings } from '../../orchestrator_settings.js';

import type { PreToolDecision, ToolCallInput, LifecycleContext } from './types.js';

async function readScopeAuditVerdict(sessionId: string, key: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(sessionStateFile(sessionId, key), 'utf8')) as {
      verdict?: unknown;
    };
    return typeof parsed.verdict === 'string' ? parsed.verdict : undefined;
  } catch {
    return undefined;
  }
}

export interface PreToolCallHandlerDeps {
  appendTool(sessionId: string, tool: string, command?: string): Promise<void>;
  recordSessionCwd(sessionId: string, cwd: string): Promise<void>;
  mirrorActiveTask(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    base?: string,
    transcriptPath?: string,
  ): Promise<void>;
  runHarnessGraphSync(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    transcriptPath?: string,
  ): Promise<string | null>;
  loadSafetyPolicy: typeof loadSafetyPolicy;
  isYoloMode(cwd: string): Promise<boolean>;
  appendProjectDriftEvent: typeof appendProjectDriftEvent;
  projectDeclaresOrchestratorOnly(cwd: string): Promise<boolean>;
  readSettings(cwd: string): Promise<{ allow_code_write?: boolean }>;
  resolveProjectScopeRoot(cwd: string): Promise<string | null>;
  checkDesignDocRewrite: typeof checkDesignDocRewrite;
  readScopeAuditVerdict(sessionId: string, key: string): Promise<string | undefined>;
  loadDispatch(sessionId: string): Promise<{
    packs: Pack[];
    registry: FunctionRegistry;
  }>;
  dispatchEvent: typeof dispatchEvent;
  loadActiveV2Cartridges(sessionId: string): Promise<readonly LoadedPackV2[]>;
  runV2SkillHost: typeof runV2SkillHost;
  runV2Cartridges: typeof runV2Cartridges;
}

const DEFAULT_DEPS: PreToolCallHandlerDeps = {
  appendTool,
  recordSessionCwd,
  mirrorActiveTask,
  runHarnessGraphSync,
  loadSafetyPolicy,
  isYoloMode,
  appendProjectDriftEvent,
  projectDeclaresOrchestratorOnly,
  readSettings,
  resolveProjectScopeRoot,
  checkDesignDocRewrite,
  readScopeAuditVerdict,
  loadDispatch: async (sessionId) => ({
    packs: await loadActivePacksForDispatch(sessionId),
    registry: await buildRegistry(),
  }),
  dispatchEvent,
  loadActiveV2Cartridges,
  runV2SkillHost,
  runV2Cartridges,
};

const actorAgentId = (ctx: LifecycleContext): string | undefined =>
  ctx.actor.kind === 'executor' ? ctx.actor.id : undefined;

export async function runPreToolCall(
  input: ToolCallInput,
  ctx: LifecycleContext,
  deps: PreToolCallHandlerDeps = DEFAULT_DEPS,
): Promise<PreToolDecision> {
  const event = input.event;
  const diagnostics: string[] = [];
  let harnessSyncInstruction: string | null = null;
  try {
    const cmd = (event.args as { command?: unknown }).command;
    await deps.appendTool(ctx.sessionId, event.tool, typeof cmd === 'string' ? cmd : undefined);
  } catch (error) {
    diagnostics.push(`opensquid: tool-ledger append failed — ${String(error)}`);
  }
  if (event.cwd !== undefined && event.cwd !== '') {
    try {
      await deps.recordSessionCwd(ctx.sessionId, event.cwd);
    } catch (error) {
      diagnostics.push(`opensquid: session-cwd record failed — ${String(error)}`);
    }
  }

  try {
    await deps.mirrorActiveTask(
      ctx.sessionId,
      event.tool,
      event.args ?? {},
      undefined,
      input.transcriptPath,
    );
  } catch (error) {
    diagnostics.push(`opensquid: active-task mirror failed — ${String(error)}`);
  }
  try {
    harnessSyncInstruction = await deps.runHarnessGraphSync(
      ctx.sessionId,
      event.tool,
      event.args ?? {},
      input.transcriptPath,
    );
  } catch (error) {
    diagnostics.push(`opensquid: harness→work-graph sync failed — ${String(error)}`);
  }

  const cwd = event.cwd ?? ctx.cwd;
  const hookAgentId = actorAgentId(ctx);
  const hookInput = hookAgentId === undefined ? undefined : { agent_id: hookAgentId };
  try {
    const verdict = checkSafety(
      { tool: event.tool, args: event.args },
      await deps.loadSafetyPolicy(),
      { dangerousToWarn: await deps.isYoloMode(cwd) },
    );
    if (verdict.action === 'block' || verdict.action === 'halt') {
      return {
        block: true,
        reason: `🦑 [safety floor] ${verdict.message ?? 'forbidden action'}`,
        contextInjections: [],
        diagnostics,
      };
    }
    if (verdict.action === 'warn') {
      diagnostics.push(
        `🦑 [safety floor · YOLO] ${verdict.message ?? 'dangerous action'} — allowed (block→warn). hardline rules (rm -rf, substrate delete, .env) still enforced.`,
      );
      try {
        await deps.appendProjectDriftEvent(cwd, {
          timestamp: ctx.now,
          pack: '<safety-floor>',
          ruleId: `safety:${verdict.ruleId ?? 'dangerous'}`,
          level: 'warn',
          message: verdict.message ?? '',
        });
      } catch {
        // fail-open
      }
    }
  } catch {
    // fail-open
  }

  try {
    if (await deps.projectDeclaresOrchestratorOnly(cwd)) {
      const scopeRoot = await deps.resolveProjectScopeRoot(cwd);
      const allowByConfig =
        scopeRoot !== null &&
        (await deps.readSettings(dirname(scopeRoot))).allow_code_write === true;
      const allowByLegacyFlag =
        scopeRoot !== null && existsSync(join(scopeRoot, 'allow-code-write'));
      const verdict = checkOrchestratorGuard(event.tool, event.args, hookInput, {
        codeWritePermitted: allowByConfig || allowByLegacyFlag,
      });
      if (verdict.deny) {
        return {
          block: true,
          reason: verdict.message ?? '',
          contextInjections: [],
          diagnostics,
        };
      }
      const design = await deps
        .checkDesignDocRewrite(event.tool, event.args, hookInput, {
          readScopeVerdict: () => {
            const dfp = event.args?.file_path;
            return deps.readScopeAuditVerdict(
              ctx.sessionId,
              scopeAuditCacheKey(typeof dfp === 'string' ? dfp : ''),
            );
          },
        })
        .catch(() => ({ deny: false as const }));
      if (design.deny) {
        return {
          block: true,
          reason: design.message ?? '',
          contextInjections: [],
          diagnostics,
        };
      }
    }
  } catch {
    // fail-open
  }

  const { packs, registry } = await deps.loadDispatch(ctx.sessionId);
  if (event.tool === 'apply_patch') {
    const cmd = (event.args as { command?: unknown }).command;
    const patched = typeof cmd === 'string' ? parseApplyPatch(cmd) : [];
    if (patched.length > 0) {
      for (const file of patched) {
        const synth = {
          ...event,
          tool: 'Write',
          args: { file_path: file.path, content: file.content, apply_patch_command: cmd },
        };
        const result = await deps.dispatchEvent(synth, packs, registry, ctx.sessionId);
        if (result.exitCode === 2) {
          return {
            block: true,
            reason: result.stderr,
            contextInjections: [],
            diagnostics,
          };
        }
        if (result.stderr) diagnostics.push(result.stderr);
      }
      return { block: false, contextInjections: [], diagnostics };
    }
  }

  const v1 = await deps.dispatchEvent(event, packs, registry, ctx.sessionId);
  const skillHost = await deps.runV2SkillHost(
    await deps.loadActiveV2Cartridges(ctx.sessionId),
    event,
    registry,
    ctx.sessionId,
  );
  const isAutomation = process.env.OPENSQUID_AUTOMATION === '1';
  const v2Gate: V2Decision = isAutomation
    ? await deps.runV2Cartridges(ctx.sessionId, event, ctx.now, {
        enforceOnly: true,
      })
    : { exitCode: 0, messages: [], injections: [], boundSkills: [] };
  const blocked = v1.exitCode === 2 || skillHost.exitCode === 2 || v2Gate.exitCode === 2;
  const stderr = [v1.stderr, skillHost.stderr, ...(v2Gate.exitCode === 2 ? v2Gate.messages : [])]
    .filter((value) => value.length > 0)
    .join('\n');
  const contextInjections = [
    ...v1.contextInjections,
    ...skillHost.contextInjections,
    ...(harnessSyncInstruction !== null ? [harnessSyncInstruction] : []),
  ];
  return {
    block: blocked,
    ...(blocked ? { reason: stderr } : {}),
    contextInjections,
    diagnostics: [...diagnostics, ...(blocked ? [] : stderr.length > 0 ? [stderr] : [])],
  };
}
