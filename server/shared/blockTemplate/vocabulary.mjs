// @typecheck strict
/**
 * Custom block (App Studio, schema 3): what a block's template may hold.
 *
 * A block is an HTML template and a stylesheet, no script. Everything here is a closed list:
 * an element or attribute that is not named is removed, at save (the server's canonicalizer)
 * and again when the block is drawn (the browser). There is no list of forbidden things.
 *
 * NEVER in a block, by construction: script, style, link, meta, base, iframe, object, embed,
 * form, input, template, any event-handler attribute, and any attribute that holds an address
 * (href, src, srcset, action, ping, poster, background, ...). There is no <img>: a picture
 * in a block is inline SVG, or a `data:image/…` background in its stylesheet.
 *
 * Shared by the server (canonicalize, validate) and the web runtime through the generated copy
 * in agent-hub/src/shared/blockTemplate/.
 */

/** @typedef {{ t: 'text', value: string, line: number }} TextNode */
/** @typedef {{ t: 'el', name: string, svg: boolean, attrs: Array<[string, string]>, children: TemplateNode[], line: number }} ElementNode */
/** @typedef {TextNode | ElementNode} TemplateNode */
/** @typedef {{ line: number, code: string, message: string }} BlockFinding */

/** Ceilings. The first three are checked at save (the server may override them from its environment). */
export const BLOCK_LIMITS = Object.freeze({
    MAX_TEMPLATE_CHARS: 60000,
    MAX_NODES: 3000,
    MAX_DEPTH: 32,
    /** Items one data-each draws; the rest is left out. */
    MAX_REPEAT: 1000,
    /** Elements and texts one block draws in all. */
    MAX_OUTPUT_NODES: 20000,
    MAX_CSS_CHARS: 20000,
    MAX_INPUTS: 20,
    MAX_EVENTS: 10,
    MAX_NAME_LEN: 40,
    MAX_ATTR_CHARS: 2000,
    MAX_FORMULA_CHARS: 2000,
});

/** The parser never nests deeper than this, whatever the limits say (it recurses). */
export const HARD_DEPTH = 200;

const set = (/** @type {string} */ words) => new Set(words.split(' '));

export const HTML_ELEMENTS = set(
    'div span p h1 h2 h3 h4 h5 h6 ul ol li dl dt dd table thead tbody tfoot tr th td caption '
    + 'strong em b i u s small sub sup mark code pre kbd blockquote q cite abbr time br hr wbr '
    + 'section article header footer main nav aside figure figcaption details summary button a svg',
);

/** Inside <svg>: shapes and text only. No use, image, foreignObject, script, style, animate*, set, filter, defs. */
export const SVG_ELEMENTS = set('g path circle ellipse rect line polyline polygon text tspan');

/** Elements without content or end tag. */
export const VOID_ELEMENTS = set('area base br col embed hr img input link meta source track wbr');

/** Elements whose content a browser does not read as markup: the parser skips to their end tag. */
export const RAW_TEXT_ELEMENTS = set('script style textarea title xmp iframe noembed noframes noscript plaintext');

/**
 * How an attribute value is read:
 *   text     any text; `{{ formula }}` allowed
 *   classes  class names; `{{ formula }}` allowed, the result is held to the same rule
 *   token    one of `values`, or a word of the characters of `chars`
 *   int      a whole number
 *   bool     present or not
 *   style    declarations, see isSafeInlineStyle
 *   formula  an expression (data-if, data-value)
 *   each     `formula as name` (data-each)
 *   name     a declared name (data-emit: an event)
 *   svg      a presentation value, see isSafeSvgValue; `{{ formula }}` allowed
 * @typedef {{ kind: 'text' | 'classes' | 'int' | 'bool' | 'style' | 'formula' | 'each' | 'name' | 'svg' } | { kind: 'token', values?: readonly string[], chars?: string }} AttrRule
 */

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();
const DIGITS = '0123456789';

