/**
 * Public barrel for `src/setup/cli/*` — re-exports the named entry points
 * the CLI binary (and external embedders) consume.
 *
 * Lean by design: each setup-cli subcommand registers itself via a
 * `register<X>(parent)` function that `src/cli.ts` calls; this barrel just
 * surfaces the names so a future consumer can `import { runChatSetupWizard }
 * from 'opensquid/setup/cli'` without reaching into a sub-module path.
 */

export { runChatSetupWizard, type WizardDeps, type WizardResult } from './chat_actions.js';
