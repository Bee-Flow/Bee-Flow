// @typecheck strict
/**
 * Custom block: the tree of a document the browser's own inert reader built
 * (`new DOMParser().parseFromString(text, 'text/html')`: nothing in it runs or loads).
 *
 * Only elements and texts are taken; comments and everything else are left behind. The
 * namespace decides `svg`; an element of any other namespace gets a name no list holds.
 * The tree then goes through sanitizeTree like any other.
 */

/** @typedef {import('./vocabulary.mjs').TemplateNode} TemplateNode */
/** @typedef {{ nodeType: number, nodeValue?: string | null, localName?: string, namespaceURI?: string | null, attributes?: ArrayLike<{ name: string, value: string }>, childNodes: ArrayLike<DomNode> }} DomNode */

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_DOM_DEPTH = 600;

/**
 * @param {DomNode} parent  for a parsed document: its body
 * @param {number} [depth]
 * @returns {TemplateNode[]}
 */
export function domToTree(parent, depth = 0) {
    /** @type {TemplateNode[]} */
    const out = [];
    if (!parent || depth > MAX_DOM_DEPTH) return out;
    const children = parent.childNodes;
    for (let i = 0; i < children.length; i++) {
        const node = children[i];
        if (node.nodeType === 3) {
            if (node.nodeValue) out.push({ t: 'text', value: node.nodeValue, line: 0 });
        } else if (node.nodeType === 1) {
            const svg = node.namespaceURI === SVG_NS;
            const known = svg || node.namespaceURI === HTML_NS;
            /** @type {Array<[string, string]>} */
            const attrs = [];
            const list = node.attributes || [];
            for (let k = 0; k < list.length; k++) attrs.push([String(list[k].name).toLowerCase(), String(list[k].value)]);
            out.push({ t: 'el', name: `${known ? '' : 'other:'}${String(node.localName).toLowerCase()}`, svg, attrs, children: domToTree(node, depth + 1), line: 0 });
        }
    }
    return out;
}
