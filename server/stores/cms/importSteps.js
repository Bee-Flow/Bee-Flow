// @typecheck
// The phases of importSite (exportImport.js): validate the bundle, plan the
// pages, build the SiteDoc, write the pages, restore the locale overrides and
// the blog posts. Each phase takes what it reads and returns what it writes.

const { SITE_DEFAULTS } = require('../../i18n/defaults/cmsDefaults');
const {
    SITE_VERSION,
    newId, isPlainObject, clone, normalizeSlug,
    sanitizeDesign, sanitizeAnalytics, sanitizeBlogSettings,
} = require('./shared');
const { restorePosts, POST_LIMITS } = require('./posts');
const { ensureUniqueSlug } = require('./projects');
const { setPage } = require('./pages');
const { setSiteLocaleOverride, setPageLocaleOverride } = require('./localeOverrides');

// Structural caps on import payloads. Imports come from admin users, so
// the threat model isn't anonymous DoS — it's a compromised admin
// session pushing a deeply-nested or oversized payload that bloats the
// config table and the in-memory parse. Numbers are sized for "normal"
// marketing sites (a few dozen pages, a dozen blocks each); legitimate
// imports will never come close.
const IMPORT_MAX_PAGES        = 200;
const IMPORT_MAX_BLOCKS_PAGE  = 100;
// Locales carried by one bundle. The install's own language list is far
// smaller (4 seeded, 33 addable); this only has to stop a pathological
// payload from writing thousands of config rows.
const IMPORT_MAX_LOCALES      = 40;
const IMPORT_MAX_FIELD_BYTES  = 256 * 1024;  // 256 KB per stringified content/style blob
const IMPORT_MAX_POSTS        = POST_LIMITS.postsPerSite;

function approxByteSize(value) {
    try { return Buffer.byteLength(JSON.stringify(value) || '', 'utf8'); }
    catch (_) { return Infinity; }
}

/** Check the bundle's shape and caps; returns the `site` object and its posts. */
function validateImport(exportData, { marker, supportedVersions }) {
    if (!isPlainObject(exportData)) throw new Error('Invalid export payload');
    if (exportData[marker] !== true) throw new Error('Not a Bee Flow site export');
    // Back-compat ladder, not strict equality: a v1 bundle downloaded before
    // translations rode along must still import. v1 simply carries no
    // `locales` / `localeOverrides` keys, so the restore below is a no-op
    // for it and nothing else differs.
    if (!supportedVersions.includes(exportData.version)) {
        throw new Error(`Unsupported export version: ${exportData.version}`);
    }
    const incoming = exportData.site;
    if (!isPlainObject(incoming)) throw new Error('Export payload is missing the `site` object');

    // Cap pages and blocks before the loop below allocates them. Bytes-
    // per-field is checked inside the block loop so we can reject early
    // with a clear message instead of silently truncating.
    const pagesPreview = Array.isArray(incoming.pages) ? incoming.pages : [];
    if (pagesPreview.length > IMPORT_MAX_PAGES) {
        throw new Error(`Too many pages in import (max ${IMPORT_MAX_PAGES})`);
    }
    for (const p of pagesPreview) {
        if (!isPlainObject(p)) continue;
        const blocks = Array.isArray(p.blocks) ? p.blocks : [];
        if (blocks.length > IMPORT_MAX_BLOCKS_PAGE) {
            throw new Error(`Too many blocks on one page (max ${IMPORT_MAX_BLOCKS_PAGE})`);
        }
    }

    const postsPreview = Array.isArray(incoming.posts) ? incoming.posts : [];
    if (postsPreview.length > IMPORT_MAX_POSTS) {
        throw new Error(`Too many blog posts in import (max ${IMPORT_MAX_POSTS})`);
    }
    for (const p of postsPreview) {
        if (isPlainObject(p) && typeof p.body === 'string' && p.body.length > POST_LIMITS.body) {
            throw new Error(`A blog post body exceeds ${POST_LIMITS.body} characters`);
        }
        if (isPlainObject(p) && isPlainObject(p.locales) && Object.keys(p.locales).length > IMPORT_MAX_LOCALES) {
            throw new Error(`Too many locales in import (max ${IMPORT_MAX_LOCALES})`);
        }
    }
    return { incoming, postsPreview };
}

