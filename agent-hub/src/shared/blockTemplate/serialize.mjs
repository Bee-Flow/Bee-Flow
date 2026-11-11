// @typecheck strict
/**
 * Custom block: a tree written back as markup.
 *
 * One writer for both uses: the canonical template that is stored, and the body of the frame
 * a block is drawn in. Every text and every attribute value is escaped, so what a browser
 * reads back holds exactly the elements and attributes written here and nothing a value says.
 *
 * It is also the last gate. Whatever tree it is handed, it writes an element only when the
 * vocabulary knows it in that place, and an attribute only when the vocabulary has a rule
 * for it or it is one of the few the host adds itself (FRAME_ATTRS). A name that is not on
 * those lists is not written, whoever built the tree.
 */

import { VOID_ELEMENTS, attributeRule, isAllowedElement, isSmallInt } from './vocabulary.mjs';

/** @typedef {import('./vocabulary.mjs').TemplateNode} TemplateNode */

export function escapeText(/** @type {string} */ text) {
    return text.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');
}

export function escapeAttr(/** @type {string} */ text) {
    return escapeText(text).split('"').join('&quot;');
}

/**
 * Attributes only the host writes, on the drawn block: the number of a wired control, and
 * what makes a control a button. Each with the one form it may have.
 * @type {Readonly<Record<string, (element: string, value: string) => boolean>>}
 */
const FRAME_ATTRS = Object.freeze({
    'data-bf-emit': (element, value) => (element === 'button' || element === 'a') && isSmallInt(value),
    type: (element, value) => element === 'button' && value === 'button',
    tabindex: (element, value) => element === 'a' && value === '0',
});

/** @param {string} element @param {boolean} svg @param {string} attr @param {string} value @param {boolean} frame */
function mayWrite(element, svg, attr, value, frame) {
    if (frame && !svg && Object.hasOwn(FRAME_ATTRS, attr)) return FRAME_ATTRS[attr](element, value);
    return attributeRule(element, svg, attr) !== null;
}

/**
 * @param {readonly TemplateNode[]} nodes
 * @param {boolean} parentSvg
 * @param {boolean} frame
 * @param {string[]} out
 */
function write(nodes, parentSvg, frame, out) {
    for (const node of nodes) {
        if (node.t === 'text') { out.push(escapeText(node.value)); continue; }
        if (!isAllowedElement(node.name, parentSvg)) continue;
        const svg = parentSvg || node.name === 'svg';
        out.push(`<${node.name}`);
        for (const [attr, value] of node.attrs) {
            if (mayWrite(node.name, svg, attr, value, frame)) out.push(value === '' ? ` ${attr}` : ` ${attr}="${escapeAttr(value)}"`);
        }
        out.push('>');
        if (!svg && VOID_ELEMENTS.has(node.name)) continue;
        write(node.children, svg, frame, out);
        out.push(`</${node.name}>`);
    }
}

/** The stored form of a template: the tree as markup, nothing but vocabulary. */
export function serializeTemplate(/** @type {readonly TemplateNode[]} */ nodes) {
    /** @type {string[]} */
    const out = [];
    write(nodes, false, false, out);
    return out.join('');
}

/** The body of the frame a block is drawn in: as serializeTemplate, plus the host's own attributes. */
export function serializeFrameBody(/** @type {readonly TemplateNode[]} */ nodes) {
    /** @type {string[]} */
    const out = [];
    write(nodes, false, true, out);
    return out.join('');
}
