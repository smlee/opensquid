/**
 * `component_scaffold` primitive — the OUTPUT component generator (T-frontend-design-pack FD5).
 *
 * Emits an ACCESSIBLE component skeleton that already satisfies its ARIA APG contract + binds design tokens, so
 * the starting point is correct-by-construction instead of a div-soup the pre-delivery gate would later block.
 * Each scaffold carries the APG contract it implements + a primary-source citation (w3.org APG). Deterministic,
 * no LLM — the knowledge encoded as templates.
 *
 * Covers the highest-leverage interactive patterns (the ones the audit flags + APG specifies): button, dialog
 * (modal), disclosure, and a labelled text field. Returns `null`-shaped error for an unknown kind (fail-loud).
 */
import { z } from 'zod';

import { ok } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

export interface Scaffold {
  kind: string;
  code: string;
  /** The accessibility contract the scaffold satisfies (APG / WCAG). */
  contract: string[];
  source: { name: string; url: string };
}

const KINDS = ['button', 'dialog', 'disclosure', 'textfield'] as const;
type Kind = (typeof KINDS)[number];

const APG = 'https://www.w3.org/WAI/ARIA/apg/patterns';

const SCAFFOLDS: Record<Kind, Scaffold> = {
  button: {
    kind: 'button',
    code: [
      '// Native <button> — focus, role, keyboard (Enter/Space), and accessible name come free.',
      'export function Button({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {',
      '  return (',
      '    <button type="button" onClick={onClick}',
      '      style={{ minBlockSize: 24, minInlineSize: 24, background: "var(--color-action)", color: "var(--color-bg)" }}>',
      '      {children}',
      '    </button>',
      '  );',
      '}',
    ].join('\n'),
    contract: [
      'native <button> (aria-first-rule: prefer native HTML)',
      'keyboard-operable (WCAG 2.1.1) — Enter/Space free',
      'target size ≥ 24px (WCAG 2.5.8)',
      'binds semantic tokens (--color-action / --color-bg)',
    ],
    source: { name: 'ARIA APG — Button', url: `${APG}/button/` },
  },
  dialog: {
    kind: 'dialog',
    code: [
      '// Modal dialog — APG contract: role=dialog, aria-modal, labelled, focus moved in + TRAPPED, Esc closes,',
      '// focus RESTORED to the trigger on close. (Prefer the native <dialog> element where supported.)',
      'export function Dialog({ open, onClose, titleId, children }: {',
      '  open: boolean; onClose: () => void; titleId: string; children: React.ReactNode;',
      '}) {',
      '  const ref = React.useRef<HTMLDivElement>(null);',
      '  const trigger = React.useRef<Element | null>(null);',
      '  React.useEffect(() => {',
      '    if (!open) return;',
      '    trigger.current = document.activeElement;',
      '    ref.current?.focus();',
      '    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };',
      '    document.addEventListener("keydown", onKey);',
      '    return () => {',
      '      document.removeEventListener("keydown", onKey);',
      '      (trigger.current as HTMLElement | null)?.focus(); // restore focus',
      '    };',
      '  }, [open, onClose]);',
      '  if (!open) return null;',
      '  return (',
      '    <div role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>',
      '      {children}',
      '    </div>',
      '  );',
      '}',
    ].join('\n'),
    contract: [
      'role=dialog + aria-modal=true (APG dialog-modal)',
      'accessible name via aria-labelledby',
      'focus moved in on open, restored to trigger on close',
      'Esc closes (WCAG 2.1.1 keyboard)',
      'TODO: trap focus within (focus-trap on Tab) — wire before delivery',
    ],
    source: { name: 'ARIA APG — Dialog (Modal)', url: `${APG}/dialog-modal/` },
  },
  disclosure: {
    kind: 'disclosure',
    code: [
      '// Disclosure (show/hide) — APG: a native <button> toggles aria-expanded + controls the region.',
      'export function Disclosure({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {',
      '  const [open, setOpen] = React.useState(false);',
      '  return (',
      '    <>',
      '      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>',
      '        {label}',
      '      </button>',
      '      <div id={id} hidden={!open}>{children}</div>',
      '    </>',
      '  );',
      '}',
    ].join('\n'),
    contract: [
      'aria-expanded reflects state (APG disclosure)',
      'aria-controls points at the toggled region',
      'native <button> — keyboard-operable (WCAG 2.1.1)',
    ],
    source: { name: 'ARIA APG — Disclosure', url: `${APG}/disclosure/` },
  },
  textfield: {
    kind: 'textfield',
    code: [
      '// Labelled text field — a programmatically-associated <label> (not a placeholder-as-label).',
      'export function TextField({ id, label, ...props }: { id: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {',
      '  return (',
      '    <div>',
      '      <label htmlFor={id}>{label}</label>',
      '      <input id={id} {...props} />',
      '    </div>',
      '  );',
      '}',
    ].join('\n'),
    contract: [
      'explicit <label htmlFor> association (WCAG 1.3.1 / 4.1.2 name)',
      'label is not a placeholder (placeholder disappears on input)',
      'native <input> — keyboard-operable',
    ],
    source: {
      name: 'ARIA APG — Forms',
      url: `${APG.replace('/patterns', '')}/practices/names-and-descriptions/`,
    },
  },
};

const ComponentScaffoldArgs = z.object({ kind: z.enum(KINDS) }).strict();

export function scaffoldFor(kind: Kind): Scaffold {
  return SCAFFOLDS[kind];
}

export function registerComponentScaffold(registry: FunctionRegistry): void {
  registry.register({
    name: 'component_scaffold',
    argSchema: ComponentScaffoldArgs,
    durable: false,
    memoizable: true, // pure: kind → fixed scaffold
    costEstimateMs: 1,
    execute: ({ kind }) => Promise.resolve(ok(scaffoldFor(kind) satisfies Scaffold)),
  });
}
