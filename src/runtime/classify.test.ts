/** ORCH.2 — classify: the 8-intent mapping (contract PDF §6), domain-from-ctx, stakes-on-side-effect, purity. */
import { describe, expect, it } from 'vitest';

import { classify } from './classify.js';

const coding = { project: true, domain: 'coding' as const };

describe('classify (ORCH.2) — intent mapping (contract PDF §6)', () => {
  it('produce: a work-lead with no investigate signal', () => {
    expect(classify('implement a retry wrapper in this crate', coding)).toMatchObject({
      intent: 'produce',
    });
    expect(classify('add a button to the React page', coding)).toMatchObject({ intent: 'produce' });
  });

  it('inform: an investigation question', () => {
    expect(classify('why does our auth token expire early?', coding)).toMatchObject({
      intent: 'inform',
    });
    expect(classify("what's a JWT?", { project: false })).toMatchObject({ intent: 'inform' });
  });

  it('transform: re-express existing content', () => {
    expect(classify('summarize this module', coding)).toMatchObject({ intent: 'transform' });
  });

  it('act: a side-effect carries stakes:high (over-gate the irreversible)', () => {
    expect(classify('deploy to staging', coding)).toMatchObject({ intent: 'act', stakes: 'high' });
  });

  it('decide: planning/choice', () => {
    expect(classify('which approach should i take here', coding)).toMatchObject({
      intent: 'decide',
    });
  });

  it('control: directing the agent/session', () => {
    expect(classify('remember we use pnpm, not npm', coding)).toMatchObject({ intent: 'control' });
  });

  it('converse: social / acknowledgement', () => {
    expect(classify('thanks!', coding)).toMatchObject({ intent: 'converse' });
    expect(classify('ok', coding)).toMatchObject({ intent: 'converse' });
  });
});

describe('classify (ORCH.2) — facet rules', () => {
  it('domain mirrors ctx and is omitted when ctx omits it (never coined)', () => {
    expect(classify('implement X', { project: true, domain: 'coding' }).domain).toBe('coding');
    expect(classify('implement X', { project: true }).domain).toBeUndefined();
  });

  it('stakes:high ONLY on side-effects — never on plain produce', () => {
    expect(classify('implement X', coding).stakes).toBeUndefined();
    expect(classify('refactor the loader', coding).stakes).toBeUndefined();
    expect(classify('deploy it', coding).stakes).toBe('high');
  });

  it('safe default: ambiguous/empty → inform + low confidence', () => {
    expect(classify('', coding)).toMatchObject({ intent: 'inform', confidence: 'low' });
    expect(classify('the thing over there', coding)).toMatchObject({
      intent: 'inform',
      confidence: 'low',
    });
  });

  it('project flag is carried through', () => {
    expect(classify('implement X', { project: true }).project).toBe(true);
    expect(classify('implement X', { project: false }).project).toBe(false);
  });

  it('is pure — same input, same output (no Date/Math)', () => {
    const a = classify('add a feature', coding);
    const b = classify('add a feature', coding);
    expect(a).toEqual(b);
  });
});

describe('classify — the dotted domain PATH (graceful-depth sub-domain, fractal lens gating)', () => {
  it('a clear FRONTEND coding prompt → domain:coding.frontend', () => {
    expect(classify('add a CSS button to the page', coding).domain).toBe('coding.frontend');
    expect(classify('fix the responsive layout on the modal', coding).domain).toBe(
      'coding.frontend',
    );
  });
  it('a clear BACKEND coding prompt → domain:coding.backend', () => {
    expect(classify('add an API endpoint with a db query', coding).domain).toBe('coding.backend');
    expect(classify('write the auth route + schema migration', coding).domain).toBe(
      'coding.backend',
    );
  });
  it('AMBIGUOUS (both sides) → stays SHALLOW coding (vague → broad nodes only, no false depth)', () => {
    expect(classify('wire the React form to the API endpoint', coding).domain).toBe('coding');
  });
  it('NO sub-domain signal → shallow coding', () => {
    expect(classify('refactor the loader', coding).domain).toBe('coding');
  });
  it('deepens ONLY for domain==coding (no project domain → no domain facet at all)', () => {
    expect(classify('add a CSS button', { project: true }).domain).toBeUndefined();
  });
});
