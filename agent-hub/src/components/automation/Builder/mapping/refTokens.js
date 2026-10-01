/**
 * Tokenize a bound-field value into literal text and REFERENCE tokens, so the
 * inspector can render references as chips that show the human step NAME
 * instead of the raw id (`steps.ai_87e358…`).
 *
 * This is DISPLAY-ONLY. The stored value is never changed — the runtime
 * resolver (server/automation/bind.js) needs the id-based path. Chips are
 * rendered over a read-only view of the field; editing happens on the raw
 * text. `serializeRefTokens(parseRefTokens(x)) === x` for any input.
 *
 * Five ref sources are recognised, matching the runtime paths:
 *   steps.<id>.output[<field>]    → keyed by step id (resolvable to a label)
 *   trigger[.output][<field>]     → the automation trigger
 *   loop.<itemVar>[<field>]       → the current forEach/loop item
 *   item[<field>]                 → the row a list-mode step is on
 *   vars[<field>]                 → the routine's variables
 *
 * `<field>` is any tail of `.key`, `[0]`, `[*]` and `["any key"]` segments,
 * so a key written in brackets right after `output` (`output["content-type"]`)
 * is part of the pill, not text left behind it. The steps/trigger/loop
 * spellings the editor has always shown as pills keep their pill; the rest
 * is a ref only when the shared mapping core reads it as one (sourceFromPath,
 * over parseLegacyPath), so a pill never claims a value the run cannot read.
 *
 * `trigger.<key>` without `.output` reads the trigger's own metadata (id,
 * kind, firedAt, …), not the payload. For any other key it reads nothing, so
 * such a token carries `noOutput: true` and its chip is shown as missing.
 */
import { sourceFromPath, TRIGGER_RUN_KEYS } from '@shared/mapping/index.mjs';
import { TEMPLATE_RE } from '../../../../utils/bindingHelpers';

// Identifier (step id / itemVar) and the segments of a field path tail.
const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';
const SEGMENT = '\\.[A-Za-z0-9_$]+|\\[[^\\]]*\\]';
const TAIL = `((?:${SEGMENT})*)`;

// Scans an EXPRESSION/ref string for candidate paths: a root word and every
// segment after it. The negative lookbehind rejects lookalikes (`mysteps.x`,
// `x.loop.y`, a word inside a quoted key) without consuming a prefix char, so
// the gaps between matches are exactly the literal spans — which is what
// keeps the round-trip byte-faithful. The lookahead keeps a root word whole
// (`items`, `itemCount` are no `item` pill). classifyPrefix then keeps the
// longest part of the candidate that is a ref.
const SCAN_RE = new RegExp(`(?<![A-Za-z0-9_$."'])(?:steps|trigger|loop|item|vars)(?![A-Za-z0-9_$])(?:${SEGMENT})*`, 'g');
const SEGMENT_RE = new RegExp(SEGMENT, 'g');

// Anchored variants used to classify a whole path (the inside of a `{{ … }}`).
const STEPS_ANCHOR = new RegExp(`^steps\\.(${IDENT})\\.output${TAIL}$`);
const TRIGGER_ANCHOR = new RegExp(`^trigger(\\.output)?${TAIL}$`);
const LOOP_ANCHOR = new RegExp(`^loop\\.(${IDENT})${TAIL}$`);
const ITEM_ANCHOR = new RegExp(`^(item|vars)${TAIL}$`);

// The trigger metadata keys a bare `trigger.<key>` reads on purpose.
const RUN_KEYS = new Set(TRIGGER_RUN_KEYS);

/** A tail as the field path a chip shows: `.a.b` → `a.b`, `["x"]` as it is. */
function fieldOf(tail) {
    return String(tail || '').replace(/^\./, '');
}

/** The first key of a tail (`.subject[0]` → `subject`), or ''. */
function firstKey(tail) {
    const m = /^\.([A-Za-z0-9_$]+)/.exec(String(tail || ''));
    return m ? m[1] : '';
}

/**
 * Classify a bare path string (no `{{}}`, already trimmed) as a ref.
 * Returns `{ source, stepId?, itemVar?, fieldPath, noOutput? }` or null.
 */
export function classifyRef(path) {
    if (typeof path !== 'string') return null;
    const text = path.trim();
    let m;
    if ((m = STEPS_ANCHOR.exec(text))) {
        return { source: 'steps', stepId: m[1], fieldPath: fieldOf(m[2]) };
    }
    if ((m = LOOP_ANCHOR.exec(text))) {
        return { source: 'loop', itemVar: m[1], fieldPath: fieldOf(m[2]) };
    }
    if ((m = TRIGGER_ANCHOR.exec(text))) {
        const ref = { source: 'trigger', fieldPath: fieldOf(m[2]) };
        // `trigger.subject`: neither the payload nor the trigger's metadata.
        if (!m[1] && m[2] && !RUN_KEYS.has(firstKey(m[2]))) ref.noOutput = true;
        return ref;
    }
    // `item` and `vars` are refs only as the mapping core reads them.
    if ((m = ITEM_ANCHOR.exec(text)) && (m[2] === '' || sourceFromPath(text))) {
        return { source: m[1], fieldPath: fieldOf(m[2]) };
    }
    return null;
}

