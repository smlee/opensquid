/**
 * T2 — the Safety floor's policy + config loader (T-fsm-actor-rescope §T2).
 *
 * "The config IS the security policy": the forbidden-action patterns live in
 * `~/.opensquid/safety-policy.json`, NOT as code literals — the same config-not-literals discipline the
 * Progress floor applies to its thresholds. `loadSafetyPolicy` reads that file and FAILS OPEN to a
 * shipped default seed (absent/corrupt ⇒ the seed, never a throw — the pre-tool-use hook is fail-open).
 *
 * The default seed borrows the dangerous-command MODEL (recursive delete, world-writable chmod, pipe a
 * remote script to a shell) plus opensquid substrate self-protection (no writing/deleting the state
 * stores, no exfiltrating the secret `.env`). The SOLUTION is borrowed; no framework name appears here.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { OPENSQUID_HOME } from '../paths.js';

export const SafetyRule = z
  .object({
    tool: z.string().min(1).optional(), // exact tool name, or any tool when omitted
    argPattern: z.string().min(1), // a substring/prefix/path rule over the stringified args (NOT a heuristic)
    tier: z.enum(['hardline', 'dangerous']), // hardline → halt; dangerous → block
    message: z.string().min(1),
    // optional refinement so a substring fires ONLY in its dangerous form (avoids false-denies):
    //   'pipe_to_shell' = argPattern AND `| sh`/`| bash`;  'delete_verb' = argPattern AND a delete verb.
    match: z.enum(['pipe_to_shell', 'delete_verb']).optional(),
  })
  .strict();
export type SafetyRule = z.infer<typeof SafetyRule>;

export const SafetyPolicy = z.object({ forbid: z.array(SafetyRule).default([]) }).strict();
export type SafetyPolicy = z.infer<typeof SafetyPolicy>;

/** The shipped DEFAULT seed: borrowed dangerous-command model + substrate self-protection (NO branding). */
// EVERY rule is TOOL-SCOPED: the floor must match the ACTION (a tool actually doing the dangerous thing),
// NOT mere CONTENT (a file or test that happens to mention the pattern). An un-scoped shell-command rule
// would deny `Write`/`Edit` of any file containing the string — the over-broad match the live floor caught.
export const DEFAULT_SAFETY_POLICY: SafetyPolicy = {
  forbid: [
    {
      tool: 'Bash',
      argPattern: 'rm -rf /',
      tier: 'hardline',
      message: 'recursive root delete is forbidden',
    },
    {
      tool: 'Bash',
      argPattern: 'rm -rf ~',
      tier: 'hardline',
      message: 'recursive home delete is forbidden',
    },
    {
      tool: 'Bash',
      argPattern: 'chmod 777',
      tier: 'dangerous',
      message: 'world-writable chmod is dangerous',
    },
    {
      tool: 'Bash',
      argPattern: 'curl',
      tier: 'dangerous',
      match: 'pipe_to_shell',
      message: 'piping a remote script to a shell is dangerous',
    },
    {
      tool: 'Write',
      argPattern: '/.opensquid/',
      tier: 'hardline',
      message: 'writing opensquid substrate state is forbidden',
    },
    {
      tool: 'Bash',
      argPattern: '.opensquid/',
      tier: 'hardline',
      match: 'delete_verb',
      message: 'deleting opensquid substrate state is forbidden',
    },
    {
      tool: 'Bash',
      argPattern: '.opensquid/.env',
      tier: 'hardline',
      message: 'exfiltrating the opensquid secret store via a shell is forbidden',
    },
  ],
};

/** The on-disk policy path (`~/.opensquid/safety-policy.json`). */
export const safetyPolicyPath = (): string => join(OPENSQUID_HOME(), 'safety-policy.json');

/** Load the policy from disk; FAIL OPEN to the default seed on absent/corrupt (never a throw). */
export async function loadSafetyPolicy(): Promise<SafetyPolicy> {
  try {
    return SafetyPolicy.parse(JSON.parse(await readFile(safetyPolicyPath(), 'utf8')));
  } catch {
    return DEFAULT_SAFETY_POLICY;
  }
}