/**
 * Remap page ids: keep slug/title/order, generate fresh page ids. Track the
 * slug→new id mapping so page-kind link references can be rewritten.
 * pagesIn can contain junk entries that are skipped, so it is NOT
 * index-aligned with pagesOut. The aligned copy is what the page-write pass
 * and the locale restore need ("which bundle page produced this index
 * entry"); pairing them by position silently shifts content onto the wrong
 * page the moment one entry is malformed.
 */
function planPages(incoming) {
    const pagesIn = Array.isArray(incoming.pages) ? incoming.pages : [];
    const pagesOut = [];
    const pagesInAligned = [];
    // Page links in a bundle carry the target's slug (see exportSite), so
    // they are remapped by slug onto the freshly minted page ids.
    const slugToNewId = new Map();

    for (const incomingPage of pagesIn) {
        if (!isPlainObject(incomingPage)) continue;
        const pageId = newId('pg');
        const slug = normalizeSlug(incomingPage.slug || incomingPage.title || 'page') || 'page';
        const finalSlug = ensureUniqueSlug(slug, pagesOut, null);
        pagesOut.push({
            id: pageId,
            slug: finalSlug,
            title: typeof incomingPage.title === 'string' ? incomingPage.title : finalSlug,
            isHomepage: !!incomingPage.isHomepage,
            hideHeader: !!incomingPage.hideHeader,
            hideFooter: !!incomingPage.hideFooter,
            isNotFound: !!incomingPage.isNotFound,
            noAnalytics: !!incomingPage.noAnalytics,
        });
        pagesInAligned.push(incomingPage);
        slugToNewId.set(finalSlug, pageId);
        // Stash the original slug too, so chrome links written with the
        // original slug still remap even if the import normalised it.
        if (incomingPage.slug && incomingPage.slug !== finalSlug) {
            slugToNewId.set(String(incomingPage.slug), pageId);
        }
    }
    return { pagesOut, pagesInAligned, slugToNewId };
}

/**
 * A function that walks a node tree and re-points every `{kind:'page', ...}`
 * reference at the new page id. The export writes the target's `slug` next to
 * the (runtime) `pageId`, so the slug is the key; the slug is dropped again
 * once resolved. A link whose slug is missing or unknown is left as is (the
 * renderer shows it as broken) and counted in `stats.unresolved`, so the
 * import can report it.
 *
 * @param {Map<string, string>} slugToNewId
 * @param {{ unresolved: number }} [stats]
 */
function makePageLinkRemapper(slugToNewId, stats = { unresolved: 0 }) {
    const remapPageLinks = (node) => {
        if (Array.isArray(node)) return node.map(remapPageLinks);
        if (!isPlainObject(node)) return node;
        if (node.kind === 'page') {
            const { slug, ...rest } = node;
            if (typeof slug === 'string' && slugToNewId.has(slug)) {
                return { ...rest, pageId: slugToNewId.get(slug) };
            }
            stats.unresolved++;
            return { ...rest };
        }
        const out = {};
        for (const [k, v] of Object.entries(node)) out[k] = remapPageLinks(v);
        return out;
    };
    return remapPageLinks;
}