/**
 * The longest leading part of a scanned candidate that is a ref, as its
 * length, or 0 when even the root word alone is not one.
 */
function classifyPrefix(candidate) {
    const head = /^[A-Za-z]+/.exec(candidate)[0];
    const ends = [head.length];
    SEGMENT_RE.lastIndex = 0;
    let m;
    while ((m = SEGMENT_RE.exec(candidate.slice(head.length)))) ends.push(head.length + m.index + m[0].length);
    for (let i = ends.length - 1; i >= 0; i--) {
        const ref = classifyRef(candidate.slice(0, ends[i]));
        if (ref) return { length: ends[i], ref };
    }
    return null;
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
 * inner dotted path without braces.
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
    if (TEMPLATE_RE.test(s)) return tokenizeTemplate(s);
    if (mode === 'fixed') return [{ type: 'literal', text: s }];
    return tokenizeExpression(s);
}

function tokenizeTemplate(s) {
    const tokens = [];
    const TPL = /\{\{([^}]*)\}\}/g;
    let last = 0;
    let m;
    while ((m = TPL.exec(s))) {
        if (m.index > last) tokens.push({ type: 'literal', text: s.slice(last, m.index) });
        const full = m[0];
        const inner = m[1].trim();
        const ref = classifyRef(inner);
        if (ref) tokens.push({ type: 'ref', raw: full, path: inner, wrapped: true, ...ref });
        else tokens.push({ type: 'literal', text: full });
        last = m.index + full.length;
    }
    if (last < s.length) tokens.push({ type: 'literal', text: s.slice(last) });
    return tokens;
}

/**
 * The end of every quoted string literal in an expression, by its start:
 * `"…"` and `'…'`, a backslash escaping the next character. An unclosed one
 * runs to the end. A word inside one (`"3 items left"`) is text, never a ref.
 */
function stringEnds(s) {
    const ends = new Map();
    for (let i = 0; i < s.length; i++) {
        const q = s[i];
        if (q !== '"' && q !== "'") continue;
        let j = i + 1;
        while (j < s.length && s[j] !== q) j += s[j] === '\\' ? 2 : 1;
        ends.set(i, Math.min(j + 1, s.length));
        i = j;
    }
    return ends;
}

function tokenizeExpression(s) {
    const tokens = [];
    const strings = [...stringEnds(s)];
    SCAN_RE.lastIndex = 0;
    let last = 0;
    let m;
    while ((m = SCAN_RE.exec(s))) {
        const at = m.index;
        const inString = strings.find(([start, end]) => start < at && at < end);
        if (inString) { SCAN_RE.lastIndex = inString[1]; continue; }
        const hit = classifyPrefix(m[0]);
        if (!hit) continue;
        if (m.index > last) tokens.push({ type: 'literal', text: s.slice(last, m.index) });
        const full = m[0].slice(0, hit.length);
        tokens.push({ type: 'ref', raw: full, path: full, wrapped: false, ...hit.ref });
        last = m.index + full.length;
        SCAN_RE.lastIndex = last;
    }
    if (last < s.length) tokens.push({ type: 'literal', text: s.slice(last) });
    return tokens;
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
 * `name` is the human step label (or 'Trigger' / 'Loop item'); `suffix` is
 * the field path shown after the name. `missing` is true for a steps
 * ref whose id is no longer in the definition (deleted step) — rendered as
 * a muted chip, never an error — and for a `trigger.<key>` that reads
 * neither the payload nor the trigger's metadata (`noOutput`): that one runs
 * empty, so it must not look like a working chip.
 */
export function resolveChipLabel(token, stepLabelById = null) {
    if (!token) return { name: '', suffix: '', missing: false };
    if (token.source === 'steps') {
        const known = !!stepLabelById?.has?.(token.stepId);
        const name = stepLabelById?.get?.(token.stepId) || token.stepId;
        return { name, suffix: token.fieldPath || '', missing: !known };
    }
    if (token.source === 'trigger') {
        return { name: 'Trigger', suffix: token.fieldPath || '', missing: token.noOutput === true };
    }
    if (token.source === 'loop') {
        const name = token.itemVar ? `Loop item · ${token.itemVar}` : 'Loop item';
        return { name, suffix: token.fieldPath || '', missing: false };
    }
    // The names the rest of the editor gives these roots (the Edit data step's "Current row").
    if (token.source === 'item') return { name: 'Current row', suffix: token.fieldPath || '', missing: false };
    if (token.source === 'vars') return { name: 'Variable', suffix: token.fieldPath || '', missing: false };
    return { name: token.path || '', suffix: '', missing: false };
}
