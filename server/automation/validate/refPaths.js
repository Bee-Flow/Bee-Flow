'use strict';

/**
 * Reference paths, templates and expressions as the VALIDATOR reads them —
 * with the runner's own readers (shared/expr: path.mjs and the expression
 * engine), never a regex of its own. A path the run resolves therefore never
 * warns, and a path it cannot resolve always does.
 *
 * The validator used to read the first two identifier segments of a path and
 * assume the rest was well formed: `fields.Story Points` validated clean and
 * resolved to nothing, `steps["s1"]` was "missing a step id", and a `}` inside
 * a quoted key hid a whole placeholder.
 */

const {
    parsePath, readPath, formatPath, canonicalPath, scanTemplate, replaceTemplate, parseExpr,
} = require('../expr');

/** The roots a run-state reference can start from. */
const REF_ROOTS = new Set(['trigger', 'steps', 'vars', 'secrets', 'loop']);

/**
 * The head of a reference path: whether the whole path parses, its root, and
 * the second key (the step id after `steps`, the item variable after `loop`).
 * The head is read even when the tail does not parse, so a broken path still
 * names the step it reads — that step is checked like any other.
 *
 * @returns {{ valid: boolean, root: string|null, second: string|null, tokens: object[] }}
 */
function refHead(path) {
    const p = typeof path === 'string' ? path.trim() : '';
    const whole = parsePath(p);
    const tokens = whole || (readPath(p, 0)?.tokens ?? []);
    const root = tokens[0] && tokens[0].type === 'prop' ? String(tokens[0].key) : null;
    const second = tokens[1] && tokens[1].type === 'prop' ? String(tokens[1].key) : null;
    return { valid: !!whole, root, second, tokens };
}

/** The inside of every `{{ … }}` placeholder, read quote-aware like the runner. */
function templateRefs(text) {
    if (typeof text !== 'string' || !text.includes('{{')) return [];
    return scanTemplate(text).filter(p => p.type === 'ref').map(p => p.inner);
}

/** True when the text has at least one placeholder the runner would fill. */
function hasPlaceholder(text) {
    return templateRefs(text).length > 0;
}

/**
 * Is a BARE string (no binding wrapper) a reference path, the way the runner
 * decides it for data_extraction.source (`^(trigger|steps|vars|loop)\.`)?
 * Kept to the runner's reading on purpose: a validator that called a string a
 * reference where the runner reads it as literal text would pass a step that
 * then extracts from the words of a path.
 */
function isBareRefString(s) {
    if (typeof s !== 'string') return false;
    const t = s.trim();
    const { root } = refHead(t);
    return !!root && root !== 'secrets' && REF_ROOTS.has(root) && t[root.length] === '.';
}

/**
 * The tokens of a path RELATIVE to a value — parse_json's field paths and
 * `itemsRef` — or null when the runner cannot read it. Accepts exactly what
 * shared getRelativePath resolves (and nothing it does not): `''`/`'$'` is
 * the value itself (no tokens), `a.b`, `[0].x`, `[*].sku`, and the JSONPath
 * habit `$.a` / `$[0]`. The old grammar here (PARSE_JSON_PATH_RE) took `$` for
 * a key, so `$.order.id` validated and then resolved to nothing.
 */
function relativePathTokens(path) {
    if (path === null || path === undefined) return [];
    if (typeof path !== 'string') return null;
    let p = path.trim();
    if (p === '' || p === '$') return [];
    if (p.startsWith('$.')) p = p.slice(2);
    else if (p.startsWith('$[')) p = p.slice(1);
    const tokens = parsePath(p.startsWith('[') ? `$${p}` : `$.${p}`);
    return tokens ? tokens.slice(1) : null;
}

/**
 * Split a reference path after its first `n` segments, keeping the rest
 * exactly as written: `steps.read.output.files.0.name`, 3 →
 * { head: [steps, read, output], rest: 'files.0.name' }. For showing a path
 * to a person ("Read invoice › files.0.name") without re-spelling the part
 * they wrote. null when the path has fewer than `n` readable segments.
 */
