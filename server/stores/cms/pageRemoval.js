// @typecheck
// Deleting a page: the PageDoc goes, and every reference to it is cleaned up
// (chrome links, links inside the other pages, site-level page titles).

const { isPlainObject } = require('./shared');
const { getPage, setPage, deletePage } = require('./pages');
const { collectLocaleOverrides, setSiteLocaleOverride, setPageLocaleOverride } = require('./localeOverrides');
const { neutralisePageLinks } = require('./pageLinks');
const { mutateProject } = require('./projects');

// Recursively walk a site-chrome subtree (header/footer) and strip any
// link references to the given pageId. The renderer's resolveLink already
// degrades broken page links gracefully ({ href: '#', broken: true }), but
// stored references also show up as ghost nav items in the editor, so we
// clean them at delete time.
//
// Two patterns are handled:
//   1. Array items keyed by `link` (nav items, ctas, footer column links):
//      drop the whole item when its link points at the deleted page.
//   2. Direct link objects on a parent property (e.g. logo.link): replace
//      with an inert anchor link so the parent's shape stays valid.
function stripPageRefsToDeleted(node, deletedPageId) {
    if (Array.isArray(node)) {
        return node
            .filter(item => !(isPlainObject(item)
                && isPlainObject(item.link)
                && item.link.kind === 'page'
                && item.link.pageId === deletedPageId))
            .map(item => stripPageRefsToDeleted(item, deletedPageId));
    }
    if (!isPlainObject(node)) return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
        if (isPlainObject(v) && v.kind === 'page' && v.pageId === deletedPageId) {
            out[k] = { kind: 'anchor', anchor: '' };
            continue;
        }
        out[k] = stripPageRefsToDeleted(v, deletedPageId);
    }
    return out;
}

class PageNotFound extends Error {}

/**
 * Delete a page. Links to it in the chrome are stripped, links to it inside
 * the other pages become inert anchors, and its entry in the site-level page
 * titles goes. Returns what happened, or null when the site has no such page.
 *
 * @param {string} siteId
 * @param {string} pageId
 * @returns {Promise<null | {
 *   removed: { id: string, slug: string },
 *   newHomepage: null | { id: string, slug: string },
 *   neutralisedLinks: number,
 * }>}
 */
async function removePage(siteId, pageId) {
    /** @type {{ id: string, slug: string }} */
    let removed;
    /** @type {null | { id: string, slug: string }} */
    let newHomepage = null;
    /** @type {string[]} */
    let remainingIds = [];
    try {
        await mutateProject(siteId, (site) => {
            const entry = site.pages.find(p => p.id === pageId);
            if (!entry) throw new PageNotFound();   // aborts the write
            removed = { id: entry.id, slug: entry.slug };
            site.pages = site.pages.filter(p => p.id !== pageId);
            if (site.homepageId === pageId) {
                site.homepageId = site.pages[0]?.id || null;
                if (site.pages[0]) newHomepage = { id: site.pages[0].id, slug: site.pages[0].slug };
            }
            if (isPlainObject(site.header)) site.header = stripPageRefsToDeleted(site.header, pageId);
            if (isPlainObject(site.footer)) site.footer = stripPageRefsToDeleted(site.footer, pageId);
            remainingIds = site.pages.map(p => p.id);
        });
    } catch (e) {
        if (e instanceof PageNotFound) return null;
        throw e;
    }
    await deletePage(siteId, pageId);

    const stats = { count: 0 };
    for (const id of remainingIds) {
        const doc = await getPage(siteId, id, { fresh: true });
        if (!doc) continue;
        const before = stats.count;
        const blocks = neutralisePageLinks(doc.blocks, pageId, stats);
        if (stats.count !== before) await setPage(siteId, { ...doc, blocks });
    }

    const { siteByLocale, pagesByLocale } = await collectLocaleOverrides(siteId, { fresh: true });
    for (const [locale, override] of Object.entries(siteByLocale)) {
        if (!isPlainObject(override)) continue;
        const before = stats.count;
        const next = { ...override };
        if (isPlainObject(override.header)) next.header = neutralisePageLinks(override.header, pageId, stats);
        if (isPlainObject(override.footer)) next.footer = neutralisePageLinks(override.footer, pageId, stats);
        const hadTitle = isPlainObject(override.pageTitles) && pageId in override.pageTitles;
        if (hadTitle) {
            const { [pageId]: _gone, ...pageTitles } = override.pageTitles;
            next.pageTitles = pageTitles;
        }
        if (hadTitle || stats.count !== before) await setSiteLocaleOverride(siteId, locale, next);
    }
    for (const [otherId, byLocale] of Object.entries(pagesByLocale)) {
        if (otherId === pageId) continue;
        for (const [locale, override] of Object.entries(byLocale)) {
            if (!isPlainObject(override) || !isPlainObject(override.blocks)) continue;
            const before = stats.count;
            const blocks = neutralisePageLinks(override.blocks, pageId, stats);
            if (stats.count !== before) await setPageLocaleOverride(siteId, otherId, locale, { ...override, blocks });
        }
    }
    return { removed, newHomepage, neutralisedLinks: stats.count };
}

module.exports = { removePage };
