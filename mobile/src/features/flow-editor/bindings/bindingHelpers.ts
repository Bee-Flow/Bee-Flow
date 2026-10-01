/**
 * Helpers for the mapping/binding UX, ported from agent-hub
 * `utils/bindingHelpers.js`. The runtime accepts four binding kinds — literal,
 * ref, template, expr — but the editor hides the kind behind a simpler
 * "fixed vs expression" toggle and detects the right kind from what was typed.
 *
 * The web versions of insertAtCursor / replaceRange / getAutocompleteToken
 * mutate a DOM input; here they take a TextInput's value and selection and
 * return the new text plus the caret, which is the same arithmetic without the
 * element. The condition-builder half lives in conditionText.ts; the path
 * walkers are the shared mapping core's (`@/shared/mapping`, pinned by its
 * corpus). Pinned by bindingHelpers.lockstep.test.ts.
 */

import type { BindingValue } from './types';

/**
 * A sample value for inline display: strings raw (truncated), numbers and
 * booleans as text, objects/arrays as `{a, b…}` / `[N items]`.
 */
export function previewValue(value: unknown, maxLen = 40): string {
    if (value == null) return '—';
    if (typeof value === 'string') {
        return value.length > maxLen ? value.slice(0, maxLen - 1) + '…' : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? '' : 's'}]`;
    if (typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 0) return '{}';
        return `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '…' : ''}}`;
    }
    return String(value);
}

// The binding <-> text core (clean paths, templates, which kind a typed value
// means) is shared with the Condition node's model, which owns it; the chip
// layer (refTokens.ts) reads the same TEMPLATE_RE.
export { bindingFromInput, detectTemplate, isCleanPath, TEMPLATE_RE } from '../model/route/bindingText';

export type BindingMode = 'fixed' | 'expression';

function jsonText(v: unknown): string {
    try {
        return JSON.stringify(v);
    } catch {
        return '';
    }
}

/** Inverse of bindingFromInput: the `{ mode, text }` a stored binding edits as. */
export function inputFromBinding(binding: BindingValue): { mode: BindingMode; text: string } {
    if (binding == null) return { mode: 'fixed', text: '' };
    if (typeof binding !== 'object') return { mode: 'fixed', text: String(binding) };
    if (binding.kind === 'literal') {
        const v = binding.value;
        if (v == null) return { mode: 'fixed', text: '' };
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            return { mode: 'fixed', text: String(v) };
        }
        return { mode: 'fixed', text: jsonText(v) };
    }
    if (binding.kind === 'template') return { mode: 'fixed', text: String(binding.value || '') };
    if (binding.kind === 'ref') return { mode: 'expression', text: String(binding.path || '') };
    if (binding.kind === 'expr') return { mode: 'expression', text: String(binding.value || '') };
    return { mode: 'fixed', text: jsonText(binding) };
}

export interface TextEdit {
    value: string;
    caret: number;
}

/**
 * insertAtCursor over a TextInput: put `snippet` at the selection and report
 * where the caret lands. A missing selection end appends, as on the web.
 */
export function insertAtSelection(
    value: string,
    selection: { start?: number | null; end?: number | null } | null,
    snippet: string,
): TextEdit {
    const start = selection?.start ?? value.length;
    const end = selection?.end ?? value.length;
    const next = value.slice(0, start) + snippet + value.slice(end);
    return { value: next, caret: start + snippet.length };
}

/** Replace [start, end) of `value` with `snippet` (the autocomplete accept). */
export function replaceRange(value: unknown, start: number, end: number, snippet: string): TextEdit {
    const text = String(value ?? '');
    const from = Math.max(0, Math.min(start, text.length));
    const to = Math.max(from, Math.min(end, text.length));
    return { value: text.slice(0, from) + snippet + text.slice(to), caret: from + snippet.length };
}

// Roots the expression-mode picker completes. `item` is the loop-body alias.
export const AUTOCOMPLETE_ROOTS = ['steps', 'trigger', 'loop', 'item', 'vars'];

/** Only plain identifiers, so a caller's list cannot smuggle regex syntax in. */
function safeRoots(roots: unknown): string[] {
    const list: unknown[] = Array.isArray(roots) ? roots : AUTOCOMPLETE_ROOTS;
    return list.filter((r): r is string => typeof r === 'string' && /^[A-Za-z_$][\w$]*$/.test(r));
}

export interface PrefixToken {
    length: number;
    query: string;
}

/** An UNCLOSED `{{` before the caret with a path-ish partial after it. */
function fixedModeToken(text: string): PrefixToken | null {
    const open = text.lastIndexOf('{{');
    if (open === -1) return null;
    const partial = text.slice(open + 2);
    if (partial.includes('}') || partial.includes('{')) return null;
    if (!/^[\w$.[\]*\s]*$/.test(partial)) return null;
    return { length: text.length - open, query: partial.trim() };
}

/** A bare partial (2+ characters) that could still become a root (BFSF-321). */
function barePartial(text: string, list: string[]): PrefixToken | null {
    const bare = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)$/.exec(text);
    if (!bare) return null;
    const partial = bare[1] as string;
    if (partial.length < 2) return null;
    const lower = partial.toLowerCase();
    if (!list.some((root) => root.toLowerCase().startsWith(lower))) return null;
    return { length: partial.length, query: partial };
}

/**
 * The in-progress variable token that ends at the caret, from just the text
 * BEFORE the caret. `length` is how many typed characters an accepted
 * suggestion swallows.
 */
export function getAutocompleteTokenFromPrefix(
    before: unknown,
    mode: string,
    roots: unknown = AUTOCOMPLETE_ROOTS,
): PrefixToken | null {
    const text = typeof before === 'string' ? before : '';
    if (mode === 'fixed') return fixedModeToken(text);
    const list = safeRoots(roots);
    if (!list.length) return null;
    const rooted = new RegExp(`(?:^|[^\\w$.])((?:${list.join('|')})\\.[\\w$.[\\]*]*)$`);
    const m = rooted.exec(text);
    if (m) return { length: (m[1] as string).length, query: m[1] as string };
    return barePartial(text, list);
}

/** getAutocompleteToken over a value and caret: `{ start, end, query }` or null. */
export function getAutocompleteToken(
    value: unknown,
    caret: number | null | undefined,
    mode: string,
    roots: unknown = AUTOCOMPLETE_ROOTS,
): { start: number; end: number; query: string } | null {
    if (typeof value !== 'string') return null;
    const at = caret ?? value.length;
    const hit = getAutocompleteTokenFromPrefix(value.slice(0, at), mode, roots);
    return hit ? { start: at - hit.length, end: at, query: hit.query } : null;
}

/** A field NAME from a picked path: `trigger.output.subject` → `subject`. */
export function suggestKeyFromPath(path: unknown): string {
    const cleaned = String(path || '').trim().replace(/\[(?:\*|\d+)\]/g, '');
    const segs = cleaned.split('.').filter(Boolean);
    let seg = segs.pop() || '';
    if (seg === 'output' && segs.length) seg = segs.pop() as string;
    const key = seg.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    return key || 'field';
}

/** `{{path}}` in fixed mode, the bare path in expression mode. */
export function formatPathForInsert(path: unknown, mode: string): string {
    const cleaned = String(path || '').trim();
    if (!cleaned) return '';
    if (mode === 'fixed') return `{{${cleaned}}}`;
    return cleaned;
}