function splitPathHead(path, n) {
    if (typeof path !== 'string') return null;
    const p = path.trim();
    const full = readPath(p, 0);
    if (!full || full.tokens.length < n) return null;
    for (let k = 1; k <= full.end; k++) {
        if (k < p.length && p[k] !== '.' && p[k] !== '[') continue;   // not a segment boundary
        const r = readPath(p.slice(0, k), 0);
        if (r && r.end === k && r.tokens.length === n) {
            return { head: r.tokens, rest: p.slice(k).replace(/^\./, '') };
        }
    }
    return null;
}

// What may sit right before a root for it to START a path rather than be the
// tail of a longer name or a member (`vars.steps.x`, `my_steps.x`).
const NOT_A_START = /[\p{L}\p{N}\p{M}_$@.\-\]]/u;

/**
 * Every reference path that starts with one of `roots` anywhere in a piece of
 * text (a template, an expression, a bare path), as token lists read by the
 * runner's reader: `{{ steps.a.output["e-mail"] }}` yields
 * [steps, a, output, e-mail]. For heuristics that need every read a step
 * makes, whatever field it sits in; the scoping checks use the precise
 * per-surface readers above.
 */
function findRefPaths(text, roots = REF_ROOTS) {
    const out = [];
    if (typeof text !== 'string' || !text) return out;
    for (const root of roots) {
        let i = text.indexOf(root);
        while (i >= 0) {
            // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- NOT_A_START is one character class tested on a single character: linear
            if (i === 0 || !NOT_A_START.test(text[i - 1])) {
                const r = readPath(text, i);
                if (r && r.tokens[0].key === root && r.tokens.length > 1) out.push(r.tokens);
            }
            i = text.indexOf(root, i + root.length);
        }
    }
    return out;
}

// ── Suggestions ─────────────────────────────────────────────────────────

// Characters that say the author typed a calculation or a filter, not a key:
// a "bracket it" suggestion would only make that worse.
const OPERATOR_CHARS = /[|(){}<>=!+*,;&?]/;

/**
 * The spelling the runner would read, for a path that does not parse — or
 * null when there is no confident one. Valid stretches are read by the shared
 * reader; what it refuses is re-read leniently: a dotted piece with spaces or
 * symbols becomes a bracketed key (`fields.Story Points` →
 * `fields["Story Points"]`), an unquoted bracket key becomes a key
 * (`items[abc]` → `items.abc`), an unclosed bracket is closed, a doubled or
 * trailing dot is dropped. Returned only when the result parses.
 */
function suggestPathSpelling(path) {
    if (typeof path !== 'string') return null;
    const p = path.trim();
    if (!p || parsePath(p) || OPERATOR_CHARS.test(p.replace(/\[[^\]]*\]/g, ''))) return null;
    const tokens = [];
    let i = 0;
    const head = readPath(p, 0);
    if (head) { tokens.push(...head.tokens); i = head.end; }
    let guard = 0;
    while (i < p.length && guard++ < 256) {
        const c = p[i];
        if (c === '.' || c === '[') {
            // A valid run of segments from here, read by the shared reader.
            const run = readPath(`x${p.slice(i)}`, 0);
            if (run && run.end > 1) { tokens.push(...run.tokens.slice(1)); i += run.end - 1; continue; }
        }
        if (c === '.') {
            let j = i + 1;
            while (j < p.length && p[j] !== '.' && p[j] !== '[') j++;
            const piece = p.slice(i + 1, j).trim();
            if (piece) tokens.push({ type: 'prop', key: piece });
            i = j;
            continue;
        }
        if (c === '[') {
            let j = p.indexOf(']', i + 1);
            if (j < 0) j = p.length;
            let inner = p.slice(i + 1, j).trim();
            const q = inner[0];
            if ((q === '"' || q === "'") && inner.endsWith(q) && inner.length > 1) inner = inner.slice(1, -1);
            else if (q === '"' || q === "'") inner = inner.slice(1);
            if (inner === '*') tokens.push({ type: 'wild' });
            else if (/^-?[0-9]+$/.test(inner)) tokens.push({ type: 'prop', key: Number.isSafeInteger(Number(inner)) ? Number(inner) : inner });
            else if (inner) tokens.push({ type: 'prop', key: inner });
            i = j + 1;
            continue;
        }
        // Text the reader stopped at in the middle of a dotted name (a space,
        // a slash, …): it belongs to that name.
        let j = i;
        while (j < p.length && p[j] !== '.' && p[j] !== '[') j++;
        const last = tokens[tokens.length - 1];
        if (last && last.type === 'prop' && typeof last.key === 'string') last.key += p.slice(i, j);
        else tokens.push({ type: 'prop', key: p.slice(i, j).trim() });
        i = j;
    }
    if (!tokens.length) return null;
    const out = formatPath(tokens);
    return parsePath(out) && out !== p ? out : null;
}

