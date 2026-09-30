/**
 * The three binding helpers the condition model writes expressions with —
 * `isCleanPath`, `bindingFromInput`, `renderBindingValue` — ported from the
 * web's utils/bindingHelpers.js and pinned to it by route.lockstep.test.ts
 * (and by bindings/bindingHelpers.lockstep.test.ts, through the re-export).
 *
 * The one copy: the rest of bindingHelpers (autocomplete, caret edits, path
 * walking, previews) is the variable picker's, in bindings/, which re-exports
 * these from here. They live beside the condition model because the model
 * sits below the bindings layer and must not import it.
 */

import type { Binding } from '../types';

export const TEMPLATE_RE = /\{\{[^}]+\}\}/;
// `*` is in the class so a `[*]` wildcard path is a clean ref path, as the
// server's ref resolver reads it.
const SIMPLE_PATH_RE = /^[a-zA-Z_$][\w$.[\]*]*$/;
const VALID_REF_ROOTS = ['trigger', 'steps', 'vars', 'secrets', 'loop'];

/** `steps.s1.output.foo` or `loop.item.subject`: a dotted/bracketed path, no operators. */
export function isCleanPath(text: unknown): boolean {
    if (typeof text !== 'string') return false;
    return SIMPLE_PATH_RE.test(text.trim());
}

/** Does the text contain a `{{ path }}` interpolation? */
export function detectTemplate(text: unknown): boolean {
    return typeof text === 'string' && TEMPLATE_RE.test(text);
}

/**
 * The binding a typed value means in a mode: 'expression' → a ref (a clean
 * path under a known root) or an expression; 'fixed' → a template when it
 * interpolates, else a literal.
 */
export function bindingFromInput(value: unknown, mode: 'fixed' | 'expression'): Binding {
    if (mode === 'expression') {
        const v = String(value ?? '').trim();
        if (!v) return { kind: 'literal', value: '' };
        if (isCleanPath(v) && VALID_REF_ROOTS.includes(v.split('.')[0] as string)) return { kind: 'ref', path: v };
        return { kind: 'expr', value: v };
    }
    if (detectTemplate(value)) return { kind: 'template', value: String(value) };
    return { kind: 'literal', value: value ?? '' };
}

const TEMPLATE_TOKEN_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * A `template` binding as an EXPRESSION fragment: one whole interpolation
 * collapses to its bare path; mixed text becomes `concat(…)`; anything whose
 * interpolation is not a clean path stays a quoted string.
 */
function templateToExprFragment(text: string): string {
    const parts: string[] = [];
    let last = 0;
    let sawPath = false;
    for (const m of text.matchAll(TEMPLATE_TOKEN_RE)) {
        const inner = (m[1] as string).trim();
        if (!isCleanPath(inner)) return JSON.stringify(text);
        const at = m.index as number;
        if (at > last) parts.push(JSON.stringify(text.slice(last, at)));
        parts.push(inner);
        sawPath = true;
        last = at + m[0].length;
    }
    if (!sawPath) return JSON.stringify(text);
    if (last < text.length) parts.push(JSON.stringify(text.slice(last)));
    return parts.length === 1 ? (parts[0] as string) : `concat(${parts.join(', ')})`;
}

/**
 * A binding as the right-hand side of an expression: literals as JSON, refs
 * as the bare path, expressions verbatim. Only `undefined` means "nothing
 * yet" — an explicit null stays `null`.
 */
export function renderBindingValue(b: unknown): string {
    if (!b || typeof b !== 'object') return JSON.stringify(b ?? '');
    const binding = b as { kind?: unknown; value?: unknown; path?: unknown };
    if (binding.kind === 'literal') return JSON.stringify(binding.value === undefined ? '' : binding.value);
    if (binding.kind === 'ref') return String(binding.path || '');
    if (binding.kind === 'expr') return String(binding.value || '');
    if (binding.kind === 'template') return templateToExprFragment(String(binding.value || ''));
    return JSON.stringify(b);
}
