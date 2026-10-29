// @typecheck noImplicitAny
// Internal page links (`{kind:'page', pageId}`) in a CMS content tree.

const { isRecord } = require('./shared');

/**
 * Copy of `node` where every page link also carries the target's `slug`.
 * Page ids are runtime ids that an import throws away; the slug is the
 * identity a bundle can carry. A link to an unknown page is left as is.
 * The copy has the shape of `node` (a link only gains `slug`).
 *
 * @template T
 * @param {T} node
 * @param {Map<string, string>} slugByPageId
 * @returns {T}
 */
function annotatePageLinks(node, slugByPageId) {
    return /** @type {T} */ (annotateTree(node, slugByPageId));
}

/**
 * @param {unknown} node
 * @param {Map<string, string>} slugByPageId
 * @returns {unknown}
 */
function annotateTree(node, slugByPageId) {
    if (Array.isArray(node)) {
        return node.map(n => annotateTree(n, slugByPageId));
    }
    if (!isRecord(node)) return node;
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = annotateTree(v, slugByPageId);
    if (out.kind === 'page' && typeof out.pageId === 'string' && slugByPageId.has(out.pageId)) {
        out.slug = slugByPageId.get(out.pageId);
    }
    return out;
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
    return /** @type {T} */ (neutraliseTree(node, pageId, stats));
}

/**
 * @param {unknown} node
 * @param {string} pageId
 * @param {{ count: number }} stats
 * @returns {unknown}
 */
function neutraliseTree(node, pageId, stats) {
    if (Array.isArray(node)) {
        return node.map(n => neutraliseTree(n, pageId, stats));
    }
    if (!isRecord(node)) return node;
    if (node.kind === 'page' && node.pageId === pageId) {
        stats.count++;
        return { kind: 'anchor', anchor: '' };
    }
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = neutraliseTree(v, pageId, stats);
    return out;
}

module.exports = { annotatePageLinks, neutralisePageLinks };
