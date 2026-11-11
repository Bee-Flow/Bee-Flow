// @typecheck strict
/**
 * Custom block: the strict reader of a template text.
 *
 * It reads a small, unambiguous subset of HTML and reports everything else with its line:
 *   <name attr="value" attr='value' attr=value attr>   a start tag (names are not case sensitive)
 *   </name>                                             its end tag; br, hr and wbr have none
 *   <path ... />                                        inside <svg> an element may close itself
 *   &amp; &lt; &gt; &quot; &apos; &nbsp; &#38; &#x26;   the entities it knows; any other & is text
 *   {{ formula }}                                       a < or a quote inside it does not start a tag or end a value
 * A comment, a doctype or a processing instruction is left out. The content of an element a
 * browser does not read as markup (script, style, textarea, title, ...) is skipped with it.
 *
 * It does no repair beyond closing what was left open, and it builds a tree for every
 * element name: which ones may stay is the sanitiser's decision (sanitize.mjs).
 */

import { HARD_DEPTH, RAW_TEXT_ELEMENTS, VOID_ELEMENTS } from './vocabulary.mjs';
import { interpolationEnd } from './interpolation.mjs';

/** @typedef {import('./vocabulary.mjs').TemplateNode} TemplateNode */
/** @typedef {import('./vocabulary.mjs').ElementNode} ElementNode */
/** @typedef {import('./vocabulary.mjs').BlockFinding} BlockFinding */

const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const TAG_CHARS = `${LETTERS}0123456789-`;
const ATTR_CHARS = `${LETTERS}0123456789-_:.`;
const SPACE = ' \t\n';
const HEX = '0123456789abcdefABCDEF';
const DIGITS = '0123456789';
/** @type {Readonly<Record<string, string>>} */
const ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' });

/** A code point a text may hold: no control character but tab and newline, no surrogate. */
function isTextCodePoint(/** @type {number} */ cp) {
    if (cp === 0x9 || cp === 0xa) return true;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return false;
    return cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
}

/** The character of the entity that starts at the `&` at `at`, and where it ends; null when it is none. */
function entityAt(/** @type {string} */ text, /** @type {number} */ at) {
    const end = text.indexOf(';', at);
    if (end === -1 || end - at > 10) return null;
    const body = text.slice(at + 1, end);
    if (Object.hasOwn(ENTITIES, body)) return { ch: ENTITIES[body], end: end + 1 };
    if (body[0] !== '#') return null;
    const hex = body[1] === 'x' || body[1] === 'X';
    const digits = body.slice(hex ? 2 : 1);
    if (!digits) return null;
    for (const d of digits) if (!(hex ? HEX : DIGITS).includes(d)) return null;
    const cp = parseInt(digits, hex ? 16 : 10);
    return isTextCodePoint(cp) ? { ch: String.fromCodePoint(cp), end: end + 1 } : null;
}

/**
 * `text` with its entities read, inside a formula too: a template is HTML, so `&lt;` in a
 * formula is its `<`, exactly as a browser's own reader hands it over.
 */
export function decodeEntities(/** @type {string} */ text) {
    if (!text.includes('&')) return text;
    let out = '';
    let i = 0;
    while (i < text.length) {
        const entity = text[i] === '&' ? entityAt(text, i) : null;
        if (entity) { out += entity.ch; i = entity.end; } else { out += text[i]; i += 1; }
    }
    return out;
}

/** The index of the first `<` at or after `from` that is not inside a formula; the length when there is none. */
function nextTagStart(/** @type {string} */ src, /** @type {number} */ from) {
    let i = from;
    while (i < src.length) {
        if (src[i] === '<') return i;
        if (src[i] === '{' && src[i + 1] === '{') {
            const end = interpolationEnd(src, i);
            if (end !== -1) { i = end + 2; continue; }
        }
        i += 1;
    }
    return src.length;
}

/** Where the quoted value that opens at `open` closes; a quote inside a formula does not close it. -1 when it never does. */
function quoteEnd(/** @type {string} */ src, /** @type {number} */ open) {
    const quote = src[open];
    let i = open + 1;
    while (i < src.length) {
        if (src[i] === quote) return i;
        if (src[i] === '{' && src[i + 1] === '{') {
            const end = interpolationEnd(src, i);
            if (end !== -1) { i = end + 2; continue; }
        }
        i += 1;
    }
    return -1;
}

function countLines(/** @type {string} */ src, /** @type {number} */ from, /** @type {number} */ to) {
    let n = 0;
    for (let i = src.indexOf('\n', from); i !== -1 && i < to; i = src.indexOf('\n', i + 1)) n += 1;
    return n;
}

