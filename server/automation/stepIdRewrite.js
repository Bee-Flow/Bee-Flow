'use strict';

/**
 * Renaming step ids inside the text of a definition: the half of
 * portability.rekeyDefinition (import, Blueprint install, upgrade) that finds
 * a step id wherever a person or the builder may have written it.
 *
 * A step is addressed as `steps.<id>`, `steps["<id>"]` or `steps['<id>']`,
 * and that address turns up in three kinds of text:
 *   - a whole REFERENCE PATH (`{kind:'ref'}`, `forEach.overRef`, `sourceRef`,
 *     `arrayRef`, …), read by bind.js with the shared path grammar;
 *   - the `{{ … }}` placeholders of a TEMPLATE (notification bodies, HTTP
 *     URLs, prompts, …), each one a reference path;
 *   - an EXPRESSION (`condition.expr`, switch rules, approval stage
 *     conditions, `{kind:'expr'}`), read by the expression engine, where `-`
 *     is minus and `"…"` is a string literal.
 *
 * Every rewrite here changes ONLY the step-id token and leaves the rest of
 * the text byte for byte as it was: the spelling the author chose (dotted or
 * bracketed, spacing inside `{{ }}`), the tail of the path, and anything the
 * reader would not take for a step address. A path is read with the shared
 * reader (shared/expr/path.mjs readPath), never a regex of its own, so a
 * match segment (`headers[name="s1"]`), a quoted key with `}` or `]` in it,
 * or a unicode key is understood exactly as the runner understands it — and
 * a step id that only appears INSIDE such a key or match value is left
 * alone, because it is not a step address.
 */

const { readPath, parsePath, scanTemplate, parseExpr, TOPIC_HOST_SPEC, isIdentifierKey } = require('./expr');

const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

/** The new id for `id`, or null. Own keys only: a step called `constructor` must not find Object's. */
function renamed(map, id) {
    if (!hasOwn(map, id)) return null;
    const next = map[id];
    return typeof next === 'string' && next ? next : null;
}

