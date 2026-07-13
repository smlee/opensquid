import { describe, expect, it } from 'vitest';
import {
  PI_TOOL_CATALOG,
  canonicalPiPolicyName,
  enabledPiOptionalTools,
  findPiCapability,
  mcpDirectTools,
  parentPiTools,
  piToolsForCanonical,
} from './capability_catalog.js';

describe('PI capability catalog', () => {
  it('covers each technical capability exactly once with its canonical policy name', () => {
    const names = PI_TOOL_CATALOG.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      'read',
      'bash',
      'grep',
      'edit',
      'write',
      'workgraph_get',
      'recall',
      'read_state',
      'web_fetch',
      'decision_classify',
      'log_phase',
      'workgraph_create_issue',
      'workgraph_add_edge',
      'workgraph_update_issue',
      'store_lesson',
      'spawn_subagent',
      'set_loop_phase',
    ]);
    for (const tool of PI_TOOL_CATALOG) {
      expect(canonicalPiPolicyName(tool.name)).toBe(tool.canonicalPolicyName);
      expect(findPiCapability(tool.name)).toEqual(tool);
      expect(tool).not.toHaveProperty('audiences');
    }
    expect(canonicalPiPolicyName('unknown_tool')).toBe('unknown_tool');
  });

  it('derives the technical parent and MCP surfaces without assigning child authority', () => {
    expect(mcpDirectTools()).toEqual([
      'workgraph_get',
      'recall',
      'read_state',
      'web_fetch',
      'decision_classify',
      'log_phase',
      'workgraph_create_issue',
      'workgraph_add_edge',
      'workgraph_update_issue',
      'store_lesson',
    ]);
    expect(parentPiTools()).toEqual(
      PI_TOOL_CATALOG.filter((tool) => tool.required).map((tool) => tool.name),
    );
    expect(parentPiTools()).not.toContain('set_loop_phase');
    expect(mcpDirectTools()).not.toContain('spawn_subagent');
  });

  it('maps explicit pack-role authority and rejects unknown or recursive tools', () => {
    expect(
      piToolsForCanonical(['Read', 'Write', 'MultiEdit', 'mcp__opensquid__workgraph_get']),
    ).toEqual(['read', 'write', 'edit', 'workgraph_get']);
    expect(() => piToolsForCanonical(['unknown'])).toThrow('no mapped capability');
    expect(() => piToolsForCanonical(['spawn_subagent'])).toThrow('cannot declare recursive');
  });

  it('enables only the optional set_loop_phase capability when requested', () => {
    const optional = enabledPiOptionalTools({ enableLoopPhase: true });
    expect(optional).toEqual(new Set(['set_loop_phase']));
    expect(mcpDirectTools(optional)).toContain('set_loop_phase');
    expect(parentPiTools(optional)).toContain('set_loop_phase');
  });
});