const skipSpace = (/** @type {string} */ src, /** @type {number} */ i) => {
    while (i < src.length && SPACE.includes(src[i])) i += 1;
    return i;
};

/** Past the blanks and lone slashes between attributes; a `/>` is left standing. */
const skipTagFill = (/** @type {string} */ src, /** @type {number} */ i) => {
    while (i < src.length && (SPACE.includes(src[i]) || (src[i] === '/' && src[i + 1] !== '>'))) i += 1;
    return i;
};

const endsAttrName = (/** @type {string} */ src, /** @type {number} */ i) => SPACE.includes(src[i]) || src[i] === '=' || src[i] === '>' || (src[i] === '/' && src[i + 1] === '>');

function isAttrName(/** @type {string} */ attr) {
    if (!attr || attr.length > 60 || !LETTERS.includes(attr[0])) return false;
    for (const ch of attr) if (!ATTR_CHARS.includes(ch)) return false;
    return true;
}

/**
 * The value after an attribute name that ends at `i`: quoted, bare, or none.
 * @returns {{ value: string, end: number } | null}  null: a quote that never closes
 */
function readAttrValue(/** @type {string} */ src, /** @type {number} */ i) {
    const at = skipSpace(src, i);
    if (src[at] !== '=') return { value: '', end: at };
    const from = skipSpace(src, at + 1);
    if (src[from] === '"' || src[from] === "'") {
        const close = quoteEnd(src, from);
        return close === -1 ? null : { value: src.slice(from + 1, close), end: close + 1 };
    }
    let end = from;
    while (end < src.length && !SPACE.includes(src[end]) && src[end] !== '>') end += 1;
    return { value: src.slice(from, end), end };
}

/** @typedef {{ name: string, attrs: Array<[string, string]>, selfClosing: boolean, end: number, problems: string[] }} StartTag */

/** @param {StartTag} tag @param {Set<string>} seen @param {string} attr @param {string} value */
function addAttr(tag, seen, attr, value) {
    if (!isAttrName(attr)) tag.problems.push(`"${attr.slice(0, 40)}" is not an attribute name`);
    else if (seen.has(attr)) tag.problems.push(`the attribute ${attr} is written twice; the first one counts`);
    else { seen.add(attr); tag.attrs.push([attr, decodeEntities(value)]); }
}

/**
 * The start tag at `at` (a `<` followed by a letter).
 * @returns {StartTag | null}  null: the tag never closes
 */
function readStartTag(/** @type {string} */ src, /** @type {number} */ at) {
    let i = at + 1;
    while (i < src.length && TAG_CHARS.includes(src[i])) i += 1;
    /** @type {StartTag} */
    const tag = { name: src.slice(at + 1, i).toLowerCase(), attrs: [], selfClosing: false, end: 0, problems: [] };
    const seen = new Set();
    for (;;) {
        i = skipTagFill(src, i);
        if (i >= src.length) return null;
        if (src[i] === '>' || src[i] === '/') {
            tag.selfClosing = src[i] === '/';
            tag.end = i + (tag.selfClosing ? 2 : 1);
            return tag;
        }
        const start = i;
        while (i < src.length && !endsAttrName(src, i)) i += 1;
        const read = readAttrValue(src, i);
        if (!read) return null;
        addAttr(tag, seen, src.slice(start, i).toLowerCase(), read.value);
        i = read.end;
    }
}

/** Where the content of a raw-text element ends: the index of its `</name`, or the length. */
function rawTextEnd(/** @type {string} */ src, /** @type {number} */ from, /** @type {string} */ name) {
    if (name === 'plaintext') return src.length;
    const at = src.toLowerCase().indexOf(`</${name}`, from);
    return at === -1 ? src.length : at;
}

/**
 * The reader's place in a text.
 * @typedef {{ src: string, i: number, line: number, findings: BlockFinding[], stack: Array<{ name: string, svg: boolean, children: TemplateNode[], line: number }> }} Reader
 */

/** @param {Reader} r @param {string} code @param {string} message @param {number} [at] */
function note(r, code, message, at = r.line) {
    r.findings.push({ line: at, code, message });
}

/** Move on to `to`, counting the lines passed. */
function skipTo(/** @type {Reader} */ r, /** @type {number} */ to) {
    r.line += countLines(r.src, r.i, to);
    r.i = to;
}

const top = (/** @type {Reader} */ r) => r.stack[r.stack.length - 1];

/** Past the first `closer` after the current place, or to the end when there is none. */
function skipPast(/** @type {Reader} */ r, /** @type {string} */ closer, /** @type {number} */ from) {
    const end = r.src.indexOf(closer, from);
    skipTo(r, end === -1 ? r.src.length : end + closer.length);
}

