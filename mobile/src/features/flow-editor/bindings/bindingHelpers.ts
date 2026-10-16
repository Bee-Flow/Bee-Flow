/**
 * Helpers for the mapping/binding UX, from agent-hub `utils/bindingHelpers.ts`
 * (the generated mirror under bindings/mirror/utils/, npm run gen:shared). The runtime accepts four binding kinds — literal,
 * ref, template, expr — but the editor hides the kind behind a simpler
 * "fixed vs expression" toggle and detects the right kind from what was typed.
 *
 * The web versions of insertAtCursor / replaceRange / getAutocompleteToken
 * mutate a DOM input; here they take a TextInput's value and selection and
 * return the new text plus the caret, which is the same arithmetic without the
 * element. The condition-builder half lives in conditionText.ts and the path
 * walkers in walkPath.ts. Pinned by bindingHelpers.lockstep.test.ts.
 */

import {
    AUTOCOMPLETE_ROOTS,
    getAutocompleteTokenFromPrefix as webGetAutocompleteTokenFromPrefix,
    inputFromBinding as webInputFromBinding,
    isStructuredBinding as webIsStructuredBinding,
    structuredFromText as webStructuredFromText,
} from './mirror/utils/bindingHelpers';
import type { BindingValue } from './types';

export {
    canonicalRefPath, detectTemplate, isCleanPath, pathLeafKey, previewValue, refPathTokens, walkPath, walkRelativePath,
} from './walkPath';
export {
    AUTOCOMPLETE_ROOTS, formatPathForInsert, suggestKeyFromPath, TEMPLATE_RE,
} from './mirror/utils/bindingHelpers';

export type BindingMode = 'fixed' | 'expression';

// One copy of the typed-value -> binding rule, beside the condition model
// that writes with it (it sits below this layer).
export { bindingFromInput } from '../model/route/bindingText';

/** A value the text editor can only show as JSON (a bare map of bindings, an array, an object literal). */
export const isStructuredBinding = webIsStructuredBinding as (b: unknown) => boolean;

/** Edited JSON text back into the shape of the structured value it came from; null while not JSON. */
export const structuredFromText = webStructuredFromText as (text: unknown, original: unknown) => unknown;

/** Inverse of bindingFromInput: the `{ mode, text }` a stored binding edits as. */
export const inputFromBinding = webInputFromBinding as (binding: BindingValue) => { mode: BindingMode; text: string };

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

export interface PrefixToken {
    length: number;
    query: string;
}

/**
 * The in-progress variable token that ends at the caret, from just the text
 * BEFORE the caret. `length` is how many typed characters an accepted
 * suggestion swallows.
 */
export const getAutocompleteTokenFromPrefix = webGetAutocompleteTokenFromPrefix as (
    before: unknown,
    mode: string,
    roots?: unknown,
) => PrefixToken | null;

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
