/**
 * WIZ.5 — `opensquid setup chat` commander wiring.
 *
 * Thin shim: parses three flags (--dry-run, --replace, --skip-test) and
 * delegates to `runChatSetupWizard()` from `./chat_actions.ts`. Mirrors the
 * registration shape of `permissions.ts` / `triggers.ts` / `schedule.ts`.
 *
 * Flag semantics (locked per WIZ.5 spec):
 *   --dry-run    Walk the wizard, render the plan preview, then EXIT without
 *                writing. Maps to `WizardDeps.dryRun = true`. The wizard
 *                short-circuits before `executePlan`. No backups created,
 *                no files modified.
 *   --replace    Skip the existing-config (idempotency) branch — proceed
 *                straight to authoring fresh config. Maps to
 *                `WizardDeps.replace = true`. The user still sees the
 *                dry-run preview + confirm before any write happens.
 *   --skip-test  Skip the WIZ.4 channel-test step. Implemented by setting
 *                `OPENSQUID_NO_BILLED_CALLS=1` in the wizard's env BEFORE
 *                invocation — the test step already honors this env var.
 *                We restore the prior value on exit so adjacent CLI calls
 *                in the same process aren't poisoned.
 *
 * Exit codes (inherited from `runChatSetupWizard`):
 *   0    completed | no_changes | dry_run
 *   1    concurrent_lock (another wizard running)
 *   2    malformed models.yaml (detection-time abort)
 *   3    write failure (rollback engaged)
 *
 * Default `setup` action: if a user runs `opensquid setup` with no
 * subcommand, commander prints the help text and exits 1 (commander's
 * default for "unknown subcommand"). We do NOT auto-start the chat wizard
 * from the bare `setup` verb — per WIZ.5 risk callout, the wizard must
 * be explicitly opt-in.
 *
 * Imports from: commander, ./chat_actions.
 * Imported by: src/cli.ts.
 */

import { runChatSetupWizard, type WizardDeps, type WizardResult } from './chat_actions.js';

import type { Command } from 'commander';

export interface ChatCliDeps {
  /** Test injection — override the wizard runner. Defaults to the real
   *  `runChatSetupWizard`. Tests substitute a stub that records its args. */
  runWizard?: (deps: WizardDeps) => Promise<WizardResult>;
  /** Test injection — override env access (read + write of OPENSQUID_NO_BILLED_CALLS).
   *  Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface ChatCliFlags {
  dryRun?: boolean;
  replace?: boolean;
  skipTest?: boolean;
}

/**
 * Register the `setup chat` subcommand on the supplied `setup` parent
 * group. Returns the registered subcommand so callers can chain or inspect.
 */
export function registerChat(parent: Command, deps: ChatCliDeps = {}): Command {
  const runWizard = deps.runWizard ?? runChatSetupWizard;
  const env = deps.env ?? process.env;

  return parent
    .command('chat')
    .description(
      'Interactive chat-agent setup wizard (model alias + chat_agent.yaml + optional channel test)',
    )
    .option('--dry-run', 'render the write plan but DO NOT modify any files', false)
    .option('--replace', 'overwrite existing fast_chat alias (skips idempotency branch)', false)
    .option('--skip-test', 'skip the post-write channel-delivery test step', false)
    .action(async (flags: ChatCliFlags) => {
      const wizardDeps: WizardDeps = {};
      if (flags.dryRun === true) wizardDeps.dryRun = true;
      if (flags.replace === true) wizardDeps.replace = true;

      // --skip-test piggybacks on the existing OPENSQUID_NO_BILLED_CALLS=1
      // gate inside `runChannelTestStep`. We save/restore the prior value
      // so we don't pollute the host process's env for any sibling code
      // running in the same process (rare, but the CLI is also embedded
      // by some integration tests).
      const priorSkipFlag = env.OPENSQUID_NO_BILLED_CALLS;
      if (flags.skipTest === true) {
        env.OPENSQUID_NO_BILLED_CALLS = '1';
      }
      try {
        await runWizard(wizardDeps);
      } finally {
        if (flags.skipTest === true) {
          if (priorSkipFlag === undefined) delete env.OPENSQUID_NO_BILLED_CALLS;
          else env.OPENSQUID_NO_BILLED_CALLS = priorSkipFlag;
        }
      }
    });
}

/**
 * Register the `setup` parent verb group + all of its subcommands.
 *
 * Currently only `chat` lives here; future setup wizards (`setup channels`,
 * `setup permissions-wizard`, etc.) register against the same parent via
 * this function so `src/cli.ts` stays a one-liner.
 *
 * Bare `opensquid setup` prints help (per WIZ.5 risk callout — never
 * auto-run a wizard from an ambiguous verb).
 */
export function registerSetup(parent: Command, deps: ChatCliDeps = {}): Command {
  const setup = parent.command('setup').description('Interactive setup wizards');
  registerChat(setup, deps);
  return setup;
}
