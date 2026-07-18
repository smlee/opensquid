import { describe, expect, it } from 'vitest';
import {
  PI_TOOL_CATALOG,
  canonicalPiPolicyName,
  enabledPiOptionalTools,
  findPiCapability,
  mcpDirectTools,
  stagePiTools,
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
      'set_loop_phase',
    ]);
    for (const tool of PI_TOOL_CATALOG) {
      expect(canonicalPiPolicyName(tool.name)).toBe(tool.canonicalPolicyName);
      expect(findPiCapability(tool.name)).toEqual(tool);
      expect(tool).not.toHaveProperty('audiences');
    }
    expect(canonicalPiPolicyName('unknown_tool')).toBe('unknown_tool');
  });

  it('derives the technical StageProcess and MCP surfaces without nested execution authority', () => {
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
    expect(stagePiTools()).toEqual(
      PI_TOOL_CATALOG.filter((tool) => tool.required).map((tool) => tool.name),
    );
    expect(stagePiTools()).not.toContain('set_loop_phase');
  });

  it('enables only the optional set_loop_phase capability when requested', () => {
    const optional = enabledPiOptionalTools({ enableLoopPhase: true });
    expect(optional).toEqual(new Set(['set_loop_phase']));
    expect(mcpDirectTools(optional)).toContain('set_loop_phase');
    expect(stagePiTools(optional)).toContain('set_loop_phase');
  });
});
