// @typecheck
// Site export / import — the full-website bundle: SiteDoc, every PageDoc and
// every translation in one JSON payload, plus the asset-key walk the download
// route uses to gather the media that rides along with it.

const configStore = require('../configStore');
const { SITE_DEFAULTS } = require('../../i18n/defaults/cmsDefaults');
const {
    SITE_VERSION,
    newId, isPlainObject, clone, normalizeSlug,
    sanitizeDesign, sanitizeAnalytics, projectKey,
} = require('./shared');
const { getProject, ensureUniqueSlug, mutateProjectsIndex } = require('./projects');
const { getPage, setPage } = require('./pages');
const {
    getDefaultLocale, collectLocaleOverrides,
    setSiteLocaleOverride, setPageLocaleOverride,
} = require('./localeOverrides');

// ── Export / Import ──────────────────────────────────────────────────
//
// Export bundles the entire SiteDoc + every PageDoc (with blocks) + every
// locale override into a single JSON payload. Version 1 deliberately left
// the translations out ("presentation state, recompute on the destination")
// — which meant a site moved between installs silently arrived
// English-only. Version 2 carries them, so an export is a genuine backup.
//
// The published snapshot is still excluded: it is derived state that
// `publishSite()` rebuilds from the draft in one call.
//
// Import generates fresh IDs for the site, every page, and every block,
// so a re-import never collides with an existing site or any future
// site that happens to share an old id. Header / footer link references
// of `kind: 'page'` are remapped to the new page IDs so the imported
// nav still points at the new pages, not the originals.
//
// ── Identity across the id regeneration ──
// Locale overrides are keyed by runtime ids, which import throws away, so
// the bundle re-keys them onto identifiers it actually carries:
//   • site override `pageTitles` — keyed by pageId in storage, exported
//     keyed by SLUG (the only stable page identity a bundle has; v1
//     already leans on slugs for link remapping).
//   • page override `blocks`     — keyed by block id, and the bundle
//     already ships every block's `id` inside `blocks[]`, so import maps
//     old→new while it rewrites the page and remaps the override through it.
// Get either wrong and the import looks fine but every translated page
// silently renders in the source language — hence cmsStore.export.test.js.

const EXPORT_MARKER  = '_beeflow_export';
const EXPORT_VERSION = 2;
// Bundles this import path understands. 1 = pre-2026-07 (no locales, no
// assets); anything older than the newest is upgraded in-place below.
const EXPORT_SUPPORTED_VERSIONS = [1, 2];

/**
 * Walk a finished bundle and return every CMS asset key it references.
 *
 * Deliberately operates on the BUNDLE rather than the store, so it needs no
 * knowledge of which fields hold media — design.logo/favicon, seo.ogImage,
 * media.src/srcDark, style.backgroundImage, logos[].src, items[].logoSrc,
 * avatarSrc and anything added later are all just strings in the tree.
 * Accepts both storage forms: the bare `cms/…` key and the rendered
 * `/api/cms/asset/cms/…` URL (assetUrl.js maps one to the other).
 */
const ASSET_URL_PREFIX = '/api/cms/asset/';
function collectAssetKeys(node, out = new Set()) {
    if (typeof node === 'string') {
        let s = node;
        if (s.startsWith(ASSET_URL_PREFIX)) s = s.substring(ASSET_URL_PREFIX.length);
        if (s.startsWith('cms/') && !s.includes('..')) {
            // Stored URLs are percent-encoded segment-by-segment by
            // resolveAssetUrl; storage keys are raw.
            try { out.add(decodeURIComponent(s)); } catch (_) { out.add(s); }
        }
        return out;
    }
    if (Array.isArray(node)) {
        for (const v of node) collectAssetKeys(v, out);
        return out;
    }
    if (isPlainObject(node)) {
        for (const v of Object.values(node)) collectAssetKeys(v, out);
    }
    return out;
}

