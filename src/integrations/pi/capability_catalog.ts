export type PiToolOwner = 'builtin' | 'mcp:opensquid' | 'mcp:opensquid-chat' | 'extension';

export interface PiToolCapability {
  readonly name: string;
  readonly owner: PiToolOwner;
  readonly required: boolean;
  readonly canonicalPolicyName: string;
}

export const PI_TOOL_CATALOG = [
  { name: 'read', owner: 'builtin', required: true, canonicalPolicyName: 'Read' },
  { name: 'bash', owner: 'builtin', required: true, canonicalPolicyName: 'Bash' },
  { name: 'grep', owner: 'builtin', required: true, canonicalPolicyName: 'Grep' },
  { name: 'edit', owner: 'builtin', required: true, canonicalPolicyName: 'MultiEdit' },
  { name: 'write', owner: 'builtin', required: true, canonicalPolicyName: 'Write' },
  {
    name: 'workgraph_get',
    owner: 'mcp:opensquid',
    required: true,
    canonicalPolicyName: 'mcp__opensquid__workgraph_get',
  },
  {
    name: 'recall',
    owner: 'mcp:opensquid',
    required: true,
    canonicalPolicyName: 'mcp__opensquid__recall',
  },
  {
    name: 'read_state',
    owner: 'mcp:opensquid',
    required: true,
    canonicalPolicyName: 'mcp__opensquid__read_state',
  },
  {
    name: 'web_fetch',
    owner: 'mcp:opensquid',
    required: true,
    canonicalPolicyName: 'mcp__opensquid__web_fetch',
  },
  {
    name: 'decision_classify',
    owner: 'mcp:opensquid',
    required: true,
    canonicalPolicyName: 'mcp__opensquid__decision_classify',
  },
  {
    name: 'log_phase',
    owner: 'mcp:opensquid',
    required: true,
    canonicalPolicyName: 'mcp__opensquid__log_phase',
  },
  {
    name: 'workgraph_create_issue',
    owner: 'mcp:opensquid',
    required: true,
    canonicalPolicyName: 'mcp__opensquid__workgraph_create_issue',
  },
  {
    name: 'workgraph_add_edge',
    owner: 'mcp:opensquid',
    required: true,
    canonicalPolicyName: 'mcp__opensquid__workgraph_add_edge',
  },
  {
    name: 'workgraph_update_issue',
    owner: 'mcp:opensquid',
    required: true,
    canonicalPolicyName: 'mcp__opensquid__workgraph_update_issue',
  },
  {
    name: 'store_lesson',
    owner: 'mcp:opensquid',
    required: true,
    canonicalPolicyName: 'mcp__opensquid__store_lesson',
  },
  {
    name: 'spawn_subagent',
    owner: 'extension',
    required: true,
    canonicalPolicyName: 'spawn_subagent',
  },
  {
    name: 'set_loop_phase',
    owner: 'mcp:opensquid',
    required: false,
    canonicalPolicyName: 'mcp__opensquid__set_loop_phase',
  },
] as const satisfies readonly PiToolCapability[];

const EMPTY_SET = new Set<string>();

export function findPiCapability(name: string): PiToolCapability | undefined {
  return PI_TOOL_CATALOG.find((tool) => tool.name === name);
}

export function enabledPiOptionalTools(
  options: { enableLoopPhase?: boolean } = {},
): ReadonlySet<string> {
  return options.enableLoopPhase === true ? new Set(['set_loop_phase']) : EMPTY_SET;
}

export function mcpDirectTools(enabledOptional: ReadonlySet<string> = EMPTY_SET): string[] {
  return PI_TOOL_CATALOG.filter((tool) => tool.owner === 'mcp:opensquid')
    .filter((tool) => tool.required || enabledOptional.has(tool.name))
    .map((tool) => tool.name);
}

/** Technical parent surface; active packs and runtime guards retain policy authority. */
export function parentPiTools(enabledOptional: ReadonlySet<string> = EMPTY_SET): string[] {
  return PI_TOOL_CATALOG.filter((tool) => tool.required || enabledOptional.has(tool.name)).map(
    (tool) => tool.name,
  );
}

/** Translate explicit canonical role authority into this host's invocation names. */
export function piToolsForCanonical(canonicalTools: readonly string[]): string[] {
  return canonicalTools.map((canonical) => {
    const capability = PI_TOOL_CATALOG.find(
      (candidate) => candidate.canonicalPolicyName === canonical || candidate.name === canonical,
    );
    if (capability === undefined) {
      throw new Error(`Pi has no mapped capability for role tool ${canonical}`);
    }
    if (capability.name === 'spawn_subagent') {
      throw new Error('Pi executor roles cannot declare recursive spawn_subagent authority');
    }
    return capability.name;
  });
}

export function canonicalPiPolicyName(name: string): string {
  return findPiCapability(name)?.canonicalPolicyName ?? name;
}