/** The new SiteDoc for the imported bundle. */
function buildSiteDoc({ incoming, incomingChrome, newSiteId, siteName, pagesOut, remapPageLinks }) {
    const homepageEntry = pagesOut.find(p => p.isHomepage) || pagesOut[0] || null;
    return {
        version: SITE_VERSION,
        id: newSiteId,
        name: siteName,
        homepageId: homepageEntry?.id || null,
        pages: pagesOut.map(p => ({
            ...p,
            isHomepage: !!(homepageEntry && p.id === homepageEntry.id),
        })),
        header: remapPageLinks(isPlainObject(incomingChrome.header) ? incomingChrome.header : clone(SITE_DEFAULTS.header)),
        footer: remapPageLinks(isPlainObject(incomingChrome.footer) ? incomingChrome.footer : clone(SITE_DEFAULTS.footer)),
        // No internal page-links inside the banner, so no remapPageLinks.
        cookieBanner: clone(isPlainObject(incomingChrome.cookieBanner) ? incomingChrome.cookieBanner : SITE_DEFAULTS.cookieBanner),
        announcement: clone(isPlainObject(incomingChrome.announcement) ? incomingChrome.announcement : SITE_DEFAULTS.announcement),
        design: sanitizeDesign(incoming.design),
        // Sanitized explicitly — this literal bypasses setProject.
        analytics: sanitizeAnalytics(incoming.analytics),
        blog: sanitizeBlogSettings(incoming.blog),
    };
}

/**
 * Write each PageDoc with a fresh page id and fresh block ids, remapping any
 * internal page links inside block content too. The old→new block id map
 * built here is what lets the locale overrides (keyed by block id) survive
 * the regeneration.
 */
async function writePages({ newSiteId, pagesOut, pagesInAligned, remapPageLinks }) {
    let droppedBlocks = 0;
    const blockIdMapByPageIndex = [];
    for (let i = 0; i < pagesOut.length; i++) {
        const incomingPage = pagesInAligned[i];
        const indexEntry = pagesOut[i];
        const blockIdMap = new Map();
        blockIdMapByPageIndex.push(blockIdMap);
        if (!incomingPage || !indexEntry) continue;
        const blocks = Array.isArray(incomingPage.blocks) ? incomingPage.blocks : [];
        const pageDoc = {
            id: indexEntry.id,
            slug: indexEntry.slug,
            title: indexEntry.title,
            seo: isPlainObject(incomingPage.seo) ? incomingPage.seo : {
                metaTitle: '', metaDescription: '', ogImage: '', noIndex: false,
            },
            blocks: blocks.map(b => {
                if (!isPlainObject(b)) return null;
                const content = isPlainObject(b.content) ? remapPageLinks(b.content) : {};
                const style   = isPlainObject(b.style)   ? b.style   : {};
                // Reject pathologically large blobs. A legit block is a
                // few KB; 256 KB is already 10× the largest real-world
                // sample we've seen, so this only catches abuse.
                if (approxByteSize(content) > IMPORT_MAX_FIELD_BYTES
                    || approxByteSize(style) > IMPORT_MAX_FIELD_BYTES) {
                    throw new Error('Block content exceeds size limit');
                }
                const freshId = newId('blk');
                if (typeof b.id === 'string' && b.id) blockIdMap.set(b.id, freshId);
                return {
                    id: freshId,
                    type: b.type,
                    enabled: b.enabled !== false,
                    content,
                    style,
                };
            }).filter(Boolean),
        };
        const { dropped } = await setPage(newSiteId, pageDoc);
        droppedBlocks += dropped.length;
    }
    return { droppedBlocks, blockIdMapByPageIndex };
}

/** The site-level override of one locale, re-keyed onto the new page ids; null when empty. */
function siteLocaleOverrideOut(override, slugToNewId, remapPageLinks) {
    const out = {};
    if (isPlainObject(override.header)) out.header = remapPageLinks(override.header);
    if (isPlainObject(override.footer)) out.footer = remapPageLinks(override.footer);
    // pageTitles arrives keyed by SLUG; storage wants the new page id.
    if (isPlainObject(override.pageTitles)) {
        const byId = {};
        for (const [slug, title] of Object.entries(override.pageTitles)) {
            const newPageId = slugToNewId.get(String(slug));
            if (newPageId && typeof title === 'string') byId[newPageId] = title;
        }
        if (Object.keys(byId).length) out.pageTitles = byId;
    }
    return out;
}

