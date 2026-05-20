/**
 * Tests for `CapabilityGate` (AUTO.3).
 *
 * Coverage:
 *   - shell_exec allowlist (exact + glob), metachar reject, pack-local deny
 *   - http_request hostname-exact + subdomain match, foot-gun, method gate,
 *     URL parse failure
 *   - file_write allowlist + built-in /etc + ~/.ssh deny + relative-path
 *   - undeclared paths (block-missing, non-interactive, prompt approve/deny)
 *   - prompt-throw + audit-sink-throw → DENY (C10)
 *   - OPENSQUID_TRUST_BUILTIN_DENY=0 escape hatch
 *   - audit log fires on every verdict
 *   - send_message + subprocess_call allowlists
 */

import { describe, expect, it, vi } from 'vitest';

import type { PermissionsType } from '../packs/schemas/index.js';

import {
  CapabilityGate,
  type CapabilityRequest,
  type CapabilityVerdict,
  type PackPermissions,
} from './capability_gate.js';

const HOME = '/home/test-user';

function gateFor(
  permissions: PermissionsType | undefined,
  extra: {
    prompt?: (req: CapabilityRequest) => Promise<boolean>;
    auditLog?: (v: CapabilityVerdict, r: CapabilityRequest) => void;
    trustBuiltinDeny?: boolean;
  } = {},
): CapabilityGate {
  const packs = new Map<string, PackPermissions>([
    ['p', permissions ? { name: 'p', permissions } : { name: 'p' }],
  ]);
  return new CapabilityGate({
    packs,
    ...(extra.prompt ? { prompt: extra.prompt } : {}),
    ...(extra.auditLog ? { auditLog: extra.auditLog } : {}),
    trustBuiltinDeny: extra.trustBuiltinDeny ?? true,
    homeDir: HOME,
  });
}

describe('CapabilityGate — shell_exec', () => {
  it('allowlist exact + glob → allowed', async () => {
    const gate = gateFor({
      shell_exec: { commands: ['git status', 'git log *', 'pnpm run *'], deny: [] },
    });
    for (const target of ['git status', 'git log --oneline -5', 'pnpm run test']) {
      const v = await gate.check({ pack: 'p', capability: 'shell_exec', target });
      expect(v.allowed).toBe(true);
      expect(v.source).toBe('declared');
    }
  });

  it('built-in denylist (rm -rf /) wins over broad allowlist', async () => {
    const gate = gateFor({ shell_exec: { commands: ['*'], deny: [] } });
    const v = await gate.check({ pack: 'p', capability: 'shell_exec', target: 'rm -rf /' });
    expect(v.allowed).toBe(false);
    expect(v.source).toBe('denylist');
    expect(v.message).toMatch(/built-in/);
  });

  it('shell metacharacter (;) blocks allowlist glob match', async () => {
    const gate = gateFor({ shell_exec: { commands: ['*'], deny: [] } });
    const v = await gate.check({
      pack: 'p',
      capability: 'shell_exec',
      target: 'git status; echo pwned',
    });
    expect(v.allowed).toBe(false);
    expect(v.source).toBe('denied');
  });

  it('exact-match allowlist allows metacharacter command (intentional escape hatch)', async () => {
    const gate = gateFor({ shell_exec: { commands: ['git log | head'], deny: [] } });
    const v = await gate.check({ pack: 'p', capability: 'shell_exec', target: 'git log | head' });
    expect(v.allowed).toBe(true);
    expect(v.source).toBe('declared');
  });

  it('pack-local deny wins over pack allowlist', async () => {
    const gate = gateFor({ shell_exec: { commands: ['git *'], deny: ['git push *'] } });
    const v = await gate.check({
      pack: 'p',
      capability: 'shell_exec',
      target: 'git push origin main',
    });
    expect(v.allowed).toBe(false);
    expect(v.source).toBe('denylist');
    expect(v.message).toMatch(/pack-local/);
  });
});

