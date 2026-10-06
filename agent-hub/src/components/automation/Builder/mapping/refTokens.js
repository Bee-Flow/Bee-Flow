/**
 * Tokenize a bound-field value into literal text and step/trigger/loop
 * REFERENCE tokens, so the inspector can render references as chips that
 * show the human step NAME instead of the raw id (`steps.ai_87e358…`).
 *
 * This is DISPLAY-ONLY. The stored value is never changed — the runtime
 * resolver (server/automation/bind.js) needs the id-based path. Chips are
 * rendered over a read-only view of the field; editing happens on the raw
 * text. `serializeRefTokens(parseRefTokens(x)) === x` for any input.
 *
 * Three ref sources are recognised, matching the runtime paths:
 *   steps.<id>.output[<field path>]   → keyed by step id (resolvable to a label)
 *   trigger[.output][<field path>]    → the automation trigger
 *   loop.<itemVar>[<field path>]      → the current forEach/loop item
 *
 * WHAT counts as one reference is the runtime's own path grammar
 * (shared/expr/path.mjs, through bindingHelpers): a bracket straight after
 * `output` (`steps.g.output["@odata.nextLink"]`, `steps.l.output[0].id`), a
 * quoted key holding `}` or `]`, a match segment
 * (`headers[name="Subject"].value`). The pill used to stop at the first
 * segment its own regex did not know, which left half a reference as loose
 * text and made re-picking through the pill keep the stale half.
 */
import { formatPath, readPath, scanTemplate } from '@shared/expr/path.mjs';
import { detectTemplate, isCleanPath, refPathTokens } from '../../../../utils/bindingHelpers';
import { humanizeFieldTail } from '../flow/displayHelpers';

// The roots a pill can name.
const REF_ROOTS = ['steps', 'trigger', 'loop'];

/** A path's field part, after its head, in canonical spelling ('' for none). */
function tailOf(tokens) {
    return tokens.length ? formatPath(tokens) : '';
}

/**
 * Classify a bare path string (no `{{}}`) as a ref.
 * Returns `{ source, stepId?, itemVar?, fieldPath }` or null.
 */
export function classifyRef(path) {
    if (typeof path !== 'string') return null;
    const tokens = refPathTokens(path);
    if (!tokens) return null;
    const [head, second, third] = tokens;
    const named = (t) => t?.type === 'prop' && typeof t.key === 'string';
    if (head.key === 'steps') {
        if (named(second) && named(third) && third.key === 'output') {
            return { source: 'steps', stepId: second.key, fieldPath: tailOf(tokens.slice(3)) };
        }
        return null;
    }
    if (head.key === 'loop') {
        return named(second) ? { source: 'loop', itemVar: second.key, fieldPath: tailOf(tokens.slice(2)) } : null;
    }
    if (head.key === 'trigger') {
        const rest = named(second) && second.key === 'output' ? tokens.slice(2) : tokens.slice(1);
        return { source: 'trigger', fieldPath: tailOf(rest) };
    }
    return null;
}

/**
 * The name a pill shows after its source — displayHelpers.humanizeFieldTail,
 * so every surface that names a field reads it the way its pill does:
 * `fields["Story Points"]` "Story points", `from.emailAddress.address`
 * "From ▸ Address", `items[0]` "Items ▸ 1st".
 */
export function fieldTailLabel(fieldPath) {
    return humanizeFieldTail(fieldPath);
}

/**
 * Parse a field value into an ordered token list.
 *
 * Token shapes:
 *   { type: 'literal', text }
 *   { type: 'ref', raw, path, source, stepId?, itemVar?, fieldPath, wrapped }
 *
 * `raw` is the exact original substring (including `{{ }}` and any internal
 * spacing when `wrapped`), so serialize round-trips verbatim. `path` is the
 * inner path without braces.
 *
 * Mode semantics mirror bindingHelpers:
 *   - a value containing `{{…}}` is a template — only the `{{…}}` insides are
 *     refs; everything else (even ref-looking text) is literal.
 *   - 'fixed' mode without `{{…}}` is a plain literal — no refs.
 *   - 'expression' mode without `{{…}}` is scanned for bare refs.
 */