/** @type {Readonly<Record<string, AttrRule>>} */
const GLOBAL_ATTRS = Object.freeze({
    class: { kind: 'classes' },
    title: { kind: 'text' },
    role: { kind: 'token', chars: LOWER },
    lang: { kind: 'token', chars: `${LOWER}${UPPER}${DIGITS}-` },
    dir: { kind: 'token', values: ['ltr', 'rtl', 'auto'] },
    hidden: { kind: 'bool' },
    style: { kind: 'style' },
    'data-state': { kind: 'text' },
    'data-if': { kind: 'formula' },
    'data-each': { kind: 'each' },
});

/** @type {Readonly<Record<string, Readonly<Record<string, AttrRule>>>>} */
const ELEMENT_ATTRS = Object.freeze({
    td: { colspan: { kind: 'int' }, rowspan: { kind: 'int' } },
    th: { colspan: { kind: 'int' }, rowspan: { kind: 'int' }, scope: { kind: 'token', values: ['row', 'col', 'rowgroup', 'colgroup'] } },
    ol: { start: { kind: 'int' }, reversed: { kind: 'bool' } },
    li: { value: { kind: 'int' } },
    time: { datetime: { kind: 'text' } },
    details: { open: { kind: 'bool' } },
    button: { disabled: { kind: 'bool' }, 'data-emit': { kind: 'name' }, 'data-value': { kind: 'formula' } },
    a: { 'data-emit': { kind: 'name' }, 'data-value': { kind: 'formula' } },
});

const SVG_PRESENTATION = set(
    'viewbox preserveaspectratio width height x y x1 y1 x2 y2 cx cy r rx ry dx dy d points transform '
    + 'fill stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset '
    + 'stroke-opacity fill-opacity fill-rule opacity text-anchor dominant-baseline font-size font-weight',
);

/** @type {Readonly<Record<string, AttrRule>>} */
const SVG_GLOBAL_ATTRS = Object.freeze({
    class: GLOBAL_ATTRS.class,
    role: GLOBAL_ATTRS.role,
    style: GLOBAL_ATTRS.style,
    'data-state': GLOBAL_ATTRS['data-state'],
    'data-if': GLOBAL_ATTRS['data-if'],
    'data-each': GLOBAL_ATTRS['data-each'],
});

/** @type {AttrRule} */
const TEXT_RULE = Object.freeze({ kind: 'text' });
/** @type {AttrRule} */
const SVG_RULE = Object.freeze({ kind: 'svg' });

/** `aria-` and then lower-case letters. */
function isAriaName(/** @type {string} */ name) {
    if (!name.startsWith('aria-') || name.length < 6 || name.length > 40) return false;
    for (let i = 5; i < name.length; i++) if (!LOWER.includes(name[i])) return false;
    return true;
}

/**
 * The rule for attribute `attr` on element `element` (both lower case), or null when the
 * attribute is not allowed there.
 * @param {string} element
 * @param {boolean} svg  the element is <svg> or inside one
 * @param {string} attr
 * @returns {AttrRule | null}
 */
export function attributeRule(element, svg, attr) {
    if (isAriaName(attr)) return TEXT_RULE;
    if (svg) {
        if (Object.hasOwn(SVG_GLOBAL_ATTRS, attr)) return SVG_GLOBAL_ATTRS[attr];
        return SVG_PRESENTATION.has(attr) ? SVG_RULE : null;
    }
    if (Object.hasOwn(GLOBAL_ATTRS, attr)) return GLOBAL_ATTRS[attr];
    const own = Object.hasOwn(ELEMENT_ATTRS, element) ? ELEMENT_ATTRS[element] : null;
    return own && Object.hasOwn(own, attr) ? own[attr] : null;
}

/** Is `name` an element a block may hold in this place? `svg` says the PARENT is <svg> or inside one. */
export function isAllowedElement(/** @type {string} */ name, /** @type {boolean} */ svg) {
    return svg ? SVG_ELEMENTS.has(name) : HTML_ELEMENTS.has(name);
}

