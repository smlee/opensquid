/**
 * MM.5 — End-to-end integration test for Phase 2 (T-MULTIMODE).
 *
 * Exercises the full multi-mode stack:
 *   - MM.1: composite resolution at load time (expandComposites)
 *   - MM.2: profession-directive validator (resolveProfessionDirective)
 *   - MM.3: scope-architect as usage:both profession pack
 *   - MM.4: pack-architect as usage:both profession pack
 *
 * Fixture: test/fixtures/composite-test/manifest.yaml — composite pack that
 * includes both scope-architect + pack-architect. Lives in test/fixtures/
 * so it's NOT shipped in the npm package.
 */
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { expandComposites } from '../../src/packs/composite_resolver.js';
import { loadPack } from '../../src/packs/loader.js';
import { resolveProfessionDirective } from '../../src/runtime/hooks/profession_resolver.js';
import type { Team } from '../../src/packs/schemas/team.js';

describe('MM.5 — Phase 2 multi-mode end-to-end', () => {
  it('expands composite pack including scope-architect + pack-architect', async () => {
    const composite = await loadPack(resolve('test/fixtures/composite-test'));
    const scopeArch = await loadPack(resolve('packs/builtin/scope-architect'));
    const packArch = await loadPack(resolve('packs/builtin/pack-architect'));
    const expanded = expandComposites([composite, scopeArch, packArch]);
    const names = expanded.map((p) => p.name).sort();
    expect(names).toEqual(['composite-test', 'pack-architect', 'scope-architect']);
  });

  it('composite identity preserved in expanded list (composite stays for audit)', async () => {
    const composite = await loadPack(resolve('test/fixtures/composite-test'));
    const scopeArch = await loadPack(resolve('packs/builtin/scope-architect'));
    const packArch = await loadPack(resolve('packs/builtin/pack-architect'));
    const expanded = expandComposites([composite, scopeArch, packArch]);
    const compositeInList = expanded.find((p) => p.name === 'composite-test');
    expect(compositeInList).toBeDefined();
    expect(compositeInList?.kind).toBe('composite');
    expect(compositeInList?.includes).toHaveLength(2);
  });

  it('profession resolver routes next_action.profession: scope-architect successfully', async () => {
    const scopeArch = await loadPack(resolve('packs/builtin/scope-architect'));
    expect(scopeArch.team).toBeDefined();
    const teamsByPack = new Map<string, Team>([['scope-architect', scopeArch.team!]]);
    const result = resolveProfessionDirective(
      { profession: 'scope-architect', rationale: 'test prework needed' },
      [scopeArch],
      teamsByPack,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.role.name).toBe('scope-architect');
      expect(result.role.model_alias).toBe('reasoning');
      expect(result.role.handoff_signal).toBe('SCOPE_COMPLETE');
    }
  });

  it('profession resolver routes next_action.profession: pack-architect successfully', async () => {
    const packArch = await loadPack(resolve('packs/builtin/pack-architect'));
    expect(packArch.team).toBeDefined();
    const teamsByPack = new Map<string, Team>([['pack-architect', packArch.team!]]);
    const result = resolveProfessionDirective(
      { profession: 'pack-architect', rationale: 'test pack-authoring needed' },
      [packArch],
      teamsByPack,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.role.handoff_signal).toBe('PACK_AUTHORING_COMPLETE');
    }
  });

  it('profession resolver DROPS directive when profession pack is not loaded', () => {
    const result = resolveProfessionDirective(
      { profession: 'nonexistent-pack', rationale: 'test' },
      [],
      new Map(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.code).toBe('unknown-pack');
    }
  });

  it('end-to-end chain: composite loads → expanded packs include profession-mode packs → directives resolve', async () => {
    const composite = await loadPack(resolve('test/fixtures/composite-test'));
    const scopeArch = await loadPack(resolve('packs/builtin/scope-architect'));
    const packArch = await loadPack(resolve('packs/builtin/pack-architect'));
    const expanded = expandComposites([composite, scopeArch, packArch]);
    // Stage teamsByPack from the expanded list (matches dispatcher behavior)
    const teamsByPack = new Map<string, Team>();
    for (const p of expanded) {
      if (p.team !== undefined) teamsByPack.set(p.name, p.team);
    }
    // Profession resolver against expanded registry — both scope-architect
    // AND pack-architect must resolve cleanly.
    const r1 = resolveProfessionDirective(
      { profession: 'scope-architect', rationale: 'r' },
      expanded,
      teamsByPack,
    );
    const r2 = resolveProfessionDirective(
      { profession: 'pack-architect', rationale: 'r' },
      expanded,
      teamsByPack,
    );
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });
});
