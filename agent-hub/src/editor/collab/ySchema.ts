/**
 * ySchema.ts — how a BeeEditor document is laid out inside a Yjs
 * `XmlFragment`, and which parts of a shared document are trusted.
 *
 * Layout (one Y type per AST node, so AST paths equal Y child indices):
 *   - the fragment itself is the `doc` node;
 *   - a container block is `XmlElement(<type>)`;
 *   - a textblock is `XmlElement('textblock', {type, …})` holding exactly one
 *     `XmlText`. The type lives in an attribute, so paragraph ↔ heading ↔ code
 *     is an attribute change that keeps a co-editor's concurrent typing;
 *   - text is characters of that `XmlText`; marks are format attributes
 *     (`bold: true`, `link: {href}`, `highlight: {color} | true`, …);
 *   - an inline atom (hard break, inline math, formula, inline image) is an
 *     `XmlElement` embedded in the text, one index long — exactly one token;
 *   - an atom block is an attribute-only `XmlElement(<type>)`.
 *
 * Attributes are stored in canonical form: whitelisted per type, sanitised,
 * and without values equal to the schema default. Transient display values
 * (a formula's computed `value` / `error`) are never stored.
 *
 * Everything read from a shared document is untrusted: it was written by
 * another browser, not by our own parsers. The SAME whitelist and sanitisers
 * run on the way in and on the way out, so a hostile value can never reach
 * the editor, and a value we wrote always reads back unchanged. The URL and
 * CSS guards are the serializers' own (serialization/util.js), so the shared
 * document gives exactly the guarantees the HTML export already gives.
 */
import { MARK_SCHEMA, markOrder } from '../model/schema.js';
import { mark as makeMark } from '../model/marks.js';
import { safeUrl, safeCssColor, safeCssFont, safeAlign, safeTarget, safeRel } from '../serialization/util.js';

/** Name of the shared type that holds a document's body (`ydoc.getXmlFragment(FRAGMENT_NAME)`). */
export const FRAGMENT_NAME = 'content';
/** Element name of every textblock; the AST type is its `type` attribute. */
export const TEXTBLOCK = 'textblock';
/** Deepest element nesting that is read or written; anything deeper is ignored. */
export const MAX_DEPTH = 48;

export interface AstMark {
    type: string;
    attrs?: Record<string, unknown>;
}

export interface AstNode {
    type: string;
    attrs?: Record<string, unknown>;
    content?: AstNode[];
    marks?: AstMark[];
    text?: string;
}

export type Attrs = Record<string, unknown>;

export const TEXTBLOCK_TYPES: ReadonlySet<string> = new Set(['paragraph', 'heading', 'codeBlock']);
export const CONTAINER_TYPES: ReadonlySet<string> = new Set([
    'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'blockquote', 'table', 'tableRow', 'tableCell',
]);
export const BLOCK_ATOMS: ReadonlySet<string> = new Set(['horizontalRule', 'image', 'mermaid', 'mathBlock', 'chart']);
export const INLINE_ATOMS: ReadonlySet<string> = new Set(['hardBreak', 'mathInline', 'formula', 'image']);

/** Blocks that may sit wherever block content is allowed. */
const FLOW_BLOCKS: ReadonlySet<string> = new Set([
    ...TEXTBLOCK_TYPES, ...BLOCK_ATOMS, 'bulletList', 'orderedList', 'taskList', 'blockquote', 'table',
]);
/** Containers whose children hold block content. */
const FLOW_PARENTS: ReadonlySet<string> = new Set(['doc', 'blockquote', 'listItem', 'taskItem', 'tableCell']);
/** Containers with exactly one allowed child type. */
const ONLY_CHILD: Readonly<Record<string, string>> = {
    bulletList: 'listItem', orderedList: 'listItem', taskList: 'taskItem', table: 'tableRow', tableRow: 'tableCell',
};

/** May a `child` block sit directly inside a `parent` node? */
export function allowedChild(parentType: string, childType: string): boolean {
    const only = ONLY_CHILD[parentType];
    if (only) return childType === only;
    return FLOW_PARENTS.has(parentType) && FLOW_BLOCKS.has(childType);
}

export const isTextblockType = (t: string): boolean => TEXTBLOCK_TYPES.has(t);
export const isBlockAtomType = (t: string): boolean => BLOCK_ATOMS.has(t);
export const isContainerType = (t: string): boolean => CONTAINER_TYPES.has(t);

