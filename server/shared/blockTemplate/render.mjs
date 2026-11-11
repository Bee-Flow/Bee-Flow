// @typecheck strict
/**
 * Custom block: a sanitised template drawn for one viewer.
 *
 * The scope a formula sees is the block's resolved inputs by name, and inside a repeat the
 * item (under the name of its data-each, `item` by default) and `index`. Nothing else: no
 * variables, no viewer, no page.
 *
 *   {{ formula }} in a text       the value as TEXT (it is escaped when written; never markup)
 *   data-if="formula"             the element is drawn only when the formula is truthy
 *   data-each="formula as item"   the element is drawn once per entry of the list
 *   {{ formula }} in an attribute only where the vocabulary allows it; the drawn value is held
 *                                 to the attribute's rule again, and left out when it fails
 *   data-emit="event"             on a button or a link: the host gives the control a number
 *                                 and keeps (event, value) under it; the frame holds the number
 *
 * A formula that fails draws as nothing and is listed in `problems`.
 */

import { compile, evaluate, templateText } from '../expr/index.mjs';
import { BLOCK_LIMITS, attributeRule, cleanClasses, isSafeSvgValue } from './vocabulary.mjs';
import { parseEach, splitInterpolations } from './interpolation.mjs';

/** @typedef {import('./vocabulary.mjs').TemplateNode} TemplateNode */
/** @typedef {import('./vocabulary.mjs').ElementNode} ElementNode */
/** @typedef {{ event: string, value: unknown }} BlockEmit */
/**
 * @typedef {object} RenderInput
 * @property {Record<string, unknown>} scope        the resolved inputs, by name
 * @property {readonly string[]} [events]           the event names a control may raise here (wired, and the page lets actions run)
 * @property {number} [maxRepeat]
 * @property {number} [maxOutputNodes]
 */

const DIRECTIVES = new Set(['data-if', 'data-each', 'data-emit', 'data-value']);
const MAX_PROBLEMS = 20;

/**
 * One drawing in progress.
 * @typedef {{ emits: BlockEmit[], problems: string[], compiled: Map<string, unknown>, events: Set<string>, maxRepeat: number, maxOutput: number, drawn: number, full: boolean }} Drawing
 */
/** @typedef {Record<string, unknown>} Scope */

function problem(/** @type {Drawing} */ d, /** @type {string} */ message) {
    if (d.problems.length < MAX_PROBLEMS && !d.problems.includes(message)) d.problems.push(message);
}

const failure = (/** @type {string} */ expr, /** @type {unknown} */ e) => `{{ ${expr.slice(0, 80)} }}: ${e instanceof Error ? e.message : String(e)}`;

/** The value of a formula in a scope; undefined (and a problem) when it does not parse or fails. */
function valueOf(/** @type {Drawing} */ d, /** @type {string} */ expr, /** @type {Scope} */ scope) {
    if (!d.compiled.has(expr)) {
        try { d.compiled.set(expr, compile(expr).ast); } catch (e) { d.compiled.set(expr, null); problem(d, failure(expr, e)); }
    }
    const ast = d.compiled.get(expr);
    if (!ast) return undefined;
    try { return evaluate(/** @type {never} */ (ast), scope); } catch (e) { problem(d, failure(expr, e)); return undefined; }
}

/** A text with its formulas written out as text. */
function fill(/** @type {Drawing} */ d, /** @type {string} */ text, /** @type {Scope} */ scope) {
    if (!text.includes('{{')) return text;
    let out = '';
    for (const part of splitInterpolations(text)) out += 'text' in part ? part.text : templateText(valueOf(d, part.expr, scope));
    return out;
}

/** Is there room for one more drawn node? Says once that there is not. */
function room(/** @type {Drawing} */ d) {
    if (d.drawn >= d.maxOutput) {
        if (!d.full) problem(d, `A block draws at most ${d.maxOutput} elements and texts; the rest is left out.`);
        d.full = true;
        return false;
    }
    d.drawn += 1;
    return true;
}

/**
 * The drawn value of one attribute, held to its rule again; null when it is left out.
 * @param {Drawing} d
 * @param {ElementNode} el
 * @param {string} attr
 * @param {string} raw
 * @param {Scope} scope
 * @returns {string | null}
 */
function drawAttr(d, el, attr, raw, scope) {
    const rule = attributeRule(el.name, el.svg, attr);
    if (!rule) return null;
    if (rule.kind === 'classes') return cleanClasses(fill(d, raw, scope)) || null;
    if (rule.kind === 'text') return fill(d, raw, scope).slice(0, BLOCK_LIMITS.MAX_ATTR_CHARS);
    if (rule.kind !== 'svg') return raw;
    const drawn = fill(d, raw, scope);
    return isSafeSvgValue(drawn) ? drawn : null;
}

/**
 * What the host adds to a control: the button type, and for an event the page hands in, the
 * number under which the host keeps the event and its value.
 * @param {Drawing} d
 * @param {ElementNode} el
 * @param {Record<string, string>} own  the element's directives
 * @param {Scope} scope
 * @param {Array<[string, string]>} out
 */
function addControlAttrs(d, el, own, scope, out) {
    const control = el.name === 'button' || el.name === 'a';
    if (el.name === 'button') out.push(['type', 'button']);
    const event = own['data-emit'];
    if (!control || !event || !d.events.has(event)) return;
    d.emits.push({ event, value: own['data-value'] ? valueOf(d, own['data-value'], scope) : undefined });
    out.push(['data-bf-emit', String(d.emits.length - 1)]);
    if (el.name === 'a') { out.push(['role', 'button']); out.push(['tabindex', '0']); }
}

