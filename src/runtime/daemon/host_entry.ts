/**
 * DAEMON.1 — the host process entry point (T-fsm-actor-runtime §DAEMON.1).
 *
 * The detached child `client.ts` spawns. It does nothing but `startHost()` and stay
 * alive: signal + idle shutdown live inside the host handle. Kept tiny on purpose —
 * all lifecycle logic is in `host.ts` (testable), this is just the runnable shell.
 * If the boot lock is already held (another host owns the topology), `startHost`
 * throws and this process exits non-zero — the client's await-ready loop then finds
 * the winner's `runtime.json` and connects to it.
 */
import { startHost } from './host.js';

startHost().catch((err: unknown) => {
  process.stderr.write(`[opensquid] host failed to start: ${(err as Error).message}\n`);
  process.exit(1);
});