/** The Y element name for an AST block type. */
export function elementNameFor(type: string): string {
    return TEXTBLOCK_TYPES.has(type) ? TEXTBLOCK : type;
}

/**
 * The AST type an element stands for, or null when it is not part of the
 * schema (ignored everywhere). A textblock with an unknown `type` reads as a
 * paragraph: its text is kept, the bogus type is not.
 */
export function astTypeOfElement(nodeName: string, typeAttr: unknown): string | null {
    if (nodeName === TEXTBLOCK) return typeof typeAttr === 'string' && TEXTBLOCK_TYPES.has(typeAttr) ? typeAttr : 'paragraph';
    if (CONTAINER_TYPES.has(nodeName) || BLOCK_ATOMS.has(nodeName)) return nodeName;
    return null;
}

/* ── attribute whitelist ─────────────────────────────────────────────── */

/** Returns the canonical value, or undefined for "absent / schema default". */
type AttrRule = (v: unknown) => unknown;

const MAX_TEXT_ATTR = 1_000_000;
const MAX_SHORT_ATTR = 2_000;

const text = (max: number): AttrRule => (v) => (typeof v === 'string' && v !== '' && v.length <= max ? v : undefined);
const onlyTrue: AttrRule = (v) => (v === true ? true : undefined);
const onlyFalse: AttrRule = (v) => (v === false ? false : undefined);
const intIn = (min: number, max: number, dflt: number | null): AttrRule => (v) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < min || n > max || n === dflt) return undefined;
    return n;
};
const align: AttrRule = (v) => safeAlign(v) || undefined;
const imageAlign: AttrRule = (v) => {
    const a = safeAlign(v);
    return a && a !== 'center' && a !== 'justify' ? a : undefined;
};
const language: AttrRule = (v) => (typeof v === 'string' && /^[A-Za-z0-9_+#.-]{1,64}$/.test(v) ? v : undefined);
const url: AttrRule = (v) => (typeof v === 'string' ? safeUrl(v) || undefined : undefined);

const ATTR_RULES: Readonly<Record<string, Readonly<Record<string, AttrRule>>>> = {
    paragraph: { align },
    heading: { level: intIn(1, 6, 1), align },
    codeBlock: { language },
    bulletList: { tight: onlyFalse },
    orderedList: { start: intIn(0, 1_000_000_000, 1), tight: onlyFalse },
    listItem: {},
    taskList: {},
    taskItem: { checked: onlyTrue },
    blockquote: {},
    table: {},
    tableRow: {},
    tableCell: {
        header: onlyTrue, align, colspan: intIn(1, 1000, 1), rowspan: intIn(1, 1000, 1), colwidth: intIn(1, 100_000, null),
    },
    horizontalRule: {},
    image: {
        src: url, alt: text(MAX_SHORT_ATTR), title: text(MAX_SHORT_ATTR), width: intIn(1, 100_000, null),
        alignment: imageAlign, textWrap: onlyTrue,
    },
    mermaid: { code: text(MAX_TEXT_ATTR) },
    mathBlock: { latex: text(MAX_TEXT_ATTR) },
    chart: { spec: text(MAX_TEXT_ATTR) },
    hardBreak: {},
    mathInline: { latex: text(MAX_TEXT_ATTR) },
    // value / error are recomputed after every change (normalizeLight): never stored.
    formula: { src: text(MAX_SHORT_ATTR * 5) },
};

/** The keys a type may carry (excluding the textblock `type` attribute). */
export function attrKeys(type: string): string[] {
    return Object.keys(ATTR_RULES[type] || {});
}

/**
 * Canonical attributes of a node: whitelisted, sanitised, defaults omitted.
 * Used for writing, for reading back, and for comparing the two — one
 * function, so what we write always reads back as itself.
 */
export function canonicalAttrs(type: string, attrs: unknown): Attrs {
    const rules = ATTR_RULES[type];
    const out: Attrs = {};
    if (!rules || !attrs || typeof attrs !== 'object') return out;
    const src = attrs as Attrs;
    for (const key of Object.keys(rules)) {
        if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
        const v = rules[key](src[key]);
        if (v !== undefined) out[key] = v;
    }
    return out;
}

/** The attribute object of a Y element for a node (textblocks add `type`). */
export function elementAttrsFor(node: AstNode): Attrs {
    const attrs = canonicalAttrs(node.type, node.attrs);
    return TEXTBLOCK_TYPES.has(node.type) ? { type: node.type, ...attrs } : attrs;
}

/* ── marks ↔ format attributes ───────────────────────────────────────── */

const FLAG_MARKS: ReadonlySet<string> = new Set(['bold', 'italic', 'underline', 'strike', 'code']);
/** Every format key this schema understands; other keys in a shared text are ignored. */
export const FORMAT_KEYS: readonly string[] = Object.keys(MARK_SCHEMA);

function linkValue(attrs: unknown): Attrs | undefined {
    const a = (attrs && typeof attrs === 'object' ? attrs : {}) as Attrs;
    const href = typeof a.href === 'string' ? safeUrl(a.href) : '';
    if (!href) return undefined;
    const d = MARK_SCHEMA.link.defaults as Attrs;
    const out: Attrs = { href };
    const target = safeTarget(a.target ?? d.target);
    if (target && target !== d.target) out.target = target;
    const rel = safeRel(a.rel ?? d.rel);
    if (rel && rel !== d.rel) out.rel = rel;
    return out;
}

function highlightValue(attrs: unknown): Attrs | true {
    const color = attrs && typeof attrs === 'object' ? safeCssColor((attrs as Attrs).color) : '';
    return color ? { color } : true;
}

function textStyleValue(attrs: unknown): Attrs | undefined {
    if (!attrs || typeof attrs !== 'object') return undefined;
    const color = safeCssColor((attrs as Attrs).color);
    const fontFamily = safeCssFont((attrs as Attrs).fontFamily);
    if (!color && !fontFamily) return undefined;
    const out: Attrs = {};
    if (color) out.color = color;
    if (fontFamily) out.fontFamily = fontFamily;
    return out;
}

/** One mark's format value, or undefined when the mark carries nothing valid. */
function formatValue(type: string, attrs: unknown): unknown {
    if (FLAG_MARKS.has(type)) return true;
    if (type === 'link') return linkValue(attrs);
    if (type === 'highlight') return highlightValue(attrs);
    if (type === 'textStyle') return textStyleValue(attrs);
    return undefined;
}

/** Apply `code`'s exclusions: code text carries no other formatting. */
function withExclusions(fmt: Attrs): Attrs {
    return fmt.code === true ? { code: true } : fmt;
}

/** Format attributes for a run's marks (empty inside code blocks). */
export function marksToFormat(marks: AstMark[] | undefined, inCode: boolean): Attrs {
    const out: Attrs = {};
    if (inCode || !marks) return out;
    for (const m of marks) {
        if (!m || !Object.prototype.hasOwnProperty.call(MARK_SCHEMA, m.type)) continue;
        const v = formatValue(m.type, m.attrs);
        if (v !== undefined) out[m.type] = v;
    }
    return withExclusions(out);
}

/** Canonical form of format attributes read from a shared text. */
export function canonicalFormat(raw: unknown, inCode: boolean): Attrs {
    const out: Attrs = {};
    if (inCode || !raw || typeof raw !== 'object') return out;
    const src = raw as Attrs;
    for (const key of FORMAT_KEYS) {
        const v = src[key];
        if (v === undefined || v === null || v === false) continue;
        const value = FLAG_MARKS.has(key) ? true : formatValue(key, v === true ? {} : v);
        if (value !== undefined) out[key] = value;
    }
    return withExclusions(out);
}

/** AST marks for canonical format attributes, in serialization order. */
export function formatToMarks(fmt: Attrs): AstMark[] {
    const out: AstMark[] = [];
    for (const key of Object.keys(fmt)) {
        const v = fmt[key];
        out.push(v === true ? makeMark(key) : makeMark(key, v as Attrs));
    }
    return out.sort((a, b) => markOrder(a.type) - markOrder(b.type));
}

/** A stable string for canonical attributes / formats, for cheap equality. */
export function attrsKey(attrs: Attrs): string {
    const keys = Object.keys(attrs);
    if (keys.length === 0) return '';
    keys.sort();
    let s = '';
    for (const k of keys) {
        const v = attrs[k];
        s += `${k}=${v === true ? '1' : stableJson(v)};`;
    }
    return s;
}

function stableJson(v: unknown): string {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
    const o = v as Attrs;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
}

/** Format attributes for a Y `format()` call: the target values, null for everything else we know. */
export function formatPatch(target: Attrs, current: Attrs): Attrs {
    const patch: Attrs = { ...target };
    for (const key of FORMAT_KEYS) {
        if (!(key in target) && current[key] !== undefined && current[key] !== null) patch[key] = null;
    }
    return patch;
}
