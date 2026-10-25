// GENERATED from agent-hub/src/utils/bindingHelpers.ts by scripts/gen-shared-mirror.mjs — do not edit
/**
 * Helpers for the mapping/binding UX. The runtime accepts four binding
 * kinds — literal, ref, template, expr — but the user-facing UI hides
 * the kind behind a simpler "fixed vs expression" toggle and detects
 * the right kind automatically when the user types `{{...}}` or a
 * clean path. Every function here is pure and side-effect free except
 * `insertAtCursor` which mutates a DOM input/textarea.
 *
 * Paths are read and written with the ONE grammar the run resolves
 * (shared/expr/path.mjs): `["Story Points"]`, `[0]`, `[*]`, `[-1]`,
 * `[name="Subject"]`, unicode and `content-type` all mean here exactly what
 * they mean to server/automation/bind.js. This module used to carry its own
 * identifier-only regex and a laxer walker, so a quoted key was stored as a
 * formula, flipped to Text as its own path text, and previewed values the run
 * never got. Reading accepts every spelling the runtime accepts; writing
 * (`formatPathForInsert`, `canonicalRefPath`) always produces the canonical
 * spelling, which the expression engine reads too.
 */
import { walkTokens } from '@/shared/expr';
import type { BindingInput, BindingLike, PathToken, TextControl } from '@/features/flow-editor/bindings/webTypes';
import { tailTokens, anyPathTokens, canonicalRefPath, isCleanPath, leafOf, isIndexOrWild, parentOf, findOperator } from './bindingHelpers.helpers';
export { refPathTokens, canonicalRefPath, detectTemplate, isCleanPath, bindingFromInput, buildConditionExpr, renderBindingValue, walkRelativePath } from './bindingHelpers.helpers';

// A cheap "might hold {{…}}" probe, kept for older callers. It cannot see a
// placeholder whose quoted key holds a brace; `detectTemplate` can.
export const TEMPLATE_RE = /\{\{[^}]+\}\}/;
// A sub-step of an expanded flowlet: `steps.<callId>/<subId>.output…` (the
// prefix is stripped on save — flow/inlineFlowlets.js). The `/` is allowed
// ONLY inside that step id, so `steps.a.output.total/2` stays a formula.
export const INLINE_STEP_PATH_RE = /^steps\.[A-Za-z_$][\w$]*(?:\/[A-Za-z_$][\w$]*)+(?:\.[\w$]+|\[[^\]]*\])*$/;

const BINDING_KINDS = new Set<string | undefined>(['literal', 'ref', 'template', 'expr']);

/**
 * A value the text editor can only show as JSON: a bare map of bindings (the
 * shape canonicalizeBinding emits for an object parameter), an array, or an
 * object/array literal. The runtime resolves each of these as a STRUCTURE
 * (bind.js resolveDeep), so turning the edited text into a string would hand
 * the tool binding descriptors instead of values.
 */
export function isStructuredBinding(b: BindingLike | unknown[] | string | number | boolean | null | undefined): boolean {
    if (b == null || typeof b !== 'object') return false;
    if (Array.isArray(b)) return true;
    if (BINDING_KINDS.has(b.kind)) return b.kind === 'literal' && b.value !== null && typeof b.value === 'object';
    return true;
}

/**
 * Edited JSON text back into the SHAPE of the structured value it was opened
 * from (a literal stays a literal around the parsed value, a bare map stays a
 * bare map, nested {kind} wrappers intact). Null while the text is not a JSON
 * object or array — the caller keeps the old value rather than saving a string.
 */
export function structuredFromText(text: unknown, original?: BindingLike | unknown[] | null) {
    let parsed;
    try { parsed = JSON.parse(String(text ?? '')); } catch { return null; }
    if (parsed === null || typeof parsed !== 'object') return null;
    if (original && typeof original === 'object' && !Array.isArray(original) && original.kind === 'literal') {
        return { kind: 'literal', value: parsed };
    }
    return parsed;
}

