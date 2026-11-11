// @typecheck strict
/**
 * Custom block: the allow-list applied to a tree.
 *
 * Whatever read the template (the strict reader of parse.mjs at save, the browser's own inert
 * reader when the block is drawn), its tree goes through here and only vocabulary comes out:
 *   - an element that is not on the list for its place is left out WITH its content;
 *   - an attribute without a rule, or whose value does not fit its rule, is left out;
 * and each removal is a finding with the line it was written on (0 when the reader has none).
 *
 * A formula that does not parse is NOT removed here: it is the author's text, the validator
 * reports it and it draws as nothing.
 */

import {
    BLOCK_LIMITS, attributeRule, cleanClasses, isAllowedElement, isBlockName, isClassChars, isSafeInlineStyle,
    isSafeSvgValue, isSmallInt, isTokenValue,
} from './vocabulary.mjs';
import { splitInterpolations } from './interpolation.mjs';

/** @typedef {import('./vocabulary.mjs').TemplateNode} TemplateNode */
/** @typedef {import('./vocabulary.mjs').ElementNode} ElementNode */
/** @typedef {import('./vocabulary.mjs').BlockFinding} BlockFinding */
/** @typedef {import('./vocabulary.mjs').AttrRule} AttrRule */
/** @typedef {{ maxNodes?: number, maxDepth?: number }} SanitizeLimits */

const ADDRESS_ATTRS = new Set(['href', 'src', 'srcset', 'action', 'formaction', 'ping', 'poster', 'background', 'data', 'cite', 'xlink:href', 'srcdoc', 'manifest', 'usemap', 'longdesc']);

/** The literal pieces of a value that may hold formulas, joined (the formulas left out). */
function literalText(/** @type {string} */ value) {
    let out = '';
    for (const part of splitInterpolations(value)) if ('text' in part) out += part.text;
    return out;
}

const fitsAttr = (/** @type {string} */ value) => value.length <= BLOCK_LIMITS.MAX_ATTR_CHARS;

/** @param {string} value */
function cleanClassValue(value) {
    if (!fitsAttr(value)) return null;
    if (!value.includes('{{')) return cleanClasses(value) || null;
    // With a formula in it the literal part is class-name characters; the drawn value is held to the rule again.
    return isClassChars(literalText(value)) ? value : null;
}

/**
 * Per kind of rule: the value an attribute keeps, or null when it must go.
 * @type {Readonly<Record<string, (value: string, rule: AttrRule) => string | null>>}
 */
const VALUE_CLEANERS = Object.freeze({
    text: (value) => (fitsAttr(value) ? value : null),
    classes: cleanClassValue,
    token: (value, rule) => (rule.kind === 'token' && isTokenValue(rule, value) ? value : null),
    int: (value) => (isSmallInt(value) ? value : null),
    bool: () => '',
    style: (value) => (isSafeInlineStyle(value) && !value.includes('{{') ? value : null),
    formula: (value) => (value.trim() && value.length <= BLOCK_LIMITS.MAX_FORMULA_CHARS ? value : null),
    each: (value) => (value.trim() && value.length <= BLOCK_LIMITS.MAX_FORMULA_CHARS ? value : null),
    name: (value) => (isBlockName(value) ? value : null),
    svg: (value) => (value.length <= BLOCK_LIMITS.MAX_ATTR_CHARS * 10 && isSafeSvgValue(literalText(value)) ? value : null),
});

/**
 * The value an attribute keeps under its rule, or null when it must go.
 * @param {AttrRule} rule
 * @param {string} value
 * @returns {string | null}
 */
export function cleanAttrValue(rule, value) {
    return Object.hasOwn(VALUE_CLEANERS, rule.kind) ? VALUE_CLEANERS[rule.kind](value, rule) : null;
}

function refusedAttrMessage(/** @type {string} */ element, /** @type {string} */ attr) {
    if (attr.startsWith('on')) return `<${element}>: the attribute ${attr} is left out. A block runs no script; wire a button with data-emit to an action.`;
    if (ADDRESS_ATTRS.has(attr)) return `<${element}>: the attribute ${attr} is left out. A block names no address.`;
    return `<${element}>: the attribute ${attr} is not one a block may carry and is left out.`;
}

/** @typedef {{ findings: BlockFinding[], count: number, overflowed: boolean, maxNodes: number, maxDepth: number }} Pass */