/** A key quoted the way the source quoted it (`"` or `'`); both readers decode the escapes. */
function quoteAs(key, quote) {
    if (quote === '"') return JSON.stringify(String(key));
    return `'${String(key).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** End (exclusive) of the quoted literal that opens at `src[i]`, or -1. */
function quotedEnd(src, i) {
    const q = src[i];
    let j = i + 1;
    while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === q) return j + 1;
        j++;
    }
    return -1;
}

const sameTokens = (a, b) => a.length === b.length && a.every((t, i) => (
    t.type === b[i].type && t.key === b[i].key && t.value === b[i].value
));

/**
 * Rename the step a REFERENCE PATH addresses. `path` may carry surrounding
 * whitespace (the inside of `{{ … }}`), which is kept. Only the head is
 * looked at, and a path whose tail does not parse still gets its step id
 * renamed: the author then has one problem (the tail) instead of two.
 */
function rewriteRefPath(path, map) {
    if (typeof path !== 'string' || !path.includes('steps')) return path;
    const at = path.length - path.trimStart().length;
    const read = readPath(path, at);
    if (!read || read.tokens.length < 2) return path;
    const [head, idTok] = read.tokens;
    if (head.key !== 'steps' || idTok.type !== 'prop') return path;
    const next = renamed(map, String(idTok.key));
    if (!next) return path;

    const sep = at + 'steps'.length;            // where the id segment starts
    let out;
    if (path[sep] === '.') {
        // A dotted name is read verbatim, so the id is exactly its text.
        const end = sep + 1 + String(idTok.key).length;
        out = isIdentifierKey(next)
            ? path.slice(0, sep + 1) + next + path.slice(end)
            : `${path.slice(0, sep)}[${JSON.stringify(next)}]${path.slice(end)}`;
    } else {
        // `steps[ "id" ]` — swap the quoted literal, keep the brackets' spacing.
        let q = sep + 1;
        while (path[q] === ' ') q++;
        if (path[q] !== '"' && path[q] !== "'") return path;   // `steps[0]`: not an id anyone writes
        const end = quotedEnd(path, q);
        if (end < 0) return path;
        out = path.slice(0, q) + quoteAs(next, path[q]) + path.slice(end);
    }
    // The rewrite must read back as the same path with only the id changed;
    // anything else means the text was not what it looked like — leave it.
    const back = readPath(out, at);
    const want = [read.tokens[0], { type: 'prop', key: next }, ...read.tokens.slice(2)];
    return back && back.end === read.end + (out.length - path.length) && sameTokens(back.tokens, want) ? out : path;
}

/**
 * Rename step ids inside every `{{ … }}` placeholder of a template, with the
 * runner's own quote-aware scanner (so `{{ x["a}}b"] }}` is one placeholder).
 * Text outside the placeholders, and the spacing inside them, is untouched.
 *
 * The rename works on the placeholder's `inner`, the very text the runner
 * resolves and the validator checks, not on a fixed slice of `raw`: the
 * scanner also reads the Handlebars spelling `{{{ x }}}`, and whatever
 * delimiters it accepts (now or later) stay exactly as the author typed them.
 */
function rewriteTemplate(text, map) {
    if (typeof text !== 'string' || !text.includes('{{')) return text;
    let out = '';
    let last = 0;
    for (const part of scanTemplate(text)) {
        if (part.type !== 'ref') continue;
        const next = rewriteRefPath(part.inner, map);
        if (next === part.inner) continue;
        // `inner` is the trimmed text between the delimiters, so it starts
        // after the opening `{{`. Slices, not String.replace: a `$` in an id
        // must stay literal.
        const lead = part.raw.indexOf(part.inner, 2);
        if (lead < 0) continue;
        out += text.slice(last, part.start) + part.raw.slice(0, lead) + next + part.raw.slice(lead + part.inner.length);
        last = part.end;
    }
    return last ? out + text.slice(last) : text;
}

// The expression engine's lexical rules (engine.mjs tokenize), only as far as
// finding identifiers needs them: string literals are skipped whole, numbers
// are not identifiers, an identifier after `.` is a member, not a root.
const ID_START = /[A-Za-z_$]/;
const ID_CHAR = /[A-Za-z0-9_$]/;
const SPACE = /\s/;
const DIGIT = /[0-9]/;
const DECODE = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };

/** The value of the string literal `src.slice(i, end)`, with the engine's escapes. */
function decodeLiteral(lit) {
    let out = '';
    for (let j = 1; j < lit.length - 1; j++) {
        const c = lit[j];
        if (c !== '\\') { out += c; continue; }
        const n = lit[j + 1];
        if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(lit.slice(j + 2, j + 6))) {
            out += String.fromCharCode(parseInt(lit.slice(j + 2, j + 6), 16));
            j += 5;
            continue;
        }
        out += hasOwn(DECODE, n) ? DECODE[n] : n;
        j++;
    }
    return out;
}

/**
 * Rename `steps.<id>` / `steps["<id>"]` lookups inside an EXPRESSION. Quoted
 * text is never touched (`status == "steps.s1 failed"` keeps its message), a
 * member called `steps` (`vars.steps.s1`) is not a root, and a match segment
 * (`steps.g.output.list[id="s1"]`) is not a step address.
 */
function rewriteExpr(src, map) {
    if (typeof src !== 'string' || !src.includes('steps')) return src;
    const edits = [];
    const skipSpace = (k) => { while (k < src.length && SPACE.test(src[k])) k++; return k; };
    let afterDot = false;
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (SPACE.test(c)) { i++; continue; }
        if (DIGIT.test(c) || (c === '.' && DIGIT.test(src[i + 1] || ''))) {
            while (i < src.length && /[0-9.]/.test(src[i])) i++;
            afterDot = false;
            continue;
        }
        if (c === '"' || c === "'") {
            const end = quotedEnd(src, i);
            if (end < 0) break;                       // unterminated: nothing after it is code
            i = end;
            afterDot = false;
            continue;
        }
        if (ID_START.test(c)) {
            let j = i;
            while (j < src.length && ID_CHAR.test(src[j])) j++;
            if (src.slice(i, j) === 'steps' && !afterDot) {
                const k = skipSpace(j);
                if (src[k] === '.') {
                    const s = skipSpace(k + 1);
                    let e = s;
                    while (e < src.length && ID_CHAR.test(src[e])) e++;
                    const next = e > s && ID_START.test(src[s]) ? renamed(map, src.slice(s, e)) : null;
                    if (next) edits.push(isIdentifierKey(next) ? [s, e, next] : [k, e, `[${JSON.stringify(next)}]`]);
                } else if (src[k] === '[') {
                    const s = skipSpace(k + 1);
                    if (src[s] === '"' || src[s] === "'") {
                        const end = quotedEnd(src, s);
                        const next = end > 0 && src[skipSpace(end)] === ']' ? renamed(map, decodeLiteral(src.slice(s, end))) : null;
                        if (next) edits.push([s, end, quoteAs(next, src[s])]);
                    }
                }
            }
            i = j;
            afterDot = false;
            continue;
        }
        afterDot = c === '.';
        i++;
    }
    if (!edits.length) return src;
    let out = src;
    for (const [s, e, text] of edits.reverse()) out = out.slice(0, s) + text + out.slice(e);
    return out;
}

/** True when `s` parses as an expression (the topic host allowed, as conditions allow it). */
function isExpression(s) {
    try { parseExpr(s, { host: TOPIC_HOST_SPEC }); return true; } catch { return false; }
}

/**
 * True when `s` is, on one line, a step address that goes on as a path
 * (`steps.<id>.…` or `steps.<id>[…`) but whose tail does not parse:
 * `steps.s1.output.Story Points`, a trailing `.`, an unclosed `[`. A
 * sentence that merely starts with a step address (`steps.s1 failed`), or
 * runs over several lines, is not.
 */
function isPathWithBrokenTail(s) {
    if (/[\r\n]/.test(s.trim())) return false;
    const read = readPath(s, s.length - s.trimStart().length);
    if (!read || read.tokens.length < 2 || read.tokens[0].key !== 'steps') return false;
    return read.tokens.length > 2 || s[read.end] === '.' || s[read.end] === '[';
}

/**
 * Rename step ids in a string whose role is not known in advance (the
 * generic walk over a step's fields): a template when it has placeholders, a
 * reference path when the whole string is one, an expression when it parses
 * as one, and a path whose tail does not parse (a loop's overRef of
 * `steps.s1.output.Story Points`) in its head only — the copy then has one
 * problem, the tail, instead of also naming a step that no longer exists.
 * Prose is none of these and is left alone.
 */
function rewriteAnyString(s, map) {
    if (typeof s !== 'string' || !s.includes('steps')) return s;
    if (s.includes('{{')) return rewriteTemplate(s, map);
    if (parsePath(s)) return rewriteRefPath(s, map);
    if (isExpression(s)) return rewriteExpr(s, map);
    return isPathWithBrokenTail(s) ? rewriteRefPath(s, map) : s;
}

module.exports = { rewriteRefPath, rewriteTemplate, rewriteExpr, rewriteAnyString };
