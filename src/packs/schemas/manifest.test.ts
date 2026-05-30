/**
 * Tests for `manifest.yaml` schema.
 *
 * Coverage: minimum-viable parse (the 4-field example from design doc
 * §"Minimum-viable pack example"), default fill-in, regex constraints
 * (name + version), `.strict()` typo rejection, scope enum exhaustiveness.
 */

import { describe, expect, it } from 'vitest';

import { Manifest } from './manifest.js';

describe('Manifest schema', () => {
  it('parses the minimum-viable 4-field manifest with defaults filled in', () => {
    const result = Manifest.parse({
      name: 'my-first-pack',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'ship verified work',
    });
    expect(result.name).toBe('my-first-pack');
    expect(result.description).toBe('');
    expect(result.requires).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.evolves).toBe(true);
    expect(result.extends).toBeUndefined();
  });

  it('rejects an uppercase name with informative regex error', () => {
    const result = Manifest.safeParse({
      name: 'My Pack',
      version: '1.0.0',
      scope: 'workflow',
      goal: 'x',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue?.path).toEqual(['name']);
      expect(issue?.message).toMatch(/lowercase/);
    }
  });

  it('rejects a non-semver version', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '1',
      scope: 'workflow',
      goal: 'x',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['version']);
      expect(result.error.issues[0]?.message).toMatch(/semver/);
    }
  });

  it('rejects a digit-leading name (e.g. "1pack")', () => {
    const result = Manifest.safeParse({
      name: '1pack',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
    });
    // Regex allows [a-z0-9][a-z0-9-]* — digit-leading IS allowed by current
    // regex. Spec risk callout says "document this in setup UI errors" but
    // doesn't tighten the regex. Test pins current behavior so a future
    // tightening trips this test.
    expect(result.success).toBe(true);
  });

  it('strict mode rejects unknown fields (typo guard)', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      versoin: '0.2.0', // typo
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('accepts all five scope values', () => {
    for (const scope of ['universal', 'domain', 'specialty', 'workflow', 'project'] as const) {
      const result = Manifest.safeParse({
        name: 'p',
        version: '0.1.0',
        scope,
        goal: 'x',
      });
      expect(result.success).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // AUTO.2 — `rate_limits:` block.
  //
  // The block is fully optional (block-missing = unlimited for every trigger,
  // back-compat). Inside the block, every trigger key is also individually
  // optional. Required validation centres on: `per` is the sealed
  // minute|hour|day enum; `max` and `concurrent` are positive integers; typos
  // in trigger keys fail `.strict()`; the locked enum rejects `"5 minutes"`.
  // ---------------------------------------------------------------------------

  it('accepts a manifest with no rate_limits block (back-compat)', () => {
    const result = Manifest.parse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
    });
    expect(result.rate_limits).toBeUndefined();
  });

  it('parses a full rate_limits block matching the spec example', () => {
    const result = Manifest.parse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      rate_limits: {
        schedule: { max: 1, per: 'minute', concurrent: 1 },
        webhook: { max: 60, per: 'minute', concurrent: 5 },
        inbound_channel: { max: 30, per: 'minute' },
        file_changed: { max: 100, per: 'minute' },
      },
    });
    expect(result.rate_limits?.schedule).toEqual({ max: 1, per: 'minute', concurrent: 1 });
    expect(result.rate_limits?.inbound_channel?.concurrent).toBeUndefined();
  });

  it('rejects rate_limits.schedule.per = "5 minutes" (sealed enum)', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      rate_limits: { schedule: { max: 1, per: '5 minutes' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('per'));
      expect(issue).toBeDefined();
    }
  });

  it('rejects rate_limits with negative max', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      rate_limits: { schedule: { max: -1, per: 'minute' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects rate_limits with zero concurrent', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      rate_limits: { schedule: { max: 10, per: 'minute', concurrent: 0 } },
    });
    expect(result.success).toBe(false);
  });

  it('strict mode rejects an unknown trigger key inside rate_limits', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      rate_limits: { webhok: { max: 1, per: 'minute' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('strict mode rejects an unknown key inside a per-trigger config', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      rate_limits: { schedule: { max: 1, per: 'minute', burst: 5 } },
    });
    expect(result.success).toBe(false);
  });

  it('accepts hour and day periods (full enum coverage)', () => {
    for (const per of ['minute', 'hour', 'day'] as const) {
      const result = Manifest.safeParse({
        name: 'p',
        version: '0.1.0',
        scope: 'workflow',
        goal: 'x',
        rate_limits: { schedule: { max: 1, per } },
      });
      expect(result.success).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // AUTO.3 — `permissions:` block.
  //
  // Block-missing = deny-all (NOT back-compat; packs that exercise
  // capabilities must declare them). Each per-capability sub-block is
  // independently optional. Tests focus on schema-layer concerns (parse,
  // strict, defaults); the gate-layer semantics are covered in
  // capability_gate.test.ts.
  // ---------------------------------------------------------------------------

  it('accepts a manifest with no permissions block', () => {
    const result = Manifest.parse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
    });
    expect(result.permissions).toBeUndefined();
  });

  it('parses the full permissions block from the spec example', () => {
    const result = Manifest.parse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      permissions: {
        shell_exec: {
          commands: ['git status', 'git log *', 'pnpm test', 'pnpm run *'],
          deny: ['rm -rf /*'],
        },
        http_request: {
          domains: ['api.github.com', '*.opensquid.tools'],
          methods: ['GET', 'POST'],
        },
        file_write: {
          paths: ['./.opensquid/**', './reports/**'],
        },
        send_message: {
          channels: ['audit_log', 'alerts'],
        },
        subprocess_call: {
          binaries: ['claude', 'pack', 'gemini'],
        },
      },
    });
    expect(result.permissions?.shell_exec?.commands).toContain('git status');
    expect(result.permissions?.http_request?.methods).toEqual(['GET', 'POST']);
    expect(result.permissions?.file_write?.paths).toContain('./reports/**');
  });

  it('defaults http_request.methods to ["GET"] when omitted', () => {
    const result = Manifest.parse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      permissions: {
        http_request: { domains: ['api.github.com'] },
      },
    });
    expect(result.permissions?.http_request?.methods).toEqual(['GET']);
  });

  it('defaults per-capability deny: to []', () => {
    const result = Manifest.parse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      permissions: {
        shell_exec: { commands: ['git status'] },
      },
    });
    expect(result.permissions?.shell_exec?.deny).toEqual([]);
  });

  it('strict mode rejects unknown capability key', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      permissions: {
        shell_exce: { commands: [] }, // typo
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('strict mode rejects unknown key inside a capability block', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      permissions: {
        http_request: { domains: ['x'], hosts: ['y'] },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid HTTP method in http_request.methods', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      permissions: {
        http_request: { domains: ['x'], methods: ['CONNECT'] },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty-string command in shell_exec.commands', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      permissions: {
        shell_exec: { commands: [''] },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts subagent_call permission block with targets allowlist (AUTO.4)', () => {
    const result = Manifest.parse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      permissions: {
        subagent_call: { targets: ['auto-format-skill', 'lint-fix-*'] },
      },
    });
    expect(result.permissions?.subagent_call?.targets).toEqual(['auto-format-skill', 'lint-fix-*']);
    expect(result.permissions?.subagent_call?.deny).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // IDF.1 (2026-05-30) — Foundation + ActivationScope + DetectedByCheck
  // ---------------------------------------------------------------------

  it('IDF.1: minimal manifest gets activation_scope default "project" + detected_by default []', () => {
    const result = Manifest.parse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
    });
    expect(result.foundation).toBeUndefined();
    expect(result.activation_scope).toBe('project');
    expect(result.detected_by).toEqual([]);
  });

  it('IDF.1: parses foundation block with tools/domains/methodologies', () => {
    const result = Manifest.parse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      foundation: {
        tools: [{ name: 'react', semver: '>=19' }],
        domains: ['frontend'],
        methodologies: ['atomic-design'],
      },
    });
    expect(result.foundation?.tools).toEqual([{ name: 'react', semver: '>=19' }]);
    expect(result.foundation?.domains).toEqual(['frontend']);
    expect(result.foundation?.methodologies).toEqual(['atomic-design']);
  });

  it('IDF.1: parses each activation_scope enum value', () => {
    for (const scope of ['project', 'user', 'hybrid', 'team', 'global'] as const) {
      const result = Manifest.parse({
        name: 'p',
        version: '0.1.0',
        scope: 'workflow',
        goal: 'x',
        activation_scope: scope,
      });
      expect(result.activation_scope).toBe(scope);
    }
  });

  it('IDF.1: rejects invalid activation_scope', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      activation_scope: 'bogus',
    });
    expect(result.success).toBe(false);
  });

  it('IDF.1: parses detected_by file_exists variant', () => {
    const result = Manifest.parse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      detected_by: [{ kind: 'file_exists', path: 'package.json' }],
    });
    expect(result.detected_by[0]).toEqual({ kind: 'file_exists', path: 'package.json' });
  });

  it('IDF.1: parses detected_by file_match variant with JSON-path matches', () => {
    const result = Manifest.parse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      detected_by: [
        {
          kind: 'file_match',
          path: 'package.json',
          matches: { 'dependencies.react': '>=19' },
        },
      ],
    });
    const check = result.detected_by[0];
    expect(check?.kind).toBe('file_match');
    if (check?.kind === 'file_match') {
      expect(check.matches['dependencies.react']).toBe('>=19');
    }
  });

  it('IDF.1: parses detected_by file_glob with min_count default 1', () => {
    const result = Manifest.parse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      detected_by: [{ kind: 'file_glob', pattern: '**/*.tsx' }],
    });
    const check = result.detected_by[0];
    if (check?.kind === 'file_glob') {
      expect(check.min_count).toBe(1);
    }
  });

  it('IDF.1: parses detected_by all 7 kinds', () => {
    const result = Manifest.parse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      detected_by: [
        { kind: 'file_exists', path: 'a' },
        { kind: 'dir_exists', path: 'b' },
        { kind: 'file_match', path: 'c', matches: { k: 'v' } },
        { kind: 'file_glob', pattern: '*.ts', min_count: 3 },
        { kind: 'memory_match', pattern: 'react' },
        { kind: 'conversation_signal', pattern: '\\bX\\b' },
        { kind: 'user_pinned' },
      ],
    });
    expect(result.detected_by.length).toBe(7);
    expect(result.detected_by.map((c) => c.kind)).toEqual([
      'file_exists',
      'dir_exists',
      'file_match',
      'file_glob',
      'memory_match',
      'conversation_signal',
      'user_pinned',
    ]);
  });

  it('IDF.1: rejects detected_by with unknown kind', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      detected_by: [{ kind: 'wrong_kind' }],
    });
    expect(result.success).toBe(false);
  });

  it('IDF.1: rejects file_exists missing path', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      detected_by: [{ kind: 'file_exists' }],
    });
    expect(result.success).toBe(false);
  });

  it('IDF.1: existing built-in packs round-trip with defaults applied', () => {
    // Verified via separate test/builtin tests that load the actual packs;
    // here we just confirm the schema accepts the minimum + applies defaults
    // (the regression guard for back-compat).
    const minimal = Manifest.parse({
      name: 'default-discipline',
      version: '0.1.0',
      scope: 'universal',
      goal: 'ship verified work',
    });
    expect(minimal.activation_scope).toBe('project');
    expect(minimal.detected_by).toEqual([]);
    expect(minimal.foundation).toBeUndefined();
  });
});

