// @typecheck
// Internal page links (`{kind:'page', pageId}`) in a CMS content tree.

const { isPlainObject } = require('./shared');

/**
 * Copy of `node` where every page link also carries the target's `slug`.
 * Page ids are runtime ids that an import throws away; the slug is the
 * identity a bundle can carry. A link to an unknown page is left as is.
 *
 * @template T
 * @param {T} node
 * @param {Map<string, string>} slugByPageId
 * @returns {T}
 */
function annotatePageLinks(node, slugByPageId) {
    if (Array.isArray(node)) {
        return /** @type {any} */ (node.map(n => annotatePageLinks(n, slugByPageId)));
    }
    if (!isPlainObject(node)) return node;
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = annotatePageLinks(v, slugByPageId);
    if (out.kind === 'page' && typeof out.pageId === 'string' && slugByPageId.has(out.pageId)) {
        out.slug = slugByPageId.get(out.pageId);
    }
    return /** @type {any} */ (out);
}

module.exports = { annotatePageLinks };
