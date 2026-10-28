// @typecheck
const bfElements = require('./bfElements');

/**
 * How many marked lines we write out at most.
 *
 * Higher than MAX_REPORTED_CALLS because this has a DIFFERENT consumer: the
 * Code tab draws markings with it in the editor, and a page that has more
 * than this gets some of its lines unmarked. What falls away is
 * counted (`truncated`), so that the legend can say so instead of silently showing less.
 */
const MAX_REPORTED_MARKS = 300;

/** How far beyond a `<bf-…` we look for attributes. */
const MAX_OPEN_TAG_LENGTH = 4096;

/** Attributen uit de ruwe tekst van één openingstag. */
const RE_ATTRIBUTE = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g;

/**
 * A value that the page builds ON THE SPOT: `source={id}` (JSX) or a
 * `${…}` in a template literal. Something stands there, but not something that can be read here.
 *
 * This distinction must exist because the alternative is worse than silence: without this
 * check the text `{id}` lands as DATATABLE ID in the usage index, where it looks exactly as real as
 * `tbl_1` and never belongs to a table again. "Not readable" is an answer; an invented id is not.
 *
 * The check is BEGINS-WITH-`{`, not begins-and-ends: `run={`auto_${n}`}` yields
 * only one character when the tag is read (the attribute reader stops at the backtick), and precisely such a half-read
 * value is the one that otherwise slips through as id. A real id never begins with a brace.
 */