export function parseRefTokens(text, { mode = 'expression' } = {}) {
    const s = text == null ? '' : String(text);
    if (!s) return [];
    if (detectTemplate(s)) return tokenizeTemplate(s);
    if (mode === 'fixed') return [{ type: 'literal', text: s }];
    return tokenizeExpression(s);
}

function tokenizeTemplate(s) {
    // The runtime's quote-aware placeholder scan: `{{ x["a}}b"] }}` is ONE
    // placeholder, exactly as bind.js interpolateTemplate reads it.
    return scanTemplate(s).map((p) => {
        if (p.type === 'text') return { type: 'literal', text: p.value };
        const ref = classifyRef(p.inner);
        return ref ? { type: 'ref', raw: p.raw, path: p.inner, wrapped: true, ...ref } : { type: 'literal', text: p.raw };
    });
}

function tokenizeExpression(s) {
    // A value that IS one reference (a stored ref, which may spell a key the
    // way the runtime reads but a formula would not, `headers.content-type`)
    // is one pill, whatever surrounds it.
    const trimmed = s.trim();
    if (isCleanPath(trimmed)) {
        const ref = classifyRef(trimmed);
        if (ref) {
            const lead = s.slice(0, s.length - s.trimStart().length);
            const trail = s.slice(s.trimEnd().length);
            return [
                ...(lead ? [{ type: 'literal', text: lead }] : []),
                { type: 'ref', raw: trimmed, path: trimmed, wrapped: false, ...ref },
                ...(trail ? [{ type: 'literal', text: trail }] : []),
            ];
        }
    }
    const tokens = [];
    for (const part of scanExprPaths(s, REF_ROOTS)) {
        const ref = part.path != null ? classifyRef(part.path) : null;
        const text = part.path ?? part.text;
        if (ref) tokens.push({ type: 'ref', raw: text, path: text, wrapped: false, ...ref });
        else if (tokens.length && tokens[tokens.length - 1].type === 'literal') tokens[tokens.length - 1].text += text;
        else tokens.push({ type: 'literal', text });
    }
    return tokens;
}

// ── The expression engine's path grammar, for scanning formulas ─────────
// Inside a formula a path is what the ENGINE reads as one (engine.mjs
// tokenize): the shared path grammar (path.mjs readPath: `[*]`, `[n]`,
// `["key"]`, `[key="value"]`, digits and accents after a dot, `items.0.price`)
// minus the two name characters that are operators or nothing to the engine,
// `-` (a minus: `total-1`, `a.total-b.tax`) and `@`. A computed index (`[i]`)
// ends the path. A whole value that is one stored ref keeps its dashed key
// (tokenizeExpression asks isCleanPath first).
const IDENT_START = /[\p{L}_$]/u;
const IDENT_CHAR = /[\p{L}\p{N}\p{M}_$]/u;
// What may sit right before a reference: anything but a name or member access.
const GLUED = /[\p{L}\p{N}\p{M}_$.]/u;
// An expanded flowlet's sub-step id (`steps.<call>/<sub>.output`), one id.
const INLINE_HEAD = /steps\.[A-Za-z_$][\w$]*(?:\/[A-Za-z_$][\w$]*)+\.output/y;
const MARK = /\p{M}/u;

function identEnd(s, i) {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- IDENT_START is one character class, tested on one character: linear
    if (!IDENT_START.test(s[i] || '')) return -1;
    let j = i + 1;
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- IDENT_CHAR is one character class, tested on one character per step: linear
    while (j < s.length && IDENT_CHAR.test(s[j])) j++;
    return j;
}

/** Just past the closing quote of the string starting at `i`, or -1 when it never closes. */
function stringEnd(s, i) {
    const q = s[i];
    for (let j = i + 1; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue; }
        if (s[j] === q) return j + 1;
    }
    return -1;
}

/**
 * Where the engine stops inside `s.slice(from, to)`, a span readPath read as
 * one path: at a `-` or `@` outside brackets (and before the dot that led
 * to it), or at a dot followed by a combining mark, which no engine name
 * starts with.
 */
