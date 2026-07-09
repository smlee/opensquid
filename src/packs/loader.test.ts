/**
 * Tests for the pack folder loader (`loader.ts`).
 *
 * Coverage matches Task 2.3 spec §"Test fixtures" + acceptance criteria:
 *   1. minimal/ fixture → Pack loads, skills: [].
 *   2. full/ fixture → 2 skills loaded, sorted alphabetically (docs, git).
 *   3. nonexistent dir → throws a path-bearing error.
 *   4. bad manifest (missing required field) → error names file + Zod path.
 *   5. skills/ with a non-dir entry (stray file) → skipped, pack still loads.
 *   6. (Bonus) symlink inside skills/ pointing at another skill dir → followed.
 *
 * Fixtures 1 + 2 live under `test/fixtures/packs/{minimal,full}/` as canonical
 * examples. Fixtures 3-6 build per-test temp dirs in `os.tmpdir()` so the
 * canonical fixtures stay clean and tests stay independent.
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadPack } from './loader.js';

// Resolve fixtures relative to this source file so the test works regardless
// of where vitest is invoked from.
const FIXTURES_DIR = resolve(fileURLToPath(import.meta.url), '../../../test/fixtures/packs');

describe('loadPack — fixture-based smoke tests', () => {
  it('loads the minimal fixture with the four required manifest fields and no skills', async () => {
    const pack = await loadPack(join(FIXTURES_DIR, 'minimal'));

    expect(pack.name).toBe('minimal');
    expect(pack.version).toBe('0.1.0');
    expect(pack.scope).toBe('workflow');
    expect(pack.goal).toBe('smoke test');
    // Defaults from the Manifest schema fill these in.
    expect(pack.description).toBe('');
    expect(pack.requires).toEqual([]);
    expect(pack.conflicts).toEqual([]);
    expect(pack.evolves).toBe(true);
    expect(pack.skills).toEqual([]);
  });

  it('loads the full fixture with all manifest fields populated and skills sorted alphabetically', async () => {
    const pack = await loadPack(join(FIXTURES_DIR, 'full'));

    expect(pack.name).toBe('full');
    expect(pack.version).toBe('0.2.0');
    expect(pack.scope).toBe('project');
    expect(pack.description).toBe(
      'full pack fixture exercising all manifest fields and skill ordering',
    );
    expect(pack.requires).toEqual(['some-other-pack']);
    expect(pack.conflicts).toEqual(['clashing-pack']);
    expect(pack.evolves).toBe(false);

    // Sort order: docs < git lexicographically. Verifies the explicit
    // `entries.sort()` in `loadSkillsDir` (APFS isn't guaranteed alphabetical).
    expect(pack.skills.map((s) => s.name)).toEqual(['docs', 'git']);

    // Skill bodies parsed through the Skill schema — spot-check shape.
    const gitSkill = pack.skills.find((s) => s.name === 'git');
    expect(gitSkill?.load).toBe('preload');
    expect(gitSkill?.rules).toHaveLength(1);
    expect(gitSkill?.rules[0]?.id).toBe('block-force-push');
  });
});

describe('loadPack — error + edge cases', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opensquid-loader-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('throws a path-bearing error when the pack directory does not exist', async () => {
    const missing = join(dir, 'does-not-exist');
    await expect(loadPack(missing)).rejects.toThrow(/manifest\.yaml/);
  });

  it('surfaces both the manifest file path and the Zod field path when a required manifest field is missing', async () => {
    // No `scope:` — schema requires it.
    const manifest = ['name: bad', 'version: 0.1.0', 'goal: missing scope'].join('\n') + '\n';
    const manifestPath = join(dir, 'manifest.yaml');
    await writeFile(manifestPath, manifest, 'utf8');

    let caught: unknown;
    try {
      await loadPack(dir);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    // File path comes from parseYamlFile.
    expect(msg).toContain(manifestPath);
    // Zod renders the missing field name into its message — the field path is
    // what makes this error actionable. The Zod error message includes the
    // field name in its issue list.
    expect(msg.toLowerCase()).toContain('scope');
  });

  it('skips a non-directory entry inside skills/ and still loads the rest of the pack', async () => {
    // Minimal manifest.
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: with-stray', 'version: 0.1.0', 'scope: workflow', 'goal: test stray skips'].join(
        '\n',
      ) + '\n',
      'utf8',
    );

    await mkdir(join(dir, 'skills', 'real-skill'), { recursive: true });
    await writeFile(
      join(dir, 'skills', 'real-skill', 'skill.yaml'),
      ['name: real-skill', 'load: lazy'].join('\n') + '\n',
      'utf8',
    );

    // Stray file directly in skills/ — must be skipped, not parsed as a skill.
    await writeFile(join(dir, 'skills', 'README.md'), '# stray file\n', 'utf8');
    // Also a dotfile that macOS likes to drop — also must be skipped.
    await writeFile(join(dir, 'skills', '.DS_Store'), 'binary garbage', 'utf8');

    const pack = await loadPack(dir);
    expect(pack.skills.map((s) => s.name)).toEqual(['real-skill']);
  });

  it('loads chat_agent.yaml when present, folding it into Pack.chatAgent', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: with-chat-agent', 'version: 0.1.0', 'scope: workflow', 'goal: WAB.6 binding'].join(
        '\n',
      ) + '\n',
      'utf8',
    );
    await writeFile(
      join(dir, 'chat_agent.yaml'),
      [
        'default_model: fast_chat',
        'system_prompt: prompts/chat.md',
        'max_tokens: 2048',
        'disable_builtins:',
        '  - recall',
      ].join('\n') + '\n',
      'utf8',
    );

    const pack = await loadPack(dir);
    expect(pack.chatAgent).toBeDefined();
    expect(pack.chatAgent?.default_model).toBe('fast_chat');
    expect(pack.chatAgent?.system_prompt).toBe('prompts/chat.md');
    expect(pack.chatAgent?.max_tokens).toBe(2048);
    expect(pack.chatAgent?.disable_builtins).toEqual(['recall']);
    // Defaults still applied for unspecified fields.
    expect(pack.chatAgent?.max_tool_iterations).toBe(8);
    expect(pack.chatAgent?.skills).toEqual([]);
  });

  it('leaves Pack.chatAgent undefined when chat_agent.yaml is absent', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: no-chat-agent', 'version: 0.1.0', 'scope: workflow', 'goal: no side-file'].join(
        '\n',
      ) + '\n',
      'utf8',
    );
    const pack = await loadPack(dir);
    expect(pack.chatAgent).toBeUndefined();
  });

  // wg-7f6225238a27 — procedure.md: the pack's agent-facing operating procedure.
  it('loads procedure.md when present, folding it into Pack.procedure', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      [
        'name: with-procedure',
        'version: 0.1.0',
        'scope: workflow',
        'goal: procedure side-file',
      ].join('\n') + '\n',
      'utf8',
    );
    const proc = '# how to do the work\n\n1. do X\n2. do Y\n';
    await writeFile(join(dir, 'procedure.md'), proc, 'utf8');
    const pack = await loadPack(dir);
    expect(pack.procedure).toBe(proc);
  });

  it('leaves Pack.procedure undefined when procedure.md is absent', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: no-procedure', 'version: 0.1.0', 'scope: workflow', 'goal: no side-file'].join('\n') +
        '\n',
      'utf8',
    );
    const pack = await loadPack(dir);
    expect(pack.procedure).toBeUndefined();
  });

  it('leaves Pack.procedure undefined when procedure.md is over the size cap', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: big-procedure', 'version: 0.1.0', 'scope: workflow', 'goal: oversize side-file'].join(
        '\n',
      ) + '\n',
      'utf8',
    );
    // > MAX_PROCEDURE (64_000) → treated as absent (never a partial read).
    await writeFile(join(dir, 'procedure.md'), 'x'.repeat(64_001), 'utf8');
    const pack = await loadPack(dir);
    expect(pack.procedure).toBeUndefined();
  });

  it('surfaces a chat_agent.yaml schema error verbatim (typo top-level key)', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: bad-chat-agent', 'version: 0.1.0', 'scope: workflow', 'goal: bad side-file'].join(
        '\n',
      ) + '\n',
      'utf8',
    );
    // `defualt_model` typo — strict-mode rejection.
    await writeFile(
      join(dir, 'chat_agent.yaml'),
      ['defualt_model: fast_chat'].join('\n') + '\n',
      'utf8',
    );

    let caught: unknown;
    try {
      await loadPack(dir);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain('chat_agent.yaml');
  });

  // PR-followup: models.yaml + drift_response.yaml are now folded into the
  // Pack by `loadPack`. Tests verify presence + absence + schema-error paths
  // for both side files. Schema-error path covers the most common author bug
  // (typo at top level under `.strict()` for drift_response; missing required
  // `mode:` for models).

  it('loads models.yaml when present, folding it into Pack.models', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: with-models', 'version: 0.1.0', 'scope: workflow', 'goal: PR-followup'].join('\n') +
        '\n',
      'utf8',
    );
    await writeFile(
      join(dir, 'models.yaml'),
      [
        'fast_classifier:',
        '  description: test classifier',
        '  mode: subscription',
        '  impl: cli',
        '  cli: example-cli',
        "  args: ['--print']",
      ].join('\n') + '\n',
      'utf8',
    );

    const pack = await loadPack(dir);
    expect(pack.models).toBeDefined();
    expect(pack.models?.fast_classifier?.mode).toBe('subscription');
    expect(pack.models?.fast_classifier?.cli).toBe('example-cli');
    // Schema default applies — args was authored, but description default
    // stays as the authored value rather than the empty-string fallback.
    expect(pack.models?.fast_classifier?.description).toBe('test classifier');
  });

  it('leaves Pack.models undefined when models.yaml is absent', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: no-models', 'version: 0.1.0', 'scope: workflow', 'goal: no side-file'].join('\n') +
        '\n',
      'utf8',
    );
    const pack = await loadPack(dir);
    expect(pack.models).toBeUndefined();
  });

  it('surfaces a models.yaml schema error verbatim (missing required mode)', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: bad-models', 'version: 0.1.0', 'scope: workflow', 'goal: bad models'].join('\n') +
        '\n',
      'utf8',
    );
    // `mode:` is the one schema-required field; omitting it must throw.
    await writeFile(
      join(dir, 'models.yaml'),
      ['fast_classifier:', "  cli: 'example-cli'"].join('\n') + '\n',
      'utf8',
    );

    let caught: unknown;
    try {
      await loadPack(dir);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain('models.yaml');
    expect(msg.toLowerCase()).toContain('mode');
  });

  it('loads drift_response.yaml when present, folding it into Pack.driftResponse', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: with-drift', 'version: 0.1.0', 'scope: workflow', 'goal: PR-followup'].join('\n') +
        '\n',
      'utf8',
    );
    await writeFile(
      join(dir, 'drift_response.yaml'),
      [
        'default: notify_and_pause',
        'per_rule:',
        '  example-rule: block_tool',
        '  other-rule: warn',
      ].join('\n') + '\n',
      'utf8',
    );

    const pack = await loadPack(dir);
    expect(pack.driftResponse).toBeDefined();
    expect(pack.driftResponse?.default).toBe('notify_and_pause');
    expect(pack.driftResponse?.per_rule['example-rule']).toBe('block_tool');
    expect(pack.driftResponse?.per_rule['other-rule']).toBe('warn');
    // Default-empty `corrective_skills` applied.
    expect(pack.driftResponse?.corrective_skills).toEqual({});
  });

  it('leaves Pack.driftResponse undefined when drift_response.yaml is absent', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: no-drift', 'version: 0.1.0', 'scope: workflow', 'goal: no side-file'].join('\n') +
        '\n',
      'utf8',
    );
    const pack = await loadPack(dir);
    expect(pack.driftResponse).toBeUndefined();
  });

  it('warns and LOADS on an unknown drift_response.yaml top-level key (was: fail-loud, wg-a02313251dfb)', async () => {
    const warned: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((c: string | Uint8Array): boolean => (warned.push(String(c)), true));
    try {
      await writeFile(
        join(dir, 'manifest.yaml'),
        ['name: bad-drift', 'version: 0.1.0', 'scope: workflow', 'goal: bad drift'].join('\n') +
          '\n',
        'utf8',
      );
      // `defualt:` typo — a genuinely-unknown top-level key now warns + strips, not crash.
      await writeFile(join(dir, 'drift_response.yaml'), 'defualt: warn\n', 'utf8');

      const pack = await loadPack(dir); // NO throw now
      expect(pack).toBeDefined();
      expect(warned.join('')).toContain('drift_response.yaml'); // source named
      expect(warned.join('')).toContain("'defualt'"); // key NAMED in the warning
    } finally {
      spy.mockRestore();
    }
  });

  it('warns and LOADS on an unknown manifest.yaml top-level key (fail-loud softens, wg-a02313251dfb)', async () => {
    const warned: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((c: string | Uint8Array): boolean => (warned.push(String(c)), true));
    try {
      await writeFile(
        join(dir, 'manifest.yaml'),
        [
          'name: fwd-manifest',
          'version: 0.1.0',
          'scope: workflow',
          'goal: forward key',
          'future_flag: true', // genuinely-unknown top-level key
        ].join('\n') + '\n',
        'utf8',
      );
      const pack = await loadPack(dir); // NO throw
      expect(pack).toBeDefined();
      expect(warned.join('')).toContain('manifest.yaml');
      expect(warned.join('')).toContain("'future_flag'");
    } finally {
      spy.mockRestore();
    }
  });

  it('STILL fails loud on a manifest.yaml missing a required field (source label preserved)', async () => {
    // No `name` — a genuine (missing-required) error still stops the loop.
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['version: 0.1.0', 'scope: workflow', 'goal: no name'].join('\n') + '\n',
      'utf8',
    );
    let caught: unknown;
    try {
      await loadPack(dir);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('manifest.yaml');
  });

  it('surfaces a drift_response.yaml schema error verbatim (unknown policy enum value)', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: bad-policy', 'version: 0.1.0', 'scope: workflow', 'goal: bad policy'].join('\n') +
        '\n',
      'utf8',
    );
    await writeFile(join(dir, 'drift_response.yaml'), 'default: panic\n', 'utf8');

    let caught: unknown;
    try {
      await loadPack(dir);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('drift_response.yaml');
  });

  it('follows symlinks inside skills/ to their target directory (documented behavior)', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: with-symlink', 'version: 0.1.0', 'scope: workflow', 'goal: symlink test'].join('\n') +
        '\n',
      'utf8',
    );

    // Real skill directory outside `skills/`.
    const externalSkillDir = join(dir, 'external-skill');
    await mkdir(externalSkillDir, { recursive: true });
    await writeFile(
      join(externalSkillDir, 'skill.yaml'),
      ['name: linked-skill', 'load: lazy'].join('\n') + '\n',
      'utf8',
    );

    // skills/ contains only a symlink pointing at the external dir.
    await mkdir(join(dir, 'skills'), { recursive: true });
    await symlink(externalSkillDir, join(dir, 'skills', 'linked-skill'), 'dir');

    const pack = await loadPack(dir);
    expect(pack.skills.map((s) => s.name)).toEqual(['linked-skill']);
  });
});

// ---------------------------------------------------------------------------
// Task H.2 — load-time `if:` validation via Zod refinement.
//
// Confirms that invalid `if:` expressions fail at `loadPack()` time with a
// path-bearing + field-bearing error message (was previously a silent
// `false` + `console.warn` at first event fire), while every shipped
// production `if:` clause + the empty / absent cases still load cleanly.
//
// Test design:
//   - Each test builds a one-skill pack under a per-test tmpdir.
//   - Skills declare a single rule with one ProcessStep so the Zod issue
//     path is predictable: `rules[0].process[0].if`.
//   - Triggers default to `[{kind: 'tool_call'}]` (per Skill schema default)
//     so we never have to spell them out in the fixture.
// ---------------------------------------------------------------------------

describe('loadPack — Task H.2 load-time if: validation', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opensquid-loader-h2-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Helper: build a one-skill pack with the given `if:` clause inside a
  // single rule. The skill name is fixed; the `if:` value is the only
  // pack-author variable. Returns the path to the skill.yaml so tests can
  // assert against it in error messages.
  async function writeSkillWithIf(ifClause: string | null): Promise<{ skillYaml: string }> {
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: h2-fixture', 'version: 0.1.0', 'scope: workflow', 'goal: H.2 test'].join('\n') + '\n',
      'utf8',
    );

    const skillDir = join(dir, 'skills', 'h2-skill');
    await mkdir(skillDir, { recursive: true });

    // `if:` is OMITTED when ifClause is null; otherwise quoted-string form
    // so YAML parses arbitrary characters (including bare `(`).
    const stepLines = ['      - call: verdict', `        args: { level: "warn", message: "h2" }`];
    if (ifClause !== null) {
      stepLines.push(`        if: ${JSON.stringify(ifClause)}`);
    }

    const skillYaml = join(skillDir, 'skill.yaml');
    await writeFile(
      skillYaml,
      [
        'name: h2-skill',
        'load: lazy',
        'rules:',
        '  - id: h2-rule',
        '    process:',
        ...stepLines,
      ].join('\n') + '\n',
      'utf8',
    );

    return { skillYaml };
  }

  it('rejects an unparseable if: clause with a path-bearing + field-bearing error', async () => {
    const { skillYaml } = await writeSkillWithIf('this is not valid');

    let caught: unknown;
    try {
      await loadPack(dir);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    // Source path threaded through by parseYamlFile.
    expect(msg).toContain(skillYaml);
    // Field path threaded through by Zod (process[0].if). Plus our
    // refinement message. We assert these as separate substrings rather
    // than a single regex because Zod's JSON-line formatting moves them
    // onto separate lines.
    expect(msg).toMatch(/Schema validation failed/);
    expect(msg).toMatch(/process/);
    expect(msg).toMatch(/if/);
    expect(msg).toContain('invalid if: expression');
  });

  it('rejects unbalanced paren in if: at load time', async () => {
    await writeSkillWithIf('(');
    await expect(loadPack(dir)).rejects.toThrow(/invalid if: expression/);
  });

  it('rejects garbage syntax in if: at load time', async () => {
    await writeSkillWithIf('== =');
    await expect(loadPack(dir)).rejects.toThrow(/invalid if: expression/);
  });

  it('accepts an empty if: string (matches §12.2 runtime "empty = true" semantics)', async () => {
    await writeSkillWithIf('');
    const pack = await loadPack(dir);
    expect(pack.skills).toHaveLength(1);
    expect(pack.skills[0]?.name).toBe('h2-skill');
  });

  it('accepts an absent if: field (existing behavior)', async () => {
    await writeSkillWithIf(null);
    const pack = await loadPack(dir);
    expect(pack.skills).toHaveLength(1);
    expect(pack.skills[0]?.rules[0]?.id).toBe('h2-rule');
  });

  // The 8 unique production clauses currently shipping in
  // `packs/builtin/**` (per pre-research §1.3 enumeration). All must load
  // cleanly so the H.2 ship is non-breaking for every existing pack.
  it.each([
    ['BARE — claimed', 'claimed'],
    ['BARE — committing', 'committing'],
    ['BARE — hit', 'hit'],
    ['BARE — cmd_hit', 'cmd_hit'],
    ['EQ_PATTERN — candidates == "NONE"', 'candidates == "NONE"'],
    ['BOOL_CMP — automation.value == true', 'automation.value == true'],
    [
      'BOOL_CMP + EQ_PATTERN — automation.value == true && classification == "BLOCK"',
      'automation.value == true && classification == "BLOCK"',
    ],
    [
      '§12.4 latent-rule — committing && phases != "complete"',
      'committing && phases != "complete"',
    ],
  ])('accepts the production clause: %s', async (_label, clause) => {
    await writeSkillWithIf(clause);
    const pack = await loadPack(dir);
    expect(pack.skills).toHaveLength(1);
  });
});