/**
 * suggestPathSpelling for a RELATIVE path (parse_json fields, App Studio
 * result and record paths): the same repair, without a root.
 */
function suggestRelativeSpelling(path) {
    if (typeof path !== 'string' || relativePathTokens(path) !== null) return null;
    const p = path.trim().replace(/^\$(?=[.[])/, '');
    const s = suggestPathSpelling(p.startsWith('[') ? `$${p}` : `$.${p}`);
    if (!s) return null;
    return s.startsWith('$.') ? s.slice(2) : s.slice(1);
}

/**
 * A spelling of an expression that parses, for one that does not — or null.
 * Two mistakes are common enough to fix by name: a reference path the
 * expression grammar cannot read (`attachments.0.filename`, `first-name`),
 * and `{{ }}` braces around a path inside an expression.
 */
function suggestExprSpelling(src, opts) {
    if (typeof src !== 'string') return null;
    const candidates = [];
    if (src.includes('{{')) candidates.push(replaceTemplate(src, inner => canonicalPath(inner) || inner));
    const asPath = canonicalPath(src);
    if (asPath) candidates.push(asPath);
    for (const c of candidates) {
        if (c === src) continue;
        try { parseExpr(c, opts); return c.trim(); } catch { /* next */ }
    }
    return null;
}

// ── Expressions ─────────────────────────────────────────────────────────

/** Parse an expression: `{ ast }` or `{ error }`, never a throw. */
function tryParseExpr(src, opts) {
    try { return { ast: parseExpr(src, opts) }; } catch (e) { return { error: e }; }
}

/**
 * Every step an expression reads, as written: `steps.<id>…` and
 * `steps["<id>"]…`. Walks the AST (the same keys engine.mjs collectRefs
 * walks), so quoted text and a member called `steps` are never mistaken for
 * a reference, and a match value (`list[id="s1"]`) is a value.
 */
function exprStepIds(ast, out = []) {
    if (!ast || typeof ast !== 'object') return out;
    if (ast.kind === 'path' && Array.isArray(ast.segments)) {
        const [first, second] = ast.segments;
        if (first?.kind === 'name' && first.v === 'steps' && second) {
            if (second.kind === 'name') out.push(String(second.v));
            else if (second.kind === 'index' && second.expr?.kind === 'str') out.push(second.expr.v);
        }
        for (const s of ast.segments) if (s.expr) exprStepIds(s.expr, out);
    }
    for (const key of ['a', 'b', 'cond', 'expr']) if (ast[key]) exprStepIds(ast[key], out);
    if (Array.isArray(ast.args)) for (const a of ast.args) exprStepIds(a, out);
    return out;
}

module.exports = {
    REF_ROOTS,
    refHead,
    templateRefs,
    hasPlaceholder,
    isBareRefString,
    relativePathTokens,
    splitPathHead,
    findRefPaths,
    suggestPathSpelling,
    suggestRelativeSpelling,
    suggestExprSpelling,
    tryParseExpr,
    exprStepIds,
};