const RE_EXPRESSION_VALUE = /^\{|\$\{/;

/**
 * @param {string | null} value
 */
function isExpressionValue(value) {
    return typeof value === 'string' && RE_EXPRESSION_VALUE.test(value.trim());
}

/**
 * Strip ONLY COMMENTS, character for character, keeping the length.
 *
 * `maskCode` above cannot do this: that one also masks string literals, and
 * precisely a string must stay — `el.innerHTML = '<bf-button run="a1">'`
 * is a real element that the page puts down. Conversely, commented-out
 * code is NOT a binding: the author saw a marked line with an address next to it
 * on code that is switched off, and the usage index claimed that the page uses that table.
 *
 * Length AND line endings stay equal, so that every index in the output still points
 * to exactly the same place in the input — the markings carry line numbers, so that is not negotiable.
 *
 * @param {string} text
 * @param {'html'|'css'|'js'|null} kind  language; anything else masks nothing, because
 *   guessing what is a comment in an unknown format can only strip too much —
 *   and counting an element too few is worse than counting one too many.
 */
function maskComments(text, kind) {
    const src = String(text || '');
    if (!src || !kind) return src;
    /**
     * @param {number} from
     * @param {number} to
     */
    const blank = (from, to) => src.slice(from, to).replace(/[^\n]/g, ' ');
    let out = '';
    let i = 0;
    const n = src.length;

    if (kind === 'html') {
        while (i < n) {
            const start = src.indexOf('<!--', i);
            if (start === -1) { out += src.slice(i); break; }
            out += src.slice(i, start);
            let end = src.indexOf('-->', start + 4);
            end = end === -1 ? n : end + 3;
            out += blank(start, end);
            i = end;
        }
        return out;
    }

    // css and js share `/* … */`; js additionally has `//` and must spare strings,
    // otherwise a `//` in "https://…" cuts off the rest of the line.
    const stringAware = kind === 'js';
    while (i < n) {
        const c = src[i];
        const c2 = src[i + 1];
        if (c === '/' && c2 === '*') {
            let j = src.indexOf('*/', i + 2);
            j = j === -1 ? n : j + 2;
            out += blank(i, j);
            i = j;
            continue;
        }
        if (stringAware && c === '/' && c2 === '/') {
            let j = i + 2;
            while (j < n && src[j] !== '\n') j++;
            out += blank(i, j);
            i = j;
            continue;
        }
        if (stringAware && (c === '"' || c === "'" || c === '`')) {
            const quote = c;
            let j = i + 1;
            while (j < n) {
                const d = src[j];
                if (d === '\\') { j += 2; continue; }
                if (d === quote) { j++; break; }
                if (quote !== '`' && d === '\n') break;
                j++;
            }
            out += src.slice(i, j);
            i = j;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/**
 * The language of a file, for `maskComments`. Unknown → do not mask.
 * @param {string} source
 * @param {string | null} slot
 */
function commentKindOf(source, slot) {
    if (slot === 'html' || slot === 'css' || slot === 'js') return slot;
    const name = String(source || '').toLowerCase();
    if (/\.(html?|xhtml)$/.test(name)) return 'html';
    if (/\.css$/.test(name)) return 'css';
    if (/\.(m?jsx?|tsx?)$/.test(name)) return 'js';
    return null;
}

/**
 * The raw attribute text of one opening tag, from `from` up to the `>`.
 *
 * Quotes count, so that a `>` IN an attribute value does not cut the tag short early.
 * An unclosed tag stops at the next `<` or at the upper bound — nothing is repaired
 * here, only read.
 * @param {string} src
 * @param {number} from
 */
function openTagText(src, from) {
    const stop = Math.min(src.length, from + MAX_OPEN_TAG_LENGTH);
    /** @type {string | null} */
    let quote = null;
    for (let i = from; i < stop; i++) {
        const c = src[i];
        if (quote) { if (c === quote) quote = null; continue; }
        if (c === '"' || c === '\'') { quote = c; continue; }
        if (c === '>' || c === '<') return src.slice(from, i);
    }
    return src.slice(from, stop);
}

/**
 * De geschreven attributen van een openingstag, op kleine letter.
 * @param {string} text
 */
function parseAttributes(text) {
    /** @type {Record<string, string>} */
    const out = {};
    const re = new RegExp(RE_ATTRIBUTE.source, 'g');
    /** @type {RegExpExecArray | null} */
    let m;
    while ((m = re.exec(text)) !== null) {
        const name = String(m[1]).toLowerCase();
        // The first spelling wins; a second time the same attribute is what
        // the browser also ignores.
        if (out[name] === undefined) out[name] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    return out;
}

/**
 * The value as the author WROTE it for the attribute that carries the binding.
 * Via the registry, because that attribute may also stand under an older
 * spelling (`datatable` beside `source`).
 * @param {string} tag
 * @param {Record<string, string>} attrs
 * @param {string} from
 */
function writtenBindingValue(tag, attrs, from) {
    for (const [name, value] of Object.entries(attrs)) {
        if (bfElements.canonicalAttribute(tag, name) === from) return value;
    }
    return null;
}

/**
 * One file: where does a `bf-*` element stand, and what does it bind?
 *
 * The pattern comes from the registry (`BF_TAG_SCAN`) — this file knows no
 * single tag name and no own idea of what an element looks like.
 *
 * @param {string} text
 * @param {string} source  the name that the author sees ('index.html', 'src/App.jsx')
 * @param {string|null} slot  'html'|'css'|'js' for one of the three slots, otherwise null
 */
function scanBfElementsIn(text, source, slot) {
    /**
     * @type {{ source: string; slot: string | null; line: number; tag: string; known: boolean; 
    // The FAMILY is what the element hangs on, not what it is called: the
    // Code tab tints on it. It comes from the DEFINITION, not from the
    // filled-in binding: a `<bf-table>` without `source` is still
    // a table element, and setting the family to `null` because the author
    // forgot the address would make "I do not know WHICH table" indistinguishable
    // from "this hangs on no table at all".
    // `null` therefore means: this KIND of element binds nothing.
    family: string | null; targetId: string | null; dynamic: boolean; fallback: string | null; 
    // `null` for an unknown element — "nothing is missing" is a
    // statement that you cannot make about it (see missingAttributes).
    missing: string[] | null; reason: string | null; }[]}
     */
    const marks = [];
    /** @type {string[]} */
    const unknown = [];
    if (!text) return { marks, total: 0, unknown };

    // Commented-out code is not a binding. `maskComments` keeps length
    // and line endings equal, so every index below still points to the same
    // place in the ORIGINAL — and the attributes are also read from the masked
    // text, so that an element half inside a comment does not yield an address after all.
    text = maskComments(text, commentKindOf(source, slot));

    const re = new RegExp(bfElements.BF_TAG_SCAN.source, 'gi');
    /** @type {RegExpExecArray | null} */
    let m;
    let total = 0;
    // Regelnummer meelopend bijhouden: de treffers komen in oplopende volgorde,
    // dus dit is één keer door de tekst in plaats van één keer per treffer.
    let cursor = 0;
    let line = 1;
    while ((m = re.exec(text)) !== null) {
        total++;
        for (let i = cursor; i < m.index; i++) if (text[i] === '\n') line++;
        cursor = m.index;

        const tag = String(m[1] || '').toLowerCase();
        const attrs = parseAttributes(openTagText(text, m.index + m[0].length));
        const info = bfElements.inspectBfElement(tag, attrs);
        const def = bfElements.getBfElement(tag);
        if (!info.known && !unknown.includes(tag)) unknown.push(tag);
        // Was there an EXPRESSION in the place of the address? Then the address
        // is not readable — and that is something other than a missing attribute,
        // because the author DID write it down. So `missing` stays empty
        // and `targetId` becomes `null`, with `dynamic` as the distinction.
        const dynamic = info.binding
            ? isExpressionValue(writtenBindingValue(tag, attrs, info.binding.from))
            : false;
        marks.push({
            source,
            slot,
            line,
            tag,
            known: info.known,
            // The FAMILY is what the element hangs on, not what it is called: the
            // Code tab tints on it. It comes from the DEFINITION, not from the
            // filled-in binding: a `<bf-table>` without `source` is still
            // a table element, and setting the family to `null` because the author
            // forgot the address would make "I do not know WHICH table" indistinguishable
            // from "this hangs on no table at all".
            // `null` therefore means: this KIND of element binds nothing.
            family: (def && def.binding) ? def.binding.kind : null,
            targetId: (info.binding && !dynamic) ? info.binding.id : null,
            dynamic,
            fallback: (def && def.binding) ? (def.binding.fallback || null) : null,
            // `null` for an unknown element — "nothing is missing" is a
            // statement that you cannot make about it (see missingAttributes).
            missing: info.missing,
            reason: info.reason,
        });
    }
    return { marks, total, unknown };
}

/**
 * Where do the `bf-*` elements of this page stand? Pure: pass the text along.
 *
 * Every text file that the editor can open is read — the three slots and
 * the extras. A react-mui page has its elements standing in `src/*.jsx`,
 * and an element that is not read yields no marking; that would not be
 * distinguishable from a page without bindings.
 *
 * @returns {{marks:Array, counts:{total:number,known:number,unknown:number},
 *            unknownTags:string[], truncated:number}}
 */
function scanBfElements({ html = '', css = '', js = '', extras = [] } = {}) {
    const parts = [
        scanBfElementsIn(html, 'index.html', 'html'),
        scanBfElementsIn(css, 'style.css', 'css'),
        scanBfElementsIn(js, 'script.js', 'js'),
    ];
    for (const file of (Array.isArray(extras) ? extras : [])) {
        if (!file || typeof file.text !== 'string') continue;
        parts.push(scanBfElementsIn(file.text, String(file.path || 'extra file'), null));
    }

    const all = [];
    /** @type {string[]} */
    const unknownTags = [];
    let total = 0;
    for (const part of parts) {
        total += part.total;
        for (const mark of part.marks) all.push(mark);
        for (const tag of part.unknown) if (!unknownTags.includes(tag)) unknownTags.push(tag);
    }

    const marks = all.slice(0, MAX_REPORTED_MARKS);
    return {
        marks,
        counts: {
            total,
            known: all.filter(mk => mk.known).length,
            unknown: all.filter(mk => !mk.known).length,
        },
        unknownTags,
        // What could no longer fit is counted and not hidden.
        truncated: Math.max(0, all.length - marks.length),
    };
}

module.exports = { maskComments, scanBfElements };