function engineCut(s, from, to) {
    let depth = 0;
    for (let j = from; j < to; j++) {
        const c = s[j];
        if (c === '"' || c === "'") { j = stringEnd(s, j) - 1; continue; }
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (depth === 0 && (c === '-' || c === '@')) return s[j - 1] === '.' ? j - 1 : j;
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- MARK is one character class (\p{M}), tested on one character: linear
        else if (depth === 0 && c === '.' && MARK.test(s[j + 1] || '')) return j;
    }
    return to;
}

/** Where the engine's reading of a path that starts with the name at `i` ends. */
function exprPathEnd(s, i) {
    INLINE_HEAD.lastIndex = i;
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- INLINE_HEAD is sticky (one start, at i) and each [\w$]* stops at the / or . that must follow it, so no two quantifiers compete for a character: linear
    if (INLINE_HEAD.test(s)) {
        // The sub-step id is one key no grammar reads; the rest is a path
        // tail, read with a stand-in head in its place.
        const head = INLINE_HEAD.lastIndex;
        if (s[head] !== '.' && s[head] !== '[') return head;
        const tail = `$${s.slice(head)}`;
        const r = readPath(tail, 0);
        return head + engineCut(tail, 1, r.end) - 1;
    }
    const r = readPath(s, i);
    return r ? engineCut(s, i, r.end) : -1;
}

/**
 * Split a formula into text and the paths that start at one of `roots`:
 * `[{ text }, { path }, …]`, in order, concatenating back to the input. Text
 * inside string literals is never a path.
 */
export function scanExprPaths(text, roots = REF_ROOTS) {
    const s = String(text ?? '');
    const rootSet = new Set(roots);
    const out = [];
    let last = 0;
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === '"' || c === "'") {
            const e = stringEnd(s, i);
            i = e < 0 ? s.length : e;
            continue;
        }
        const wordEnd = identEnd(s, i);
        if (wordEnd < 0) { i++; continue; }
        if ((i > 0 && GLUED.test(s[i - 1])) || !rootSet.has(s.slice(i, wordEnd))) { i = wordEnd; continue; }
        const end = exprPathEnd(s, i);
        if (i > last) out.push({ text: s.slice(last, i) });
        out.push({ path: s.slice(i, end) });
        last = i = end;
    }
    if (last < s.length) out.push({ text: s.slice(last) });
    return out;
}

/** Concatenate tokens back into the original string (round-trip safe). */
export function serializeRefTokens(tokens) {
    if (!Array.isArray(tokens)) return '';
    return tokens.map(t => (t.type === 'literal' ? t.text : t.raw)).join('');
}

/** Cheap predicate: does this value contain at least one renderable ref? */
export function hasRefTokens(text, mode) {
    return parseRefTokens(text, { mode }).some(t => t.type === 'ref');
}

/**
 * Resolve the display label for a ref token.
 *   { name, suffix, missing }
 * `name` is the human step label (or 'Trigger' / 'Each <item>'); `suffix` is
 * the field path shown after the name. `missing` is true only for a steps
 * ref whose id is no longer in the definition (deleted step) — rendered as
 * a muted chip, never an error.
 */
export function resolveChipLabel(token, stepLabelById = null) {
    if (!token) return { name: '', suffix: '', missing: false };
    if (token.source === 'steps') {
        const known = !!stepLabelById?.has?.(token.stepId);
        const name = stepLabelById?.get?.(token.stepId) || token.stepId;
        return { name, suffix: token.fieldPath || '', missing: !known };
    }
    if (token.source === 'trigger') {
        return { name: 'Trigger', suffix: token.fieldPath || '', missing: false };
    }
    if (token.source === 'loop') {
        // "Each line ▸ Sku": says what the step runs over, not how (no "loop").
        const name = token.itemVar ? `Each ${token.itemVar}` : 'Each item';
        return { name, suffix: token.fieldPath || '', missing: false };
    }
    return { name: token.path || '', suffix: '', missing: false };
}
