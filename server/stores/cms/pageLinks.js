// @typecheck noImplicitAny
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

/**
 * Copy of `node` where every link to `pageId` is replaced by an inert anchor
 * link, so the parent keeps its shape (a card stays a card). `stats.count`
 * counts the links replaced.
 *
 * @template T
 * @param {T} node
 * @param {string} pageId
 * @param {{ count: number }} stats
 * @returns {T}
 */
function neutralisePageLinks(node, pageId, stats) {
    if (Array.isArray(node)) {
        return /** @type {any} */ (node.map(n => neutralisePageLinks(n, pageId, stats)));
    }
    if (!isPlainObject(node)) return node;
    /** @type {Record<string, any>} */
    const rec = node;
    if (rec.kind === 'page' && rec.pageId === pageId) {
        stats.count++;
        return /** @type {any} */ ({ kind: 'anchor', anchor: '' });
    }
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = neutralisePageLinks(v, pageId, stats);
    return /** @type {any} */ (out);
}

module.exports = { annotatePageLinks, neutralisePageLinks };