/**
 * Inverse of bindingFromInput — given a stored binding, return the
 * `{ mode, text }` the input should display so the user can edit it
 * round-trip without losing meaning.
 *
 * Bare/unknown values are treated as fixed-mode literals (matches the
 * runtime resolver's tolerance — see canonicalizeBinding in
 * server/automation/builderTools.js).
 */
export function inputFromBinding(binding: BindingInput) {
    if (binding == null) return { mode: 'fixed', text: '' };
    if (typeof binding !== 'object') {
        return { mode: 'fixed', text: String(binding) };
    }
    if (binding.kind === 'literal') {
        const v = binding.value;
        if (v == null) return { mode: 'fixed', text: '' };
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            return { mode: 'fixed', text: String(v) };
        }
        // Object/array literal — show JSON in fixed mode (rare).
        try { return { mode: 'fixed', text: JSON.stringify(v) }; }
        catch (_) { return { mode: 'fixed', text: '' }; }
    }
    if (binding.kind === 'template') return { mode: 'fixed', text: String(binding.value || '') };
    if (binding.kind === 'ref')      return { mode: 'expression', text: String(binding.path || '') };
    if (binding.kind === 'expr')     return { mode: 'expression', text: String(binding.value || '') };
    // Unknown shape — treat as JSON literal so user can at least see it.
    try { return { mode: 'fixed', text: JSON.stringify(binding) }; }
    catch (_) { return { mode: 'fixed', text: '' }; }
}

/**
 * Insert text at the input/textarea's caret position, keeping focus and
 * positioning the caret right after the inserted snippet. Falls back to
 * appending if the element doesn't expose a selection API.
 *
 * Returns the resulting full value so the caller can lift it into React
 * state in the same tick (uncontrolled DOM mutation alone won't trigger
 * React's onChange).
 */
export function insertAtCursor(el: TextControl | null | undefined, snippet: string): string | null {
    if (!el) return null;
    const isTextLike = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
    if (!isTextLike) return null;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const next = before + snippet + after;
    el.value = next;
    const caret = start + snippet.length;
    try { el.setSelectionRange(caret, caret); } catch (_) { /* ignore */ }
    el.focus();
    return next;
}

/**
 * Detect an in-progress variable token at the caret, to trigger the inline
 * autocomplete picker while typing.
 *   - mode 'fixed' (templates): an UNCLOSED `{{` before the caret with a
 *     path-ish partial → the token spans from the `{{` to the caret.
 *   - mode 'expression'/path: a partial rooted path (`steps.` / `trigger.` /
 *     `loop.` / `item.` / `vars.`) ending at the caret.
 * `roots` overrides which roots count — App Studio's scope shares none of the
 * automation roots but `item`/`vars` (see AUTOCOMPLETE_ROOTS).
 * Returns `{ start, end, query }` (range in el.value) or null.
 */
export function getAutocompleteToken(el: TextControl | null | undefined, mode: string, roots: unknown = AUTOCOMPLETE_ROOTS) {
    if (!el || typeof el.value !== 'string') return null;
    const caret = el.selectionStart ?? el.value.length;
    const hit = getAutocompleteTokenFromPrefix(el.value.slice(0, caret), mode, roots);
    return hit ? { start: caret - hit.length, end: caret, query: hit.query } : null;
}

/**
 * The same rule, expressed over just the text BEFORE the caret — which is all a
 * contenteditable can offer (RefTokenInput has no selectionStart, and the pills
 * before the caret are not text at all). Returns `{ length, query }`, where
 * `length` is how many typed characters the accepted suggestion should swallow.
 */