/** An end tag: close the element it names, and whatever was left open inside it. */
function readEndTag(/** @type {Reader} */ r) {
    const end = r.src.indexOf('>', r.i);
    if (end === -1) { note(r, 'template.tag_unclosed', 'An end tag without ">" is left out.'); skipTo(r, r.src.length); return; }
    const name = r.src.slice(r.i + 2, end).trim().toLowerCase();
    skipTo(r, end + 1);
    if (VOID_ELEMENTS.has(name)) return;
    let at = r.stack.length - 1;
    while (at > 0 && r.stack[at].name !== name) at -= 1;
    if (at === 0) { note(r, 'template.end_tag_stray', `</${name.slice(0, 40)}> closes nothing and is left out.`); return; }
    for (let k = r.stack.length - 1; k > at; k--) note(r, 'template.unclosed', `<${r.stack[k].name}> is never closed.`, r.stack[k].line);
    r.stack.length = at;
}

/** Past the content and end tag of an element a browser does not read as markup. */
function skipRawText(/** @type {Reader} */ r, /** @type {StartTag} */ tag, /** @type {boolean} */ svg) {
    if (tag.selfClosing && svg) return;
    const end = rawTextEnd(r.src, r.i, tag.name);
    skipTo(r, end);
    if (end < r.src.length) skipPast(r, '>', end);
}

/** A start tag: the element joins its parent, and becomes the open element unless it has no content. */
function readElement(/** @type {Reader} */ r) {
    const tag = readStartTag(r.src, r.i);
    if (!tag) { note(r, 'template.tag_unclosed', 'A tag that never closes is left out, with everything after it.'); skipTo(r, r.src.length); return; }
    for (const problem of tag.problems) note(r, 'template.attribute_malformed', `<${tag.name}>: ${problem}.`);
    const line = r.line;
    skipTo(r, tag.end);
    const svg = top(r).svg || tag.name === 'svg';
    /** @type {ElementNode} */
    const el = { t: 'el', name: tag.name, svg, attrs: tag.attrs, children: [], line };
    top(r).children.push(el);
    if (RAW_TEXT_ELEMENTS.has(tag.name)) { skipRawText(r, tag, svg); return; }
    if (!svg && VOID_ELEMENTS.has(tag.name)) return;
    if (tag.selfClosing) {
        if (!svg) note(r, 'template.self_closing', `<${tag.name}/> is read as <${tag.name}></${tag.name}>: only an element inside <svg> closes itself.`, line);
        return;
    }
    if (r.stack.length >= HARD_DEPTH) { note(r, 'template.too_deep', `<${tag.name}> is nested too deep; its content is read as its parent's.`, line); return; }
    r.stack.push({ name: tag.name, svg, children: el.children, line });
}

/** Whatever starts with the `<` at the current place. */
function readMarkup(/** @type {Reader} */ r) {
    const next = r.src[r.i + 1];
    if (r.src.startsWith('<!--', r.i)) {
        note(r, 'template.comment', 'A comment is left out.');
        skipPast(r, '-->', r.i + 4);
    } else if (next === '!' || next === '?') {
        note(r, 'template.declaration', 'A doctype or declaration is left out.');
        skipPast(r, '>', r.i);
    } else if (next === '/') {
        readEndTag(r);
    } else if (next !== undefined && LETTERS.includes(next)) {
        readElement(r);
    } else {
        // A lone "<" is text.
        top(r).children.push({ t: 'text', value: '<', line: r.line });
        r.i += 1;
    }
}

/**
 * Read a template text.
 * @param {unknown} source
 * @returns {{ nodes: TemplateNode[], findings: BlockFinding[] }}
 */
export function parseTemplate(source) {
    /** @type {TemplateNode[]} */
    const nodes = [];
    if (typeof source !== 'string' || !source) return { nodes, findings: [] };
    /** @type {Reader} */
    const r = {
        src: source.split('\r\n').join('\n').split('\r').join('\n').split('\0').join(''),
        i: 0,
        line: 1,
        findings: [],
        stack: [{ name: '', svg: false, children: nodes, line: 1 }],
    };
    while (r.i < r.src.length) {
        const lt = nextTagStart(r.src, r.i);
        if (lt > r.i) {
            top(r).children.push({ t: 'text', value: decodeEntities(r.src.slice(r.i, lt)), line: r.line });
            skipTo(r, lt);
        } else {
            readMarkup(r);
        }
    }
    for (let k = r.stack.length - 1; k > 0; k--) note(r, 'template.unclosed', `<${r.stack[k].name}> is never closed.`, r.stack[k].line);
    return { nodes, findings: r.findings };
}
