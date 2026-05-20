/**
 * Trigger-source registry barrel (AUTO.5+).
 *
 * Re-exports every concrete trigger-source class plus its config + audit
 * shapes. The daemon imports trigger sources from this single entry point
 * so each future source (AUTO.6 inbound channel watcher, AUTO.7 cost
 * router gate) is added in one place rather than threaded through the
 * daemon's import list.
 *
 * Engine-vocabulary discipline: this is a runtime module — no consumer
 * product names leak in.
 *
 * Imports from: ./file_watcher.js.
 * Imported by: src/runtime/daemon.ts (at AUTO.5 wire-in time) + tests.
 */

export {
  FileWatcher,
  type FileWatcherConfig,
  type FileWatcherAuditEntry,
  type FileWatcherAuditSink,
} from './file_watcher.js';