export function getAutocompleteTokenFromPrefix(before: unknown, mode: string, roots: unknown = AUTOCOMPLETE_ROOTS) {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a constant character class with one * on a slice after the last {{: linear
    const text = typeof before === 'string' ? before : '';
    if (mode === 'fixed') {
        const open = text.lastIndexOf('{{');
        if (open === -1) return null;
        const partial = text.slice(open + 2);
        if (partial.includes('}') || partial.includes('{')) return null;
        if (!/^[\w$.[\]*\s]*$/.test(partial)) return null;
        return { length: text.length - open, query: partial.trim() };
    }
    const list = safeRoots(roots);
    if (!list.length) return null;
    // Built from `list` rather than written out, so a caller with a different
    // scope (App Studio: currentUser/form/screen/actions/…) completes ITS roots
    // instead of the automation builder's.
    const rooted = new RegExp(`(?:^|[^\\w$.])((?:${list.join('|')})\\.[\\w$.[\\]*]*)$`);
    const m = rooted.exec(text);
    if (m) return { length: (m[1] as string).length, query: m[1] as string };
    // A bare partial that could still BECOME a root ("st", "trig", "steps").
    // Without this the picker only ever opened once a full root plus its dot
    // was already typed, so typing "st" suggested nothing and the feature read
    // as broken (BFSF-321). Restricted to prefixes of an actual root, and to
    // 2+ characters, so ordinary expression text doesn't pop the picker open on
    // every keystroke.
    const bare = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)$/.exec(text);
    if (!bare) return null;
    const partial = bare[1] as string;
    if (partial.length < 2) return null;
    const lower = partial.toLowerCase();
    if (!list.some((root: string) => root.toLowerCase().startsWith(lower))) return null;
    return { length: partial.length, query: partial };
}

// Roots the expression-mode picker will complete. Superset of VALID_REF_ROOTS:
// `item` is the conventional loop-body alias and is accepted by the runtime
// resolver, so users expect it to autocomplete too.
export const AUTOCOMPLETE_ROOTS = ['steps', 'trigger', 'loop', 'item', 'vars'];

/**
 * Keep only roots that are plain identifiers, so a caller-supplied list (in
 * App Studio's case, one fetched from the server catalog) can never smuggle
 * regex metacharacters into the pattern built above.
 */
function safeRoots(roots: unknown): string[] {
    const list = Array.isArray(roots) ? roots : AUTOCOMPLETE_ROOTS;
    return list.filter((r: unknown) => typeof r === 'string' && /^[A-Za-z_$][\w$]*$/.test(r));
}

/**
 * Replace [start, end) of the element's value with `snippet`, placing the
 * caret after it. Sibling of insertAtCursor for token-replacement (the
 * range was recorded when autocomplete opened — focus may have moved to
 * the picker's search box since). Returns the new full value.
 */
export function replaceRange(el: TextControl | null | undefined, start: number, end: number, snippet: string): string | null {
    if (!el) return null;
    const value = String(el.value ?? '');
    const from = Math.max(0, Math.min(start, value.length));
    const to = Math.max(from, Math.min(end, value.length));
    const next = value.slice(0, from) + snippet + value.slice(to);
    el.value = next;
    const caret = from + snippet.length;
    try { el.setSelectionRange(caret, caret); } catch (_) { /* ignore */ }
    el.focus();
    return next;
}

/**
 * Suggest a field NAME from a picked path — the last meaningful segment
 * (`trigger.output.subject` → `subject`). Used by the Set editor's
 * "Add field from a previous step" action.
 */
export function suggestKeyFromPath(path: unknown): string {
    const tokens = anyPathTokens(String(path || ''));
    let seg = '';
    if (tokens) {
        // Read the KEYS, not the spelling: `fields["Story Points"]` names
        // "Story Points", and `headers[name="Subject"].value` names "Subject".
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

/**
 * The key a path (or a path TAIL such as a pill's field part, `["a b"].c`)
 * is named after, unquoted: `fields["Story Points"]` → "Story Points",
 * `items[0]` → "items", `headers[name="Subject"].value` → "Subject". '' when
 * there is none.
 */
export function pathLeafKey(pathOrTail: unknown): string {
    const t = String(pathOrTail ?? '').trim();
    if (!t) return '';
    const tokens = t[0] === '[' ? tailTokens(t) : anyPathTokens(t);
    return tokens ? leafOf(tokens) : '';
}

/**
 * What a pill or chip is named after, read from the path's keys:
 *   leaf    the key itself (`fields["Story Points"]` → "Story Points"; after
 *           a match segment its value: `headers[name="Subject"].value` →
 *           "Subject")
 *   parent  for a generic leaf only, the nearest key above it that says
 *           whose it is — `from.emailAddress.address` → "from" (emailAddress
 *           only repeats the leaf), `ccRecipients[*].emailAddress.address` →
 *           "ccRecipients"; '' when there is none
 *   index   an index right after the leaf (`items[0]` → 0, `[-1]` → -1), or null
 * Null when the text is not a path.
 */
export function pathLabelParts(pathOrTail: unknown) {
    const t = String(pathOrTail ?? '').trim();
    if (!t) return null;
    const tokens = t[0] === '[' ? tailTokens(t) : anyPathTokens(t);
    if (!tokens) return null;
    const leaf = leafOf(tokens);
    // Where the leaf sits: the last key that is not an index or a wildcard.
    let at = tokens.length - 1;
    while (at >= 0 && isIndexOrWild(tokens[at] as PathToken)) at--;
    const after = tokens.slice(at + 1).find((x: PathToken) => x.type === 'prop' && typeof x.key === 'number');
    return { leaf, parent: parentOf(tokens, at, leaf), index: after ? (after as { key: number }).key : null };
}

/**
 * Format a path for insertion given the current field mode.
 *   - 'fixed'      — wrap as `{{path}}` so the runtime interpolates it
 *   - 'expression' — bare path (the field will detect ref vs expr)
 */
export function formatPathForInsert(path: unknown, mode: string): string {
    const cleaned = String(path || '').trim();
    if (!cleaned) return '';
    // Canonical, whatever spelling the source handed over: a drag from an
    // output table may say `headers.content-type`, which a template resolves
    // but a formula reads as a subtraction.
    const canonical = canonicalRefPath(cleaned);
    if (mode === 'fixed') return `{{${canonical}}}`;
    return canonical;
}

/**
 * Try to break a raw expression like `steps.s1.output.total > 1000`
 * into `{ leftPath, op, rightValue }` for the visual Condition builder.
 * Returns null when the expression doesn't fit the simple
 * `<path> <op> <literal-or-path>` template (the visual mode falls back
 * to "advanced raw" in that case).
 *
 * Supported operators (textual, in order of length so longer alternatives
 * don't get shadowed by shorter ones):
 *   ===, !==, ==, !=, >=, <=, >, <
 */
const COND_OPS = ['===', '!==', '==', '!=', '>=', '<=', '>', '<'];

export function parseSimpleCondition(expr: unknown) {
    if (typeof expr !== 'string') return null;
    const text = expr.trim();
    if (!text) return null;
    for (const op of COND_OPS) {
        // Find an operator with whitespace on at least one side so we
        // don't match `>=` inside a longer token.
        const idx = findOperator(text, op);
        if (idx === -1) continue;
        const left = text.slice(0, idx).trim();
        const right = text.slice(idx + op.length).trim();
        if (!left || !right) continue;
        if (!isCleanPath(left)) return null;
        return { leftPath: left, op, rightRaw: right };
    }
    return null;
}

/**
 * Walk a dotted/bracketed path on an object
 * (`steps.s1.output.results[0].subject`, `…results[*].output.field`,
 * `obj["quoted key"]`, `headers[name="Subject"].value`). Returns undefined if
 * any segment is missing — never throws.
 *
 * This IS the runtime's walker (shared/expr/path.mjs, which
 * server/automation/bind.js walkPath delegates to): same grammar, JSON text
 * read as the value it encodes, the same `[*]` rules. The builder used to
 * carry a laxer copy that previewed `fields.Story Points` or `value[0x1]` —
 * values the run never got — so every preview here (VariableTree, the example
 * lines, list counts) now shows exactly what the run will see. The one extra
 * is the flowlet sub-step id (`steps.<call>/<sub>`), which exists only while
 * a flowlet is expanded on the canvas and is stripped on save.
 */
export function walkPath(path: unknown, root: unknown) {
    if (!path || root == null) return undefined;
    const tokens = anyPathTokens(String(path));
    return tokens ? walkTokens(tokens, root) : undefined;
}

/**
 * Format a sample value for inline display in the variable tree.
 * Strings are shown raw (truncated), numbers/booleans/null serialise
 * naturally, objects/arrays show as `{…}` / `[N items]`.
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
