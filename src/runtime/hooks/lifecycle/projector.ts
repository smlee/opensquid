import { isLoopLap } from '../subagent_guard.js';
import type { Directive } from '../../types.js';

import type { Actor, LifecycleContext, LifecycleRole } from './types.js';

export interface ExistingHostLifecycleCarrier {
  readonly agent_id?: string;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function extractExistingHostLifecycleCarrier(raw: string): ExistingHostLifecycleCarrier {
  try {
    const parsed = JSON.parse(raw) as { agent_id?: unknown };
    const agentId = nonEmpty(parsed.agent_id);
    return agentId === undefined ? {} : { agent_id: agentId };
  } catch {
    return {};
  }
}

export function projectExistingHostActorAndRole(
  carrier: ExistingHostLifecycleCarrier,
  env: NodeJS.ProcessEnv = process.env,
): { actor: Actor; role: LifecycleRole } {
  const agentId = nonEmpty(carrier.agent_id);
  if (agentId !== undefined) {
    return {
      actor: { kind: 'executor', id: agentId },
      role: 'lap-child',
    };
  }
  return {
    actor: { kind: 'orchestrator' },
    role: isLoopLap(env) ? 'lap-parent' : 'interactive',
  };
}

export function projectExistingHostLifecycleContext(input: {
  sessionId: string;
  cwd: string;
  raw: string;
  now?: string;
  env?: NodeJS.ProcessEnv;
}): LifecycleContext {
  const env = input.env ?? process.env;
  const itemId = nonEmpty(env.OPENSQUID_ITEM_ID);
  return {
    sessionId: input.sessionId,
    ...(itemId === undefined ? {} : { itemId }),
    cwd: input.cwd,
    ...projectExistingHostActorAndRole(extractExistingHostLifecycleCarrier(input.raw), env),
    now: input.now ?? new Date().toISOString(),
  };
}

export function formatDirectiveBlock(directives: readonly Directive[]): string | null {
  if (directives.length === 0) return null;
  return (
    '⛔ DIRECTIVE — next action required:\n' +
    '```json\n' +
    JSON.stringify(directives, null, 2) +
    '\n```'
  );
}