async function exportSite(siteId) {
    const site = await getProject(siteId);
    if (!site) throw new Error('Site not found');

    const defaultLocale = await getDefaultLocale();
    const { siteByLocale, pagesByLocale } = await collectLocaleOverrides(siteId);
    const localesSeen = new Set();

    // pageId → slug, for re-keying the site override's pageTitles map.
    const slugByPageId = new Map();
    for (const entry of site.pages || []) {
        if (entry && entry.id) slugByPageId.set(entry.id, entry.slug);
    }

    // Pull every PageDoc by id (the site.pages array is just the index;
    // the actual block content lives in cms_project_{site}_page_{id}).
    // We carry both the index metadata (slug/title/isHomepage/hideHeader…)
    // AND the full PageDoc (seo + blocks) for each page so an import can
    // restore the page exactly. The exported page item is the union of
    // both shapes — duplicate fields like slug/title resolve to the
    // index entry's values (authoritative source).
    const exportedPages = [];
    for (const entry of site.pages || []) {
        const doc = await getPage(siteId, entry.id) || {};

        // Page-locale overrides ride along keyed by BLOCK ID, which the
        // exported blocks[] carries verbatim. `version` is dropped — the
        // bundle's own version governs, and setPageLocaleOverride re-stamps.
        const locales = {};
        for (const [locale, override] of Object.entries(pagesByLocale[entry.id] || {})) {
            if (!isPlainObject(override)) continue;
            const out = {};
            if (isPlainObject(override.blocks)) out.blocks = override.blocks;
            if (isPlainObject(override.seo)) out.seo = override.seo;
            if (!Object.keys(out).length) continue;
            locales[locale] = out;
            localesSeen.add(locale);
        }

        exportedPages.push({
            // Index-side fields:
            slug: entry.slug,
            title: entry.title,
            isHomepage: !!entry.isHomepage,
            hideHeader: !!entry.hideHeader,
            hideFooter: !!entry.hideFooter,
            isNotFound: !!entry.isNotFound,
            noAnalytics: !!entry.noAnalytics,
            // PageDoc-side fields:
            seo: doc.seo || { metaTitle: '', metaDescription: '', ogImage: '', noIndex: false },
            blocks: Array.isArray(doc.blocks) ? doc.blocks : [],
            ...(Object.keys(locales).length ? { locales } : {}),
        });
    }

    // Site-level chrome overrides. pageTitles is stored keyed by pageId;
    // re-key onto slugs so it survives the id regeneration on import.
    const chromeLocaleOverrides = {};
    for (const [locale, override] of Object.entries(siteByLocale)) {
        if (!isPlainObject(override)) continue;
        const out = {};
        if (isPlainObject(override.header)) out.header = override.header;
        if (isPlainObject(override.footer)) out.footer = override.footer;
        if (isPlainObject(override.pageTitles)) {
            const bySlug = {};
            for (const [pageId, title] of Object.entries(override.pageTitles)) {
                const slug = slugByPageId.get(pageId);
                if (slug) bySlug[slug] = title;
            }
            if (Object.keys(bySlug).length) out.pageTitles = bySlug;
        }
        if (!Object.keys(out).length) continue;
        chromeLocaleOverrides[locale] = out;
        localesSeen.add(locale);
    }

    return {
        [EXPORT_MARKER]: true,
        version: EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        site: {
            name: site.name,
            // The source language the base content is written in. Without
            // it the overrides below are ambiguous — you cannot tell which
            // locale the untranslated content already is.
            defaultLocale,
            // Source locale first, then every locale that carries data.
            locales: [defaultLocale, ...[...localesSeen].filter(l => l !== defaultLocale).sort()],
            // Settings = site-level toggles other than nav chrome / design,
            // surfaced under a single key for import-side clarity. Today
            // there's only `homepageSlug` (derived from the homepage page
            // index entry) — future flags can land here without breaking
            // import-compatibility.
            settings: {
                homepageSlug: (site.pages || []).find(p => p.isHomepage)?.slug || null,
            },
            design: site.design || {},
            // Site exports are first and foremost backups of the owner's own
            // site — the GA measurement id rides along so a restore is
            // complete. (Anyone sharing an export cross-org should clear it.)
            analytics: sanitizeAnalytics(site.analytics),
            chrome: {
                header: site.header || {},
                footer: site.footer || {},
                cookieBanner: site.cookieBanner || {},
                announcement: site.announcement || {},
                ...(Object.keys(chromeLocaleOverrides).length
                    ? { localeOverrides: chromeLocaleOverrides }
                    : {}),
            },
            pages: exportedPages,
        },
    };
}

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

