/**
 * DAEMON.1 — the dedicated runtime daemon host (T-fsm-actor-runtime §DAEMON.1, Q1=C).
 *
 * One long-lived per-machine Node process that hosts the actor network (bus +
 * topology + supervisor). It binds 127.0.0.1 ONLY on a random port, authenticates
 * every request with a per-boot token, and is discoverable via `runtime.json`
 * (state_file.ts). Single-instance via a `proper-lockfile` boot lock — acquiring it
 * IS the Q1 concurrency answer (first-owns-topology); a second host defers. On
 * graceful shutdown (signal or idle) it persists actor state, writes the GR.1
 * shutdown marker, unlinks the state file, and releases the lock — in THAT order,
 * so the next boot classifies a clean `resume` (a crash skips the marker → recovery).
 *
 * The lifecycle is a real FSM (`fsm.ts`), not ad-hoc booleans:
 *   idle → starting → running → draining → stopped   (starting → stopped on boot failure)
 *
 * Borrows gstack's proven daemon shape (`browse/src/server.ts`: localhost HTTP ·
 * random port via net.createServer probe · token auth · idle-shutdown · state file)
 * re-implemented for Node ≥ 20 (built-in `node:http`, global `fetch`) — NO bun.
 *
 * `startHost` returns a HANDLE ({ port, token, stop }); `stop()` performs the graceful
 * shutdown WITHOUT `process.exit` (testable). The CLI entry + signal handlers call
 * `stop()` then exit — keeping the core pure of process-killing side effects.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { randomBytes, randomInt } from 'node:crypto';

import lockfile from 'proper-lockfile';

import { Bus } from '../bus/bus.js';
import type { Envelope } from '../bus/types.js';
import { step, validateFsm, type Fsm } from '../fsm.js';
import { Topology } from '../topology/topology.js';
import { OPENSQUID_HOME } from '../paths.js';
import { writeShutdownMarker } from '../genesis/shutdown_marker.js';
import { runtimeStatePath, unlinkRuntimeState, writeRuntimeState } from './state_file.js';

/** The host lifecycle FSM (reused `fsm.ts`, total transitions — not booleans). */
export const HOST_FSM: Fsm = {
  initial: 'idle',
  states: ['idle', 'starting', 'running', 'draining', 'stopped'],
  transitions: [
    { from: 'idle', on: 'start', to: 'starting' },
    { from: 'starting', on: 'ready', to: 'running' },
    { from: 'starting', on: 'fail', to: 'stopped' }, // boot failure path
    { from: 'running', on: 'drain', to: 'draining' },
    { from: 'draining', on: 'stopped', to: 'stopped' },
  ],
};

export interface HostHandle {
  port: number;
  token: string;
  state: () => string; // current lifecycle FSM state
  bus: Bus;
  topology: Topology;
  stop: (reason: string) => Promise<void>; // graceful: persist → marker → unlink → release (no exit)
}

export interface StartHostOpts {
  idleMs?: number;
  home?: string;
  /** how the host snapshots actor state for resume (GR.1); defaults to a topology digest. */
  digest?: () => string;
}

/** gstack-style free-port probe: bind+close on 127.0.0.1 to confirm availability. */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createNetServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function findFreePort(): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = randomInt(10000, 60000); // crypto.randomInt — uniform, no Math.random
    if (await isPortAvailable(port)) return port;
  }
  throw new Error('[opensquid] no free port after 5 attempts in 10000–60000');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Start the host. Acquires the boot lock (single-instance), brings up the bus +
 * topology, binds a token-authed localhost server, writes `runtime.json`, and arms
 * idle + signal shutdown. Returns a handle whose `stop()` shuts down gracefully.
 */
export async function startHost(opts: StartHostOpts = {}): Promise<HostHandle> {
  const home = opts.home ?? OPENSQUID_HOME();
  const idleMs = opts.idleMs ?? 30 * 60_000;

  if (validateFsm(HOST_FSM).length > 0) throw new Error('[opensquid] HOST_FSM invalid'); // fail-loud
  let lifecycle = HOST_FSM.initial;
  const advance = (event: string): void => {
    const r = step(HOST_FSM, lifecycle, event);
    lifecycle = r.next;
  };
  advance('start'); // idle → starting

  // 1) SINGLE-INSTANCE boot lock = Q1 first-owns-topology. `stale` lets a dead host's lock expire
  //    so a crash never wedges the next boot; `realpath:false` because the lock target may not exist.
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(runtimeStatePath(home), { realpath: false, stale: 15_000 });
  } catch (err) {
    advance('fail'); // starting → stopped
    throw new Error(
      `[opensquid] another host owns the runtime (boot lock held): ${(err as Error).message}`,
    );
  }

  // 2) actor substrate (BUS.1 + TOPO.1; SUP.1 wraps actors as they connect). Genesis reconcile
  //    (GR.1) is wired by the caller that knows the descriptor set; the host owns the live topology.
  const bus = new Bus();
  const topology = new Topology(bus);
  const digest = opts.digest ?? (() => `topology:${topology.connected().sort().join(',')}`);

  // 3) token-authed localhost server. Bind 127.0.0.1 ONLY — never reachable by other users.
  const token = randomBytes(24).toString('base64url');
  const port = await findFreePort();
  let idleTimer: NodeJS.Timeout;
  const resetIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void handle.stop('idle'), idleMs);
    idleTimer.unref?.(); // never keep the process alive solely for the idle timer
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      resetIdle();
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end('unauthorized'); // token required on EVERY route
        return;
      }
      if (req.method === 'GET' && req.url === '/ping') {
        res.writeHead(200).end('ok');
        return;
      }
      if (req.method === 'POST' && req.url === '/envelope') {
        try {
          const env = JSON.parse(await readBody(req)) as Envelope;
          bus.publish(env);
          res.writeHead(200).end('{"ok":true}');
        } catch {
          res.writeHead(400).end('bad envelope');
        }
        return;
      }
      res.writeHead(404).end('not found');
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  await writeRuntimeState({ port, token, pid: process.pid, startedAt: Date.now() }, home);
  advance('ready'); // starting → running
  resetIdle();

  let stopping = false;
  const handle: HostHandle = {
    port,
    token,
    bus,
    topology,
    state: () => lifecycle,
    // Graceful shutdown ordering is LOAD-BEARING (GR.1): persist state + write the marker
    // BEFORE unlinking runtime.json, else the next boot mis-classifies crash vs clean.
    stop: async (reason: string): Promise<void> => {
      if (stopping) return; // exactly-once
      stopping = true;
      advance('drain'); // running → draining
      clearTimeout(idleTimer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await writeShutdownMarker(digest(), home); // persist-then-marker (clean resume signal)
      await unlinkRuntimeState(home); // discovery file gone → clients auto-start next time
      await release(); // release the boot lock LAST (a new host can now own the topology)
      advance('stopped'); // draining → stopped
      void reason;
    },
  };

  // 4) signals → graceful shutdown then exit. The exit lives HERE (not in stop()) so stop() stays
  //    testable; tests call stop() directly and assert the marker/unlink without killing the runner.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => void handle.stop(sig).then(() => process.exit(0)));
  }

  return handle;
}