describe('CapabilityGate — http_request', () => {
  it('hostname-exact match → allowed', async () => {
    const gate = gateFor({
      http_request: { domains: ['api.github.com'], methods: ['GET'], deny: [] },
    });
    const v = await gate.check({
      pack: 'p',
      capability: 'http_request',
      target: 'https://api.github.com/repos/foo/bar',
      method: 'GET',
    });
    expect(v.allowed).toBe(true);
  });

  it('CRITICAL: api.github.com.attacker.com does NOT match api.github.com', async () => {
    const gate = gateFor({
      http_request: { domains: ['api.github.com'], methods: ['GET'], deny: [] },
    });
    const v = await gate.check({
      pack: 'p',
      capability: 'http_request',
      target: 'https://api.github.com.attacker.com/steal',
      method: 'GET',
    });
    expect(v.allowed).toBe(false);
    expect(v.source).toBe('denied');
  });

  it('subdomain pattern *.opensquid.tools matches api.opensquid.tools only', async () => {
    const gate = gateFor({
      http_request: { domains: ['*.opensquid.tools'], methods: ['GET'], deny: [] },
    });
    const allow = await gate.check({
      pack: 'p',
      capability: 'http_request',
      target: 'https://api.opensquid.tools/v1/x',
      method: 'GET',
    });
    expect(allow.allowed).toBe(true);
    const block = await gate.check({
      pack: 'p',
      capability: 'http_request',
      target: 'https://opensquid.tools.evil.com/steal',
      method: 'GET',
    });
    expect(block.allowed).toBe(false);
  });

  it('method not in declared methods → denied', async () => {
    const gate = gateFor({
      http_request: { domains: ['api.github.com'], methods: ['GET'], deny: [] },
    });
    const v = await gate.check({
      pack: 'p',
      capability: 'http_request',
      target: 'https://api.github.com/foo',
      method: 'DELETE',
    });
    expect(v.allowed).toBe(false);
  });

  it('invalid URL → builtin-deny (parse failure = no fail-open, C10)', async () => {
    const gate = gateFor({
      http_request: { domains: ['*'], methods: ['GET'], deny: [] },
    });
    const v = await gate.check({
      pack: 'p',
      capability: 'http_request',
      target: 'not-a-url',
      method: 'GET',
    });
    expect(v.allowed).toBe(false);
    expect(v.source).toBe('denylist');
  });
});

describe('CapabilityGate — file_write', () => {
  it('allowlist match (glob) → allowed', async () => {
    const gate = gateFor({ file_write: { paths: ['/tmp/reports/**'], deny: [] } });
    const v = await gate.check({
      pack: 'p',
      capability: 'file_write',
      target: '/tmp/reports/2026-05-20.md',
    });
    expect(v.allowed).toBe(true);
  });

  it('built-in /etc/** + ~/.ssh/** deny win over broad allowlist', async () => {
    const gate = gateFor({ file_write: { paths: ['/**'], deny: [] } });
    for (const target of ['/etc/passwd', `${HOME}/.ssh/id_rsa`]) {
      const v = await gate.check({ pack: 'p', capability: 'file_write', target });
      expect(v.allowed).toBe(false);
      expect(v.source).toBe('denylist');
    }
  });
});

describe('CapabilityGate — undeclared path', () => {
  const everyCap = [
    'shell_exec',
    'http_request',
    'file_write',
    'send_message',
    'subprocess_call',
  ] as const;

  it('block-missing (no permissions:) → deny-all for every capability', async () => {
    const gate = gateFor(undefined);
    for (const cap of everyCap) {
      const v = await gate.check({
        pack: 'p',
        capability: cap,
        target: cap === 'http_request' ? 'https://example.com' : 'anything',
        ...(cap === 'http_request' ? { method: 'GET' } : {}),
      });
      expect(v.allowed).toBe(false);
      expect(v.source).toBe('denied');
    }
  });

  it('undeclared + no prompt → deny (non-interactive)', async () => {
    const gate = gateFor({ shell_exec: { commands: ['git status'], deny: [] } });
    const v = await gate.check({ pack: 'p', capability: 'shell_exec', target: 'ls' });
    expect(v.allowed).toBe(false);
    expect(v.source).toBe('denied');
  });

  it('undeclared + prompt approves → user_approved', async () => {
    const prompt = vi.fn().mockResolvedValue(true);
    const gate = gateFor({ shell_exec: { commands: [], deny: [] } }, { prompt });
    const v = await gate.check({ pack: 'p', capability: 'shell_exec', target: 'pwd' });
    expect(v.allowed).toBe(true);
    expect(v.source).toBe('user_approved');
    expect(prompt).toHaveBeenCalledOnce();
  });

  it('undeclared + prompt denies → denied', async () => {
    const prompt = vi.fn().mockResolvedValue(false);
    const gate = gateFor({ shell_exec: { commands: [], deny: [] } }, { prompt });
    const v = await gate.check({ pack: 'p', capability: 'shell_exec', target: 'pwd' });
    expect(v.allowed).toBe(false);
    expect(v.source).toBe('denied');
  });

  it('prompt callback throws → deny + audit (C10, no fail-open)', async () => {
    const prompt = vi.fn().mockRejectedValue(new Error('UI subprocess died'));
    const auditLog = vi.fn();
    const gate = gateFor({ shell_exec: { commands: [], deny: [] } }, { prompt, auditLog });
    const v = await gate.check({ pack: 'p', capability: 'shell_exec', target: 'pwd' });
    expect(v.allowed).toBe(false);
    expect(v.source).toBe('denied');
    expect(v.message).toMatch(/UI subprocess died/);
    expect(auditLog).toHaveBeenCalledOnce();
  });
});