/** @param {Pass} pass @param {number} line @param {string} code @param {string} message */
function note(pass, line, code, message) {
    pass.findings.push({ line, code, message });
}

/**
 * The attributes of `el` that have a rule and a value that fits it.
 * @param {Pass} pass
 * @param {ElementNode} el
 * @param {string} name
 * @param {boolean} svg
 * @returns {Array<[string, string]>}
 */
function cleanAttrs(pass, el, name, svg) {
    /** @type {Array<[string, string]>} */
    const attrs = [];
    const seen = new Set();
    for (const pair of Array.isArray(el.attrs) ? el.attrs : []) {
        const attr = String(pair[0]).toLowerCase();
        if (seen.has(attr)) continue;
        seen.add(attr);
        const rule = attributeRule(name, svg, attr);
        const value = rule ? cleanAttrValue(rule, String(pair[1] ?? '')) : null;
        if (!rule) note(pass, el.line || 0, 'template.attribute_refused', refusedAttrMessage(name, attr));
        else if (value === null) note(pass, el.line || 0, 'template.attribute_value', `<${name}>: the value of ${attr} is not one it may have and the attribute is left out.`);
        else attrs.push([attr, value]);
    }
    return attrs;
}

/**
 * One element, held to the lists; null when it is left out (with its content).
 * @param {Pass} pass
 * @param {ElementNode} node
 * @param {boolean} parentSvg
 * @param {number} depth
 * @returns {ElementNode | null}
 */
function cleanElement(pass, node, parentSvg, depth) {
    const name = node.name.toLowerCase();
    const line = node.line || 0;
    // The tree says which namespace the reader put the element in: it has to agree with its place.
    const placed = name === 'svg' ? !parentSvg && node.svg === true : node.svg === parentSvg;
    if (!placed || !isAllowedElement(name, parentSvg)) {
        note(pass, line, 'template.element_refused', `<${name.slice(0, 40)}> is not an element a block may hold${parentSvg ? ' inside <svg>' : ''}; it is left out with its content.`);
        return null;
    }
    if (depth >= pass.maxDepth) {
        note(pass, line, 'template.too_deep', `<${name}> is nested deeper than ${pass.maxDepth} levels and is left out.`);
        return null;
    }
    const svg = parentSvg || name === 'svg';
    pass.count += 1;
    /** @type {ElementNode} */
    const el = { t: 'el', name, svg, attrs: cleanAttrs(pass, node, name, svg), children: [], line };
    el.children = cleanList(pass, node.children, svg, depth + 1);
    return el;
}

/** Is there room for one more node? Says once that there is not. */
function hasRoom(/** @type {Pass} */ pass, /** @type {number} */ line) {
    if (pass.count < pass.maxNodes) return true;
    if (!pass.overflowed) note(pass, line, 'template.too_many_nodes', `A block holds at most ${pass.maxNodes} elements and texts; the rest is left out.`);
    pass.overflowed = true;
    return false;
}

/**
 * @param {Pass} pass
 * @param {readonly TemplateNode[]} list
 * @param {boolean} parentSvg
 * @param {number} depth
 * @returns {TemplateNode[]}
 */
function cleanList(pass, list, parentSvg, depth) {
    /** @type {TemplateNode[]} */
    const out = [];
    for (const node of Array.isArray(list) ? list : []) {
        if (!node || typeof node !== 'object') continue;
        if (!hasRoom(pass, node.line || 0)) break;
        if (node.t === 'text') {
            if (typeof node.value !== 'string' || !node.value) continue;
            pass.count += 1;
            out.push({ t: 'text', value: node.value, line: node.line || 0 });
        } else if (node.t === 'el' && typeof node.name === 'string') {
            const el = cleanElement(pass, node, parentSvg, depth);
            if (el) out.push(el);
        }
    }
    return out;
}

/**
 * @param {readonly TemplateNode[]} nodes
 * @param {SanitizeLimits} [limits]
 * @returns {{ nodes: TemplateNode[], findings: BlockFinding[] }}
 */
export function sanitizeTree(nodes, limits = {}) {
    /** @type {Pass} */
    const pass = { findings: [], count: 0, overflowed: false, maxNodes: limits.maxNodes ?? Infinity, maxDepth: limits.maxDepth ?? Infinity };
    return { nodes: cleanList(pass, nodes, false, 0), findings: pass.findings };
}