function approxByteSize(value) {
    try { return Buffer.byteLength(JSON.stringify(value) || '', 'utf8'); }
    catch (_) { return Infinity; }
}

async function importSite(exportData) {
    if (!isPlainObject(exportData)) throw new Error('Invalid export payload');
    if (exportData[EXPORT_MARKER] !== true) throw new Error('Not a Bee Flow site export');
    // Back-compat ladder, not strict equality: a v1 bundle downloaded before
    // translations rode along must still import. v1 simply carries no
    // `locales` / `localeOverrides` keys, so the restore below is a no-op
    // for it and nothing else differs.
    if (!EXPORT_SUPPORTED_VERSIONS.includes(exportData.version)) {
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

    // Fresh site id + a name suffix so the user can tell originals apart
    // from imports at a glance. The suffix is plain; users rename via
    // the Site Switcher right after import if they want.
    const newSiteId = newId('pj');
    const now = new Date().toISOString();
    const siteName = (typeof incoming.name === 'string' && incoming.name.trim())
        ? `${incoming.name} (imported)`
        : 'Imported site';

    // Remap page ids: keep slug/title/order, generate fresh page ids and
    // fresh block ids. Track old→new id mapping so we can rewrite any
    // page-kind link references that pointed at the OLD page ids inside
    // header/footer chrome and inside block content of every page.
    const pagesIn = Array.isArray(incoming.pages) ? incoming.pages : [];
    const pagesOut = [];
    // pagesIn can contain junk entries that the loop below skips, so it is
    // NOT index-aligned with pagesOut. Keep an aligned copy — the page-write
    // pass and the locale restore both need "which bundle page produced this
    // index entry", and pairing them by position silently shifts content
    // onto the wrong page the moment one entry is malformed.
    const pagesInAligned = [];
    const idMap = new Map();   // oldId → newId (oldId is the slug since exports don't carry the original page id)
    // We use slug as the lookup key because exports don't carry the
    // ORIGINAL page id — by design, they shouldn't leak runtime ids.
    // Internal link references (`{kind:'page', pageId: <oldId>}`) point
    // at the OLD ids; we don't have those, so we *also* support
    // `{kind:'page', slug: <slug>}` style remapping during import. If
    // the chrome / block content uses oldId only and the original
    // pageId isn't reachable, links resolve to '#' at render time
    // (graceful degradation; we never crash). To preserve perfect
    // fidelity, callers who depend on chrome page links should ensure
    // the export tool carries page ids alongside link references — for
    // now we remap by slug when available, leave old ids otherwise so
    // the renderer's fallback (`broken: true`) surfaces them clearly.
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
        idMap.set(finalSlug, pageId);
    }

    // Walk a node tree and replace any `{kind:'page', pageId:'<old>'}`
    // references with the new id where we can resolve the target by
    // slug. This is a best-effort remap — if the old export carried no
    // slug hint and the old id is unknown, the link is left untouched
    // and the renderer will display it as broken until the user fixes
    // it manually.
    const remapPageLinks = (node) => {
        if (Array.isArray(node)) return node.map(remapPageLinks);
        if (!isPlainObject(node)) return node;
        if (node.kind === 'page') {
            // Prefer a slug hint if the export carried one alongside the
            // pageId. Fall through to no-op if neither matches.
            const slug = typeof node.slug === 'string' ? node.slug : null;
            if (slug && slugToNewId.has(slug)) {
                return { ...node, pageId: slugToNewId.get(slug) };
            }
            return { ...node };
        }
        const out = {};
        for (const [k, v] of Object.entries(node)) out[k] = remapPageLinks(v);
        return out;
    };

    // Build the new SiteDoc.
    const incomingChrome = isPlainObject(incoming.chrome) ? incoming.chrome : {};
    const homepageEntry = pagesOut.find(p => p.isHomepage) || pagesOut[0] || null;
    const newSite = {
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
    };
    await configStore.setConfig(projectKey(newSiteId), newSite);

    // Write each PageDoc with a fresh page id and fresh block ids,
    // remapping any internal page links inside block content too. The
    // old→new block id map built here is what lets the locale overrides
    // (keyed by block id) survive the regeneration.
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

    // ── Locale overrides (v2 bundles) ──
    // Written last, once every page and block has its final id. Entries
    // pointing at blocks that setPage dropped (unknown type) stay in the
    // map harmlessly: resolveEffective looks overrides up FROM the base
    // blocks, so an orphan key is never read.
    const importedLocales = new Set();
    const warnings = [];

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
        const out = {};
        if (isPlainObject(override.header)) out.header = override.header;
        if (isPlainObject(override.footer)) out.footer = override.footer;
        // pageTitles arrives keyed by SLUG; storage wants the new page id.
        if (isPlainObject(override.pageTitles)) {
            const byId = {};
            for (const [slug, title] of Object.entries(override.pageTitles)) {
                const newPageId = slugToNewId.get(String(slug));
                if (newPageId && typeof title === 'string') byId[newPageId] = title;
            }
            if (Object.keys(byId).length) out.pageTitles = byId;
        }
        if (!Object.keys(out).length) continue;
        if (approxByteSize(out) > IMPORT_MAX_FIELD_BYTES) {
            throw new Error('Locale override exceeds size limit');
        }
        await setSiteLocaleOverride(newSiteId, locale, out);
        importedLocales.add(locale);
    }

    for (const [pageIdx, locale, override] of pageLocalePairs) {
        const blockIdMap = blockIdMapByPageIndex[pageIdx];
        const out = {};
        if (isPlainObject(override.blocks)) {
            const blocks = {};
            let unmapped = 0;
            for (const [oldBlockId, entry] of Object.entries(override.blocks)) {
                const newBlockId = blockIdMap.get(oldBlockId);
                if (!newBlockId) { unmapped++; continue; }
                blocks[newBlockId] = entry;
            }
            if (unmapped) {
                warnings.push(
                    `${unmapped} ${locale} translation(s) on /${pagesOut[pageIdx].slug} referenced blocks that are not in this export`
                );
            }
            if (Object.keys(blocks).length) out.blocks = blocks;
        }
        if (isPlainObject(override.seo)) out.seo = override.seo;
        if (!Object.keys(out).length) continue;
        if (approxByteSize(out) > IMPORT_MAX_FIELD_BYTES) {
            throw new Error('Locale override exceeds size limit');
        }
        await setPageLocaleOverride(newSiteId, pagesOut[pageIdx].id, locale, out);
        importedLocales.add(locale);
    }

    // The bundle's source language is informational: cms_default_locale is
    // org-wide, so silently repointing it here would retitle every OTHER
    // site on this install. Surface the mismatch instead.
    const localDefault = await getDefaultLocale();
    if (typeof incoming.defaultLocale === 'string'
        && incoming.defaultLocale
        && incoming.defaultLocale !== localDefault) {
        warnings.push(
            `Export was authored in "${incoming.defaultLocale}" but this install's default locale is "${localDefault}" — set it in Languages if the base content looks untranslated`
        );
    }

    // Register the new project in the index so it shows up in the
    // listProjects() call the panel uses to refresh its switcher list.
    await mutateProjectsIndex((index) => {
        index.projects.push({
            id: newSiteId,
            name: siteName,
            createdAt: now,
            updatedAt: now,
        });
    });

    return {
        siteId: newSiteId,
        name: siteName,
        dropped: droppedBlocks,
        locales: [...importedLocales].sort(),
        warnings,
    };
}

module.exports = {
    EXPORT_MARKER, EXPORT_VERSION, EXPORT_SUPPORTED_VERSIONS,
    collectAssetKeys, exportSite, importSite,
};
