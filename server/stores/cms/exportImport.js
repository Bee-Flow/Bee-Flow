// @typecheck
// Site export / import — the full-website bundle: SiteDoc, every PageDoc and
// every translation in one JSON payload, plus the asset-key walk the download
// route uses to gather the media that rides along with it.

const configStore = require('../configStore');
const { newId, isPlainObject, projectKey, sanitizeAnalytics, sanitizeBlogSettings } = require('./shared');
const { listPosts, collectPostLocaleOverrides } = require('./posts');
const { extractAssetKeys } = require('./postText');
const { getProject, mutateProjectsIndex } = require('./projects');
const { getPage } = require('./pages');
const { getDefaultLocale, collectLocaleOverrides } = require('./localeOverrides');
const {
    validateImport, planPages, makePageLinkRemapper, buildSiteDoc, writePages,
    restoreLocaleOverrides, restoreBlogPosts,
} = require('./importSteps');

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

    // Blog posts ride along as an additive key (an older install simply
    // ignores it). Exported without ids, like pages; their translations sit
    // on the post itself, and `bodyAssets` names the images the Markdown body
    // points at so collectAssetKeys packs them into the zip too.
    const postTranslations = await collectPostLocaleOverrides(siteId);
    const exportedPosts = (await listPosts(siteId)).map((post) => {
        const locales = {};
        for (const [locale, override] of Object.entries(postTranslations[post.id] || {})) {
            if (!isPlainObject(override)) continue;
            const out = {};
            for (const k of ['title', 'excerpt', 'body', 'coverAlt']) if (typeof override[k] === 'string') out[k] = override[k];
            if (isPlainObject(override.seo)) out.seo = override.seo;
            if (!Object.keys(out).length) continue;
            locales[locale] = out;
            localesSeen.add(locale);
        }
        const bodyAssets = [post.body, ...Object.values(locales).map(l => l.body)]
            .flatMap(b => extractAssetKeys(b));
        return {
            slug: post.slug,
            title: post.title,
            excerpt: post.excerpt,
            body: post.body,
            coverImage: post.coverImage,
            coverAlt: post.coverAlt,
            authorName: post.authorName,
            tags: post.tags,
            status: post.status,
            publishedAt: post.publishedAt,
            createdAt: post.createdAt,
            updatedAt: post.updatedAt,
            seo: post.seo,
            ...(bodyAssets.length ? { bodyAssets: [...new Set(bodyAssets)] } : {}),
            ...(Object.keys(locales).length ? { locales } : {}),
        };
    });

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
            blog: sanitizeBlogSettings(site.blog),
            posts: exportedPosts,
        },
    };
}

async function importSite(exportData) {
    const { incoming, postsPreview } = validateImport(exportData, {
        marker: EXPORT_MARKER, supportedVersions: EXPORT_SUPPORTED_VERSIONS,
    });

    // Fresh site id + a name suffix so the user can tell originals apart
    // from imports at a glance. The suffix is plain; users rename via
    // the Site Switcher right after import if they want.
    const newSiteId = newId('pj');
    const now = new Date().toISOString();
    const siteName = (typeof incoming.name === 'string' && incoming.name.trim())
        ? `${incoming.name} (imported)`
        : 'Imported site';

    const { pagesOut, pagesInAligned, slugToNewId } = planPages(incoming);
    const remapPageLinks = makePageLinkRemapper(slugToNewId);

    const incomingChrome = isPlainObject(incoming.chrome) ? incoming.chrome : {};
    const newSite = buildSiteDoc({ incoming, incomingChrome, newSiteId, siteName, pagesOut, remapPageLinks });
    await configStore.setConfig(projectKey(newSiteId), newSite);

    const { droppedBlocks, blockIdMapByPageIndex } = await writePages({ newSiteId, pagesOut, pagesInAligned, remapPageLinks });

    const importedLocales = new Set();
    const warnings = [];
    await restoreLocaleOverrides({
        newSiteId, incomingChrome, pagesOut, pagesInAligned, slugToNewId, blockIdMapByPageIndex, importedLocales, warnings,
    });
    const importedPosts = await restoreBlogPosts({ newSiteId, postsPreview, importedLocales, warnings });

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
        posts: importedPosts,
        locales: [...importedLocales].sort(),
        warnings,
    };
}

module.exports = {
    EXPORT_MARKER, EXPORT_VERSION, EXPORT_SUPPORTED_VERSIONS,
    collectAssetKeys, exportSite, importSite,
};
