/** T3c — genesis boot caller: build the three descriptors + run reconcile (clean resume vs crash recovery). */
import { rm } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentRegistry, type AgentEntry } from '../registry/agent_registry.js';
import { buildGenesisWorld, runGenesis } from './boot.js';
import { shutdownMarkerPath, writeShutdownMarker } from './shutdown_marker.js';

const ENTRY = (id: string): AgentEntry => ({
  id,
  harness: 'unknown',
  executor: 'claude',
  auth: 'host-inherited',
  capabilities: [],
  scope: 'user',
  role: '',
  leasePath: `/leases/${id}.json`,
});

beforeEach(async () => {
  await rm(shutdownMarkerPath(), { force: true }); // clean slate — no marker
});
afterEach(async () => {
  await rm(shutdownMarkerPath(), { force: true });
});

describe('buildGenesisWorld (T3c)', () => {
  it('builds the three descriptors (workspace/topology/agent)', () => {
    const w = buildGenesisWorld({
      readProjects: () => Promise.resolve(null),
      topologyConnected: () => [],
      agents: new AgentRegistry(),
    });
    expect([w.workspace.actor, w.topology.actor, w.agent.actor]).toEqual([
      'workspace',
      'topology',
      'agent',
    ]);
  });

  it('an EMPTY agent registry classifies the agent actor as new_start; a non-empty one as resume', () => {
    const empty = buildGenesisWorld({
      readProjects: () => Promise.resolve(null),
      topologyConnected: () => [],
      agents: new AgentRegistry(),
    });
    expect(empty.agent.classify([])).toBe('new_start');
    const reg = new AgentRegistry();
    reg.register(ENTRY('a'));
    const nonEmpty = buildGenesisWorld({
      readProjects: () => Promise.resolve(null),
      topologyConnected: () => [],
      agents: reg,
    });
    expect(nonEmpty.agent.classify(reg.snapshot())).toBe('resume');
  });
});

describe('runGenesis (T3c)', () => {
  it('clean marker → recovery:false; all three actors classified', async () => {
    await writeShutdownMarker('test-digest');
    const r = await runGenesis(
      buildGenesisWorld({
        readProjects: () => Promise.resolve(null),
        topologyConnected: () => [],
        agents: new AgentRegistry(),
      }),
    );
    expect(r.recovery).toBe(false);
    expect(Object.keys(r.report.actors).sort()).toEqual(['agent', 'topology', 'workspace']);
    expect(r.report.actors.agent).toBe('new_start');
  });

  it('crash (no marker) → recovery:true; a would-be RESUME actor is parked as wedge', async () => {
    const reg = new AgentRegistry();
    reg.register(ENTRY('a')); // non-empty → the agent actor would classify `resume`
    const r = await runGenesis(
      buildGenesisWorld({
        readProjects: () => Promise.resolve(null),
        topologyConnected: () => [],
        agents: reg,
      }),
    );
    expect(r.recovery).toBe(true);
    expect(r.report.actors.agent).toBe('wedge'); // resume downgraded to wedge on a crash (reconcile owns this)
    expect(r.plan.agent?.mode).toBe('wedge');
  });
});
