/**
 * The binding helpers the condition model writes expressions with —
 * `isCleanPath`, `detectTemplate`, `bindingFromInput`, `renderBindingValue` —
 * ported from the web's utils/bindingHelpers.js and pinned to it by
 * route.lockstep.test.ts (and by bindings/bindingHelpers.lockstep.test.ts,
 * through the re-export).
 *
 * The one copy: the rest of bindingHelpers (autocomplete, caret edits, path
 * walking, previews) is the variable picker's, in bindings/, which re-exports
 * these from here. They live beside the condition model because the model
 * sits below the bindings layer and must not import it. Paths are read with
 * the runtime's own grammar (model/pathGrammar.ts) and `{{ … }}` with its
 * quote-aware scan, so `{{a["x}}y"]}}` is one placeholder and a picked path
 * is stored in the spelling every other editor writes.
 */

import { scanTemplate } from '@/shared/expr';

import { canonicalRefPath, detectTemplate, isCleanPath, refPathTokens } from '../pathGrammar';
import type { Binding } from '../types';

export { detectTemplate, isCleanPath };

const VALID_REF_ROOTS = ['trigger', 'steps', 'vars', 'secrets', 'loop'];

/**
 * The binding a typed value means in a mode: 'expression' → a ref (a clean
 * path under a known root, stored in its canonical spelling) or an
 * expression; 'fixed' → a template when it interpolates, else a literal.
 */
export function bindingFromInput(value: unknown, mode: 'fixed' | 'expression'): Binding {
    if (mode === 'expression') {
        const v = String(value ?? '').trim();
        if (!v) return { kind: 'literal', value: '' };
        const tokens = isCleanPath(v) ? refPathTokens(v) : null;
        if (tokens && VALID_REF_ROOTS.includes(String((tokens[0] as { key?: unknown }).key))) {
            return { kind: 'ref', path: canonicalRefPath(v) };
        }
        return { kind: 'expr', value: v };
    }
    if (detectTemplate(value)) return { kind: 'template', value: String(value) };
    return { kind: 'literal', value: value ?? '' };
}

/**
 * A `template` binding as an EXPRESSION fragment: one whole interpolation
 * collapses to its path, mixed text becomes `concat(…)`, anything whose
 * interpolation is not a path stays a quoted string. Placeholders are written
 * in the canonical spelling, which the engine reads as the same path
 * (`a["content-type"]`, not a subtraction).
 */
function templateToExprFragment(text: string): string {
    const parts: string[] = [];
    let sawPath = false;
    for (const p of scanTemplate(text)) {
        if (p.type === 'text') {
            parts.push(JSON.stringify(p.value));
            continue;
        }
        if (!refPathTokens(p.inner)) return JSON.stringify(text);
        parts.push(canonicalRefPath(p.inner));
        sawPath = true;
    }
    if (!sawPath) return JSON.stringify(text);
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
