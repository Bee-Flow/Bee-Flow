/**
 * Helpers for the mapping/binding UX, ported from agent-hub
 * `utils/bindingHelpers.js`. The runtime accepts four binding kinds — literal,
 * ref, template, expr — but the editor hides the kind behind a simpler
 * "fixed vs expression" toggle and detects the right kind from what was typed.
 *
 * The web versions of insertAtCursor / replaceRange / getAutocompleteToken
 * mutate a DOM input; here they take a TextInput's value and selection and
 * return the new text plus the caret, which is the same arithmetic without the
 * element. The condition-builder half lives in conditionText.ts and the path
 * walkers in walkPath.ts. Pinned by bindingHelpers.lockstep.test.ts.
 */

import type { BindingValue } from './types';
import { canonicalRefPath, leafOf, pathTokensOf } from './walkPath';

export {
    canonicalRefPath, detectTemplate, isCleanPath, pathLeafKey, previewValue, refPathTokens, walkPath, walkRelativePath,
} from './walkPath';

export type BindingMode = 'fixed' | 'expression';

// A cheap "might hold {{…}}" probe, kept for older callers; detectTemplate is
// the real (quote-aware) answer.
export const TEMPLATE_RE = /\{\{[^}]+\}\}/;
// One copy of the typed-value → binding rule, beside the condition model
// that writes with it (it sits below this layer).
export { bindingFromInput } from '../model/route/bindingText';

const BINDING_KINDS = new Set(['literal', 'ref', 'template', 'expr']);

/**
 * A value the text editor can only show as JSON — a bare map of bindings, an
 * array, an object/array literal. The runtime resolves these as a STRUCTURE,
 * so edited text must never be stored as one string in their place.
 */
export function isStructuredBinding(b: unknown): boolean {
    if (b == null || typeof b !== 'object') return false;
    if (Array.isArray(b)) return true;
    const kind = (b as { kind?: unknown }).kind;
    if (typeof kind === 'string' && BINDING_KINDS.has(kind)) {
        const v = (b as { value?: unknown }).value;
        return kind === 'literal' && v !== null && typeof v === 'object';
    }
    return true;
}

/** Edited JSON text back into the shape of the structured value it came from; null while not JSON. */
export function structuredFromText(text: unknown, original: unknown): unknown {
    let parsed: unknown;
    try {
        parsed = JSON.parse(String(text ?? ''));
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object') return null;
    if (original && typeof original === 'object' && !Array.isArray(original) && (original as { kind?: unknown }).kind === 'literal') {
        return { kind: 'literal', value: parsed };
    }
    return parsed;
}

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

/**
 * A field NAME from a picked path, read from its KEYS: `trigger.output.subject`
 * → `subject`, `fields["Story Points"]` → `Story_Points`,
 * `headers[name="Subject"].value` → `Subject`.
 */
export function suggestKeyFromPath(path: unknown): string {
    const tokens = pathTokensOf(String(path || ''));
    let seg = '';
    if (tokens) {
        seg = leafOf(tokens);
        if (seg === 'output' && tokens.length > 1) seg = leafOf(tokens.slice(0, -1));
    } else {
        const segs = String(path || '').trim().replace(/\[(?:\*|\d+)\]/g, '').split('.').filter(Boolean);
        seg = segs.pop() || '';
        if (seg === 'output' && segs.length) seg = segs.pop() as string;
    }
    const key = String(seg).replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    return key || 'field';
}

/** `{{path}}` in fixed mode, the bare path in expression mode — always the canonical spelling. */
export function formatPathForInsert(path: unknown, mode: string): string {
    const cleaned = String(path || '').trim();
    if (!cleaned) return '';
    const canonical = canonicalRefPath(cleaned);
    if (mode === 'fixed') return `{{${canonical}}}`;
    return canonical;
}