/* ────────────────────────────────────────────────────────────────────
 * MM.1 — Pack kind / usage / composite includes additive fields.
 *
 * Schema-side defaults + superRefine cross-field invariants. Resolver
 * tests live in composite_resolver.test.ts; discovery integration tests
 * live in discovery.test.ts.
 * ──────────────────────────────────────────────────────────────────── */
describe('MM.1: kind + usage + includes schema', () => {
  const minimal = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'p',
    version: '0.1.0',
    scope: 'workflow',
    goal: 'fixture',
    ...overrides,
  });

  it('minimal manifest defaults to kind: focused, usage: active, includes: []', () => {
    const m = Manifest.parse(minimal());
    expect(m.kind).toBe('focused');
    expect(m.usage).toBe('active');
    expect(m.includes).toEqual([]);
  });

  it('parses kind: composite with non-empty includes', () => {
    const m = Manifest.parse(
      minimal({
        kind: 'composite',
        includes: [{ pack_id: 'a', semver: '^1.0.0' }],
      }),
    );
    expect(m.kind).toBe('composite');
    expect(m.includes).toHaveLength(1);
    expect(m.includes[0]).toEqual({ pack_id: 'a', semver: '^1.0.0' });
  });

  it('rejects kind: composite with empty includes', () => {
    const result = Manifest.safeParse(minimal({ kind: 'composite', includes: [] }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('composite REQUIRES non-empty includes');
    }
  });

  it('rejects kind: focused with non-empty includes', () => {
    const result = Manifest.safeParse(
      minimal({ kind: 'focused', includes: [{ pack_id: 'a', semver: '^1.0.0' }] }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('focused MUST have empty includes');
    }
  });

  it('rejects kind: composite + foundation declared (composites are pure aggregators)', () => {
    const result = Manifest.safeParse(
      minimal({
        kind: 'composite',
        includes: [{ pack_id: 'a', semver: '^1.0.0' }],
        foundation: { tools: [], domains: [], methodologies: [] },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('composite MUST NOT declare foundation');
    }
  });

  it('parses each usage enum value (active, profession, both)', () => {
    for (const usage of ['active', 'profession', 'both'] as const) {
      const m = Manifest.parse(minimal({ usage }));
      expect(m.usage).toBe(usage);
    }
  });

  it('rejects invalid usage enum value', () => {
    const r = Manifest.safeParse(minimal({ usage: 'invalid' }));
    expect(r.success).toBe(false);
  });

  it('rejects invalid kind enum value', () => {
    const r = Manifest.safeParse(minimal({ kind: 'meta' }));
    expect(r.success).toBe(false);
  });

  it('rejects malformed include entry (typo: packid instead of pack_id)', () => {
    const r = Manifest.safeParse(
      minimal({ kind: 'composite', includes: [{ packid: 'a', semver: '^1.0.0' }] }),
    );
    expect(r.success).toBe(false);
  });

  it('rejects include entry missing semver field', () => {
    const r = Manifest.safeParse(minimal({ kind: 'composite', includes: [{ pack_id: 'a' }] }));
    expect(r.success).toBe(false);
  });

  it('composite + detected_by IS allowed (gates WHEN to expand)', () => {
    const m = Manifest.parse(
      minimal({
        kind: 'composite',
        includes: [{ pack_id: 'a', semver: '^1.0.0' }],
        detected_by: [{ kind: 'file_exists', path: 'package.json' }],
      }),
    );
    expect(m.kind).toBe('composite');
    expect(m.detected_by).toHaveLength(1);
  });
});

/* ────────────────────────────────────────────────────────────────────
 * LP.1 — BaseVersion + PersonalRevision schemas + Manifest extensions.
 * ──────────────────────────────────────────────────────────────────── */
describe('LP.1: BaseVersion + PersonalRevision schemas', () => {
  it('BaseVersion accepts valid semver shapes', () => {
    expect(() => Manifest.parse({ ...minimal(), base_version: '1.2.3' })).not.toThrow();
    expect(() => Manifest.parse({ ...minimal(), base_version: '1.2.3-rc.1' })).not.toThrow();
    expect(() => Manifest.parse({ ...minimal(), base_version: '10.20.30' })).not.toThrow();
  });

  it('BaseVersion rejects malformed semver', () => {
    expect(Manifest.safeParse({ ...minimal(), base_version: 'v1.2.3' }).success).toBe(false);
    expect(Manifest.safeParse({ ...minimal(), base_version: '1.2' }).success).toBe(false);
    expect(Manifest.safeParse({ ...minimal(), base_version: '' }).success).toBe(false);
  });

  it('Manifest accepts optional personal_revision block with defaults', () => {
    const m = Manifest.parse({
      ...minimal(),
      personal_revision: { base_version: '1.0.0' },
    });
    expect(m.personal_revision?.base_version).toBe('1.0.0');
    expect(m.personal_revision?.personal_revision_id).toBe(0);
    expect(m.personal_revision?.last_merged_vanilla).toBeNull();
  });

  it('PersonalRevision rejects extra keys (.strict)', () => {
    const r = Manifest.safeParse({
      ...minimal(),
      personal_revision: { base_version: '1.0.0', revision_id: 5 },
    });
    expect(r.success).toBe(false);
  });

  function minimal(): Record<string, unknown> {
    return {
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'fixture',
    };
  }
});

describe('DOG.3: seed_lessons + verify_gates schema', () => {
  function minimal(): Record<string, unknown> {
    return { name: 'p', version: '0.1.0', scope: 'workflow', goal: 'fixture' };
  }

  it('defaults seed_lessons + verify_gates to empty arrays (back-compat)', () => {
    const r = Manifest.safeParse(minimal());
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.seed_lessons).toEqual([]);
    expect(r.data.verify_gates).toEqual([]);
  });

  it('accepts a well-formed seed_lessons entry with all fields', () => {
    const r = Manifest.safeParse({
      ...minimal(),
      seed_lessons: [
        {
          title: 'a useful idiom',
          body: 'body of the lesson',
          scope: 'user',
          tags: ['react-19'],
          source: 'https://example.com/x',
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects a seed_lessons entry with empty title (.min(1))', () => {
    const r = Manifest.safeParse({
      ...minimal(),
      seed_lessons: [{ title: '', body: 'b' }],
    });
    expect(r.success).toBe(false);
  });

  it('accepts a well-formed verify_gates entry with all fields', () => {
    const r = Manifest.safeParse({
      ...minimal(),
      verify_gates: [
        {
          name: 'no-rm-rf',
          when: { event_kind: 'tool_call' },
          check: 'contains(tool_args.command, "rm -rf")',
          on_fail: { level: 'block', message: 'no rm -rf' },
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects verify_gate name with uppercase or leading hyphen', () => {
    for (const badName of ['BadName', '-leading-hyphen', '']) {
      const r = Manifest.safeParse({
        ...minimal(),
        verify_gates: [
          {
            name: badName,
            when: { event_kind: 'tool_call' },
            check: 'len("x")',
            on_fail: { level: 'warn', message: 'bad' },
          },
        ],
      });
      expect(r.success, `should reject name=${JSON.stringify(badName)}`).toBe(false);
    }
  });

  it('rejects verify_gate.on_fail.level outside {warn, block}', () => {
    const r = Manifest.safeParse({
      ...minimal(),
      verify_gates: [
        {
          name: 'g',
          when: { event_kind: 'tool_call' },
          check: 'len("x")',
          on_fail: { level: 'panic', message: 'x' },
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('rejects verify_gate.when.event_kind outside the 4-value allow-list', () => {
    const r = Manifest.safeParse({
      ...minimal(),
      verify_gates: [
        {
          name: 'g',
          when: { event_kind: 'inbound_channel' },
          check: 'len("x")',
          on_fail: { level: 'warn', message: 'x' },
        },
      ],
    });
    expect(r.success).toBe(false);
  });
});