const NAME_FIRST = `${LOWER}${UPPER}`;
const NAME_REST = `${NAME_FIRST}${DIGITS}_`;
/** Names a formula reads by itself inside a repeat: never an input. */
export const RESERVED_NAMES = Object.freeze(['item', 'index', 'it', 'acc', 'true', 'false', 'null']);

/** A name an input, an event or a repeat item can carry: a letter, then letters, digits or `_`. */
export function isBlockName(/** @type {unknown} */ value) {
    if (typeof value !== 'string' || !value || value.length > BLOCK_LIMITS.MAX_NAME_LEN || !NAME_FIRST.includes(value[0])) return false;
    for (const ch of value) if (!NAME_REST.includes(ch)) return false;
    return true;
}

const CLASS_REST = `${NAME_REST}-`;

/** One class name: a letter or `_`, then letters, digits, `_` or `-`. */
export function isClassToken(/** @type {string} */ token) {
    if (!token || token.length > 80 || !(NAME_FIRST.includes(token[0]) || token[0] === '_')) return false;
    for (const ch of token) if (!CLASS_REST.includes(ch)) return false;
    return true;
}

/** Is `text` made of class-name characters and blanks only (the literal part of a class value with a formula)? */
export function isClassChars(/** @type {string} */ text) {
    for (const ch of text) if (!CLASS_REST.includes(ch) && ch !== ' ' && ch !== '\n' && ch !== '\t') return false;
    return true;
}

/** The class names of `value` that are class names, in order, joined by one space. */
export function cleanClasses(/** @type {string} */ value) {
    return value.split(' ').join('\n').split('\t').join('\n').split('\n').filter(isClassToken).join(' ');
}

const SVG_VALUE_CHARS = `${LOWER}${UPPER}${DIGITS} .,#%()+-\n\t`;

/**
 * A presentation value of an SVG shape: numbers, keywords, a colour, a path, a transform.
 * It has no character an address needs (no `:`, `/`, quote or backslash) and never the word url.
 */
export function isSafeSvgValue(/** @type {string} */ value) {
    if (value.length > BLOCK_LIMITS.MAX_ATTR_CHARS * 10) return false;
    for (const ch of value) if (!SVG_VALUE_CHARS.includes(ch)) return false;
    return !value.toLowerCase().includes('url');
}

const STYLE_REFUSED_CHARS = '\\{}<>@"\'';
const STYLE_REFUSED_WORDS = ['url', 'image(', 'image-set', 'cross-fade', 'src(', 'expression', 'behavior', 'binding', 'javascript', '/*'];

/**
 * Declarations of a style attribute. Refused whole when they hold anything that can name an
 * address or leave the declaration list: a quote, a backslash, a brace, an at-sign, a comment,
 * url, image(), image-set(), cross-fade(), src(), expression.
 */
export function isSafeInlineStyle(/** @type {string} */ value) {
    if (value.length > BLOCK_LIMITS.MAX_ATTR_CHARS) return false;
    for (const ch of value) if (STYLE_REFUSED_CHARS.includes(ch) || ch.charCodeAt(0) < 0x20 && ch !== '\n' && ch !== '\t') return false;
    const lower = value.toLowerCase();
    return !STYLE_REFUSED_WORDS.some((word) => lower.includes(word));
}

/** A whole number of at most five digits. */
export function isSmallInt(/** @type {string} */ value) {
    if (!value || value.length > 5) return false;
    for (const ch of value) if (!DIGITS.includes(ch)) return false;
    return true;
}

/** Does a token value fit its rule? */
export function isTokenValue(/** @type {{ values?: readonly string[], chars?: string }} */ rule, /** @type {string} */ value) {
    if (rule.values) return rule.values.includes(value);
    if (!value || value.length > 40 || !rule.chars) return false;
    for (const ch of value) if (!rule.chars.includes(ch)) return false;
    return true;
}