describe('CapabilityGate — escape hatch + audit', () => {
  it('OPENSQUID_TRUST_BUILTIN_DENY=0 → pack can override rm -rf /', async () => {
    const gate = gateFor(
      { shell_exec: { commands: ['rm -rf /'], deny: [] } },
      { trustBuiltinDeny: false },
    );
    const v = await gate.check({ pack: 'p', capability: 'shell_exec', target: 'rm -rf /' });
    expect(v.allowed).toBe(true);
    expect(v.source).toBe('declared');
  });

  it('audit log fires for both allow and deny', async () => {
    const auditLog = vi.fn();
    const gate = gateFor({ shell_exec: { commands: ['git status'], deny: [] } }, { auditLog });
    await gate.check({ pack: 'p', capability: 'shell_exec', target: 'git status' });
    await gate.check({ pack: 'p', capability: 'shell_exec', target: 'rm -rf /' });
    expect(auditLog).toHaveBeenCalledTimes(2);
    const allowV = auditLog.mock.calls[0]?.[0] as CapabilityVerdict;
    const denyV = auditLog.mock.calls[1]?.[0] as CapabilityVerdict;
    expect(allowV.allowed).toBe(true);
    expect(denyV.allowed).toBe(false);
  });

  it('audit-sink throw does NOT influence verdict (C10)', async () => {
    const auditLog = vi.fn().mockImplementation(() => {
      throw new Error('audit sink down');
    });
    const gate = gateFor({ shell_exec: { commands: ['git status'], deny: [] } }, { auditLog });
    const v = await gate.check({ pack: 'p', capability: 'shell_exec', target: 'git status' });
    expect(v.allowed).toBe(true);
  });
});

describe('CapabilityGate — send_message + subprocess_call', () => {
  it('send_message: channel allowlist match → allowed', async () => {
    const gate = gateFor({ send_message: { channels: ['alerts', 'audit_log'], deny: [] } });
    const ok = await gate.check({ pack: 'p', capability: 'send_message', target: 'alerts' });
    expect(ok.allowed).toBe(true);
    const denied = await gate.check({
      pack: 'p',
      capability: 'send_message',
      target: 'public_chat',
    });
    expect(denied.allowed).toBe(false);
  });

  it('subprocess_call: binary allowlist match → allowed', async () => {
    const gate = gateFor({
      subprocess_call: { binaries: ['claude', 'codex', 'gemini'], deny: [] },
    });
    const ok = await gate.check({ pack: 'p', capability: 'subprocess_call', target: 'claude' });
    expect(ok.allowed).toBe(true);
    const denied = await gate.check({ pack: 'p', capability: 'subprocess_call', target: 'curl' });
    expect(denied.allowed).toBe(false);
  });

  it('subagent_call: skill-name allowlist match → allowed (AUTO.4)', async () => {
    const gate = gateFor({
      subagent_call: { targets: ['auto-format-skill', 'lint-fix-*'], deny: [] },
    });
    const exact = await gate.check({
      pack: 'p',
      capability: 'subagent_call',
      target: 'auto-format-skill',
    });
    expect(exact.allowed).toBe(true);
    expect(exact.source).toBe('declared');

    const glob = await gate.check({
      pack: 'p',
      capability: 'subagent_call',
      target: 'lint-fix-typescript',
    });
    expect(glob.allowed).toBe(true);

    const denied = await gate.check({
      pack: 'p',
      capability: 'subagent_call',
      target: 'unrelated-skill',
    });
    expect(denied.allowed).toBe(false);
  });

  it('subagent_call: pack-local deny wins over allowlist (AUTO.4)', async () => {
    const gate = gateFor({
      subagent_call: { targets: ['*'], deny: ['danger-skill'] },
    });
    const v = await gate.check({
      pack: 'p',
      capability: 'subagent_call',
      target: 'danger-skill',
    });
    expect(v.allowed).toBe(false);
    expect(v.source).toBe('denylist');
  });
});

describe('CapabilityGate — unknown pack', () => {
  it('unregistered pack → deny (block-missing semantics)', async () => {
    const gate = new CapabilityGate({
      packs: new Map<string, PackPermissions>(),
      trustBuiltinDeny: true,
      homeDir: HOME,
    });
    const v = await gate.check({
      pack: 'never-registered',
      capability: 'file_write',
      target: '/tmp/x',
    });
    expect(v.allowed).toBe(false);
    expect(v.source).toBe('denied');
  });
});
