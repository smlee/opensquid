/**
 * T3a — the agent registry: the MODEL-AGNOSTIC WHO substrate (T-fsm-actor-rescope §T3a).
 *
 * Genesis resolves three registries — workspace (WHERE), topology (WHAT), and AGENT (WHO). This is the WHO:
 * one `AgentEntry` per connected agent. `executor` is a FREE-FORM backend id (`'claude' | 'gpt' | 'codex' | …`),
 * so any subscription model is first-class — adding a model needs NO schema change. Agents `register()` while
 * live, self-declaring their executor/capabilities/scope/role; a per-state `executor(S)` reference then resolves
 * to a live agent providing that backend (the substrate that makes "Claude talks to GPT" mechanical).
 *
 * Liveness is the LEASE, not a guess: `isLeaseFresh` over the agent's `live_session_lease` — a total FSM
 * (fresh ⇒ connected, stale ⇒ disconnected). No "assume up". Identity (harness/id) is seeded from `claimAudience`
 * + the lease; the four self-declared fields come from the agent's own `register()` payload.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { isLeaseFresh, readLease } from '../chat/live_session_lease.js';
import type { ClaimAudience } from '../../workgraph/types.js';

export interface AgentEntry {
  id: string; // ← live_session_lease.session_id (present in all cases)
  harness: 'claudecode' | 'codex' | 'unknown'; // ← claimAudience.source
  executor: string; // ← register() payload; FREE-FORM backend ('claude' | 'gpt' | 'codex' | …)
  auth: 'host-inherited'; // ← design literal (no creds stored here)
  capabilities: string[]; // ← register() payload
  scope: 'user' | 'project'; // ← register() payload
  role: string; // ← register() payload
  leasePath: string; // the live_session_lease backing the liveness FSM
}

export type Liveness = 'connected' | 'disconnected';

export class AgentRegistry {
  private readonly entries = new Map<string, AgentEntry>();

  register(e: AgentEntry): void {
    this.entries.set(e.id, e);
  }

  async liveness(id: string, now: Date = new Date()): Promise<Liveness> {
    const e = this.entries.get(id);
    if (e === undefined) return 'disconnected';
    return isLeaseFresh(await readLease(e.leasePath), now) ? 'connected' : 'disconnected';
  }

  /**
   * Live entries providing `executor`, ordered self-first then most-recent `refreshed_at`; `[]` ⇒ the caller
   * fail-closes. Only lease-FRESH entries are returned — a stale lease is never "assumed up".
   */
  async resolve(executor: string, selfId: string, now: Date = new Date()): Promise<AgentEntry[]> {
    const live: { e: AgentEntry; refreshedAt: string }[] = [];
    for (const e of this.entries.values()) {
      if (e.executor !== executor) continue;
      const lease = await readLease(e.leasePath);
      if (lease === null || !isLeaseFresh(lease, now)) continue; // lease-fresh only — no assume-up
      live.push({ e, refreshedAt: lease.refreshed_at });
    }
    live.sort((a, b) =>
      a.e.id === selfId ? -1 : b.e.id === selfId ? 1 : b.refreshedAt.localeCompare(a.refreshedAt),
    );
    return live.map((x) => x.e);
  }

  snapshot(): AgentEntry[] {
    return [...this.entries.values()];
  }
}

/** Assemble THIS host's own entry: identity from `claimAudience` + the lease, the four fields from its payload. */
export function buildSelfEntry(
  claim: ClaimAudience,
  leasePath: string,
  reg: { executor: string; capabilities: string[]; scope: 'user' | 'project'; role: string },
  sessionId: string, // = resolveSessionId(env) / the lease session_id
): AgentEntry {
  const harness: AgentEntry['harness'] =
    claim.source === 'claudecode' ? 'claudecode' : claim.source === 'codex' ? 'codex' : 'unknown';
  return { id: sessionId, harness, auth: 'host-inherited', leasePath, ...reg };
}

/**
 * Discover OTHER live agents from fresh leases in `leaseDir` → id+liveness STUBS (`executor: ''`). A stub is
 * liveness-VISIBLE but NOT executor-resolvable (its `executor` is empty until the remote agent registers its
 * backend via the cross-process channel — a future track). Excludes the self lease + stale leases.
 */
export async function discoverLiveStubs(
  leaseDir: string,
  selfId: string,
  now: Date = new Date(),
): Promise<AgentEntry[]> {
  const out: AgentEntry[] = [];
  for (const file of await readdir(leaseDir).catch(() => [])) {
    const leasePath = join(leaseDir, file);
    const lease = await readLease(leasePath);
    if (lease === null || lease.session_id === selfId || !isLeaseFresh(lease, now)) continue;
    out.push({
      id: lease.session_id,
      harness: 'unknown',
      executor: '', // a stub: not executor-resolvable until the remote agent registers a backend
      auth: 'host-inherited',
      capabilities: [],
      scope: 'user',
      role: '',
      leasePath,
    });
  }
  return out;
}

/** Seed the registry: the host's own register()ed entry + the discovered live stubs. */
export function seedAgentRegistry(self: AgentEntry, otherLiveStubs: AgentEntry[]): AgentRegistry {
  const r = new AgentRegistry();
  r.register(self);
  for (const s of otherLiveStubs) r.register(s); // stubs (executor:'') are liveness-visible, not executor-resolvable
  return r;
}
