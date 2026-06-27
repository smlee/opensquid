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
    id: z.string().min(1).optional(), // stable rule id (used as the drift TYPE when a dangerous rule warns)
    tool: z.string().min(1).optional(), // exact tool name, or any tool when omitted
    argPattern: z.string().min(1), // a substring/prefix/path rule over the stringified args (NOT a heuristic)
    tier: z.enum(['hardline', 'dangerous']), // hardline → halt (never downgradable); dangerous → block (yolo→warn)
    message: z.string().min(1),
    // optional refinement so a substring fires ONLY in its dangerous form (avoids false-denies):
    //   'pipe_to_shell' = argPattern AND `| sh`/`| bash`;  'delete_verb' = argPattern AND a delete verb.
    match: z.enum(['pipe_to_shell', 'delete_verb']).optional(),
  })
  .strict();
export type SafetyRule = z.infer<typeof SafetyRule>;

/** An ALLOW rule: an action whose target matches is exempt from the forbid list (always passes). */
export const AllowRule = z
  .object({
    tool: z.string().min(1).optional(),
    argPattern: z.string().min(1),
  })
  .strict();
export type AllowRule = z.infer<typeof AllowRule>;

export const SafetyPolicy = z
  .object({
    forbid: z.array(SafetyRule).default([]),
    allow: z.array(AllowRule).default([]),
  })
  .strict();
export type SafetyPolicy = z.infer<typeof SafetyPolicy>;

/** The shipped DEFAULT seed: borrowed dangerous-command model + substrate self-protection (NO branding). */
// EVERY rule is TOOL-SCOPED: the floor must match the ACTION (a tool actually doing the dangerous thing),
// NOT mere CONTENT (a file or test that happens to mention the pattern). An un-scoped shell-command rule
// would deny `Write`/`Edit` of any file containing the string — the over-broad match the live floor caught.
// Tiering principle (see the substrate-floor discussion): HARDLINE = destructive + irreversible + never
// legitimate (no flag should EVER permit it) — `rm -rf /`, substrate DELETE (erases the ledger/memory/audit
// trail), `.env` secret exfil/write. DANGEROUS = risky but reversible + sometimes legitimate — substrate
// WRITE (activating a pack, updating config), `chmod 777`, `curl | sh`; these block by default but YOLO mode
// downgrades them to warn. ALLOW = files the agent routinely + legitimately authors — `context.md`.
//
// Order matters: checkSafety returns on FIRST forbid match, so the hardline `.env` and DELETE rules are
// listed BEFORE the broad dangerous `/.opensquid/` write rule (which would otherwise also match `.env`).
export const DEFAULT_SAFETY_POLICY: SafetyPolicy = {
  allow: [
    // context.md is the project context the agent legitimately authors (user-updatable) — always writable.
    { tool: 'Write', argPattern: '/.opensquid/context.md' },
    { tool: 'Edit', argPattern: '/.opensquid/context.md' },
  ],
  forbid: [
    // --- hardline: catastrophic, never legitimate ---
    {
      id: 'rm-rf-root',
      tool: 'Bash',
      argPattern: 'rm -rf /',
      tier: 'hardline',
      message: 'recursive root delete is forbidden',
    },
    {
      id: 'rm-rf-home',
      tool: 'Bash',
      argPattern: 'rm -rf ~',
      tier: 'hardline',
      message: 'recursive home delete is forbidden',
    },
    // --- hardline: substrate SECRET store (.env) — irreversible leak; never, not even under yolo ---
    {
      id: 'substrate-env-write',
      tool: 'Write',
      argPattern: '.opensquid/.env',
      tier: 'hardline',
      message: 'writing the opensquid secret store (.env) is forbidden',
    },
    {
      id: 'substrate-env-edit',
      tool: 'Edit',
      argPattern: '.opensquid/.env',
      tier: 'hardline',
      message: 'editing the opensquid secret store (.env) is forbidden',
    },
    {
      id: 'substrate-env-exfil',
      tool: 'Bash',
      argPattern: '.opensquid/.env',
      tier: 'hardline',
      message: 'exfiltrating the opensquid secret store via a shell is forbidden',
    },
    // --- hardline: substrate DELETE — destroys the ledger/memory/audit trail; never, not even under yolo ---
    {
      id: 'substrate-delete',
      tool: 'Bash',
      argPattern: '.opensquid/',
      tier: 'hardline',
      match: 'delete_verb',
      message: 'deleting opensquid substrate state is forbidden',
    },
    // --- dangerous: substrate WRITE/EDIT — reversible config; block by default, YOLO downgrades to warn ---
    {
      id: 'substrate-write',
      tool: 'Write',
      argPattern: '/.opensquid/',
      tier: 'dangerous',
      message: 'writing opensquid substrate state',
    },
    {
      id: 'substrate-edit',
      tool: 'Edit',
      argPattern: '/.opensquid/',
      tier: 'dangerous',
      message: 'editing opensquid substrate state',
    },
    // --- dangerous: borrowed dangerous-command model ---
    {
      id: 'chmod-777',
      tool: 'Bash',
      argPattern: 'chmod 777',
      tier: 'dangerous',
      message: 'world-writable chmod is dangerous',
    },
    {
      id: 'pipe-to-shell',
      tool: 'Bash',
      argPattern: 'curl',
      tier: 'dangerous',
      match: 'pipe_to_shell',
      message: 'piping a remote script to a shell is dangerous',
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