/** The page-level override of one locale, with block keys mapped old→new. */
function pageLocaleOverrideOut({ override, locale, blockIdMap, slug, warnings, remapPageLinks }) {
    const out = {};
    if (isPlainObject(override.blocks)) {
        const blocks = {};
        let unmapped = 0;
        for (const [oldBlockId, entry] of Object.entries(override.blocks)) {
            const newBlockId = blockIdMap.get(oldBlockId);
            if (!newBlockId) { unmapped++; continue; }
            blocks[newBlockId] = remapPageLinks(entry);
        }
        if (unmapped) {
            warnings.push(
                `${unmapped} ${locale} translation(s) on /${slug} referenced blocks that are not in this export`
            );
        }
        if (Object.keys(blocks).length) out.blocks = blocks;
    }
    if (isPlainObject(override.seo)) out.seo = override.seo;
    return out;
}

/**
 * Locale overrides (v2 bundles). Written last, once every page and block has
 * its final id. Entries pointing at blocks that setPage dropped (unknown
 * type) stay in the map harmlessly: resolveEffective looks overrides up FROM
 * the base blocks, so an orphan key is never read.
 */
async function restoreLocaleOverrides({
    newSiteId, incomingChrome, pagesOut, pagesInAligned, slugToNewId, blockIdMapByPageIndex, importedLocales, warnings, remapPageLinks,
}) {
    const chromeOverrides = isPlainObject(incomingChrome.localeOverrides)
        ? incomingChrome.localeOverrides : {};
    const pageLocalePairs = [];
    for (let i = 0; i < pagesOut.length; i++) {
        const src = pagesInAligned[i];
        if (!src || !isPlainObject(src.locales)) continue;
        for (const [locale, override] of Object.entries(src.locales)) {
            if (isPlainObject(override)) pageLocalePairs.push([i, locale, override]);
        }
    }
    const distinctLocales = new Set([
        ...Object.keys(chromeOverrides),
        ...pageLocalePairs.map(([, locale]) => locale),
    ]);
    if (distinctLocales.size > IMPORT_MAX_LOCALES) {
        throw new Error(`Too many locales in import (max ${IMPORT_MAX_LOCALES})`);
    }

    for (const [locale, override] of Object.entries(chromeOverrides)) {
        if (!isPlainObject(override)) continue;
        const out = siteLocaleOverrideOut(override, slugToNewId, remapPageLinks);
        if (!Object.keys(out).length) continue;
        if (approxByteSize(out) > IMPORT_MAX_FIELD_BYTES) {
            throw new Error('Locale override exceeds size limit');
        }
        await setSiteLocaleOverride(newSiteId, locale, out);
        importedLocales.add(locale);
    }

    for (const [pageIdx, locale, override] of pageLocalePairs) {
        const out = pageLocaleOverrideOut({
            override, locale, blockIdMap: blockIdMapByPageIndex[pageIdx], slug: pagesOut[pageIdx].slug, warnings, remapPageLinks,
        });
        if (!Object.keys(out).length) continue;
        if (approxByteSize(out) > IMPORT_MAX_FIELD_BYTES) {
            throw new Error('Locale override exceeds size limit');
        }
        await setPageLocaleOverride(newSiteId, pagesOut[pageIdx].id, locale, out);
        importedLocales.add(locale);
    }
}

/**
 * Blog posts: fresh ids; translations travel on each post and are keyed by
 * position (exports carry no post ids). restorePosts sanitizes every field.
 * Returns the number imported.
 */
async function restoreBlogPosts({ newSiteId, postsPreview, importedLocales, warnings }) {
    if (!postsPreview.length) return 0;
    const translations = {};
    postsPreview.forEach((p, i) => {
        if (isPlainObject(p) && isPlainObject(p.locales)) {
            translations[`#${i}`] = p.locales;
            for (const loc of Object.keys(p.locales)) importedLocales.add(loc);
        }
    });
    const restored = await restorePosts(newSiteId, postsPreview.map(p => (isPlainObject(p) ? { ...p, id: undefined } : p)), translations);
    if (restored.count < postsPreview.length) {
        warnings.push(`${postsPreview.length - restored.count} blog post(s) could not be imported`);
    }
    return restored.count;
}

module.exports = {
    validateImport, planPages, makePageLinkRemapper, buildSiteDoc, writePages,
    restoreLocaleOverrides, restoreBlogPosts,
};