/**
 * The attributes of one drawn element.
 * @param {Drawing} d
 * @param {ElementNode} el
 * @param {Scope} scope
 * @returns {Array<[string, string]>}
 */
function drawAttrs(d, el, scope) {
    /** @type {Array<[string, string]>} */
    const out = [];
    /** @type {Record<string, string>} */
    const own = {};
    for (const [attr, raw] of el.attrs) {
        if (DIRECTIVES.has(attr)) { own[attr] = raw; continue; }
        const value = drawAttr(d, el, attr, raw, scope);
        if (value !== null) out.push([attr, value]);
    }
    addControlAttrs(d, el, own, scope, out);
    return out;
}

/**
 * @param {Drawing} d
 * @param {ElementNode} el
 * @param {Scope} scope
 * @param {TemplateNode[]} out
 */
function drawElement(d, el, scope, out) {
    const condition = el.attrs.find(([attr]) => attr === 'data-if');
    if (condition && !valueOf(d, condition[1], scope)) return;
    if (!room(d)) return;
    /** @type {ElementNode} */
    const copy = { t: 'el', name: el.name, svg: el.svg, attrs: drawAttrs(d, el, scope), children: [], line: el.line };
    out.push(copy);
    drawList(d, el.children, scope, copy.children);
}

/** An element with data-each: once per entry of its list. */
function drawRepeat(/** @type {Drawing} */ d, /** @type {ElementNode} */ el, /** @type {string} */ repeat, /** @type {Scope} */ scope, /** @type {TemplateNode[]} */ out) {
    const each = parseEach(repeat);
    const rows = each ? valueOf(d, each.expr, scope) : undefined;
    if (!each || !Array.isArray(rows)) return;
    if (rows.length > d.maxRepeat) problem(d, `A repeat draws at most ${d.maxRepeat} items; ${rows.length - d.maxRepeat} are left out.`);
    for (let i = 0; i < rows.length && i < d.maxRepeat && !d.full; i++) {
        drawElement(d, el, { ...scope, [each.name]: rows[i], index: i }, out);
    }
}

/**
 * @param {Drawing} d
 * @param {readonly TemplateNode[]} list
 * @param {Scope} scope
 * @param {TemplateNode[]} out
 */
function drawList(d, list, scope, out) {
    for (const node of list) {
        if (d.full) return;
        if (node.t === 'text') {
            const text = fill(d, node.value, scope);
            if (text && room(d)) out.push({ t: 'text', value: text, line: node.line });
            continue;
        }
        const repeat = node.attrs.find(([attr]) => attr === 'data-each');
        if (repeat) drawRepeat(d, node, repeat[1], scope, out);
        else drawElement(d, node, scope, out);
    }
}

/**
 * @param {readonly TemplateNode[]} nodes  a tree that went through sanitizeTree
 * @param {RenderInput} input
 * @returns {{ nodes: TemplateNode[], emits: BlockEmit[], problems: string[] }}
 */
export function renderBlock(nodes, input) {
    /** @type {Drawing} */
    const d = {
        emits: [],
        problems: [],
        compiled: new Map(),
        events: new Set(input.events || []),
        maxRepeat: input.maxRepeat ?? BLOCK_LIMITS.MAX_REPEAT,
        maxOutput: input.maxOutputNodes ?? BLOCK_LIMITS.MAX_OUTPUT_NODES,
        drawn: 0,
        full: false,
    };
    /** @type {TemplateNode[]} */
    const out = [];
    drawList(d, nodes, input.scope || {}, out);
    return { nodes: out, emits: d.emits, problems: d.problems };
}

/**
 * What a sanitised template asks of its declarations, without drawing it: the names its
 * formulas read at the top level (inputs), the events its controls raise, and each formula
 * that does not parse.
 * @param {readonly TemplateNode[]} nodes
 * @returns {{ refs: string[], events: string[], errors: Array<{ line: number, message: string }> }}
 */
export function inspectTemplate(nodes) {
    const refs = new Set();
    const events = new Set();
    /** @type {Array<{ line: number, message: string }>} */
    const errors = [];

    /** @param {string} expr @param {number} line @param {ReadonlySet<string>} locals */
    const read = (expr, line, locals) => {
        try {
            for (const ref of compile(expr).refs) if (!locals.has(ref)) refs.add(ref);
        } catch (e) {
            errors.push({ line, message: `{{ ${expr.slice(0, 80)} }}: ${e instanceof Error ? e.message : String(e)}` });
        }
    };
    /** @param {string} text @param {number} line @param {ReadonlySet<string>} locals */
    const readText = (text, line, locals) => {
        if (!text.includes('{{')) return;
        for (const part of splitInterpolations(text)) if ('expr' in part) read(part.expr, line, locals);
    };

    /** @param {readonly TemplateNode[]} list @param {ReadonlySet<string>} locals */
    const walk = (list, locals) => {
        for (const node of list) {
            if (node.t === 'text') { readText(node.value, node.line, locals); continue; }
            let inner = locals;
            const repeat = node.attrs.find(([attr]) => attr === 'data-each');
            if (repeat) {
                const each = parseEach(repeat[1]);
                if (each) { read(each.expr, node.line, locals); inner = new Set([...locals, each.name, 'index']); }
            }
            for (const [attr, raw] of node.attrs) {
                if (attr === 'data-each') continue;
                if (attr === 'data-if' || attr === 'data-value') read(raw, node.line, inner);
                else if (attr === 'data-emit') events.add(raw);
                else readText(raw, node.line, inner);
            }
            walk(node.children, inner);
        }
    };
    walk(nodes, new Set());
    return { refs: [...refs], events: [...events], errors };
}
