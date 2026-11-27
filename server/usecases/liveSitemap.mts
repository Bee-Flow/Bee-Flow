/**
 * The live site's sitemap.xml, and the locales it publishes. Split out of
 * routes/publicRender.js so the IndexNow ping after a publish
 * (./cmsIndexNow.mts) diffs exactly the document crawlers read.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const cmsStore = nodeRequire('../stores/cmsStore');
const languageStore = nodeRequire('../stores/languageStore');
const { LOCALE_PREFIXES } = nodeRequire('../core/seo/publicPath');
const { buildSitemap } = nodeRequire('../core/seo/sitemap');
const { localesForPage } = nodeRequire('../i18n/pageLocales');
const { listGalleryItems, integrationSitemapEntries } = nodeRequire('../core/seo/integrationsDirectory');
const { blogSitemap } = nodeRequire('./publicRenderBlogSitemap');
const { fallback } = nodeRequire('../utils/bestEffort');

export interface SiteLocales { defaultLocale: string; locales: string[] }

type Snapshot = {
    publishedAt?: string;
    site?: { pages?: Array<{ id: string; slug?: string }> };
    pages?: Record<string, { seo?: Record<string, unknown> }>;
    pageMeta?: Record<string, { lastModifiedAt?: string }>;
    [k: string]: unknown;
};

/**
 * The locales this SITE publishes, default first.
 *
 * Intersected with LOCALE_PREFIXES rather than taken from the product's
 * interface-translation list: that list includes every language the GUI has
 * strings for, and using it made each page advertise hreflang alternates —
 * /de/, /fr/ — that the router does not serve and no translator has written.
 */
export async function siteLocales(): Promise<SiteLocales> {
    const defaultLocale: string = await cmsStore.getDefaultLocale();
    let extra: string[] = [];
    try {
        const available: Array<{ code: unknown }> = await languageStore.getAvailableLocales();
        extra = (available || [])
            .map((l) => String(l.code).toLowerCase())
            .filter((code) => code !== defaultLocale && LOCALE_PREFIXES.has(code));
    } catch (err) { fallback('usecases/liveSitemap:siteLocales', err); /* a single-locale site is a fine fallback */ }
    return { defaultLocale, locales: [defaultLocale, ...extra] };
}

/**
 * sitemap.xml for a published snapshot: its pages, the blog and the
 * integration pages. `lastmod` is the date for an entry that has none of its
 * own (the publish time on the public route; null to leave it out).
 *
 * The PUBLISHED snapshot, not the draft: the sitemap must advertise what is
 * actually being served. It is also the only source that carries each page's
 * full `seo` (the page index entry does not), and `seo.noIndex` decides
 * whether a page belongs in here at all.
 */
export async function liveSitemapXml(
    { siteId, snapshot, origin, lastmod }: { siteId: string; snapshot: Snapshot; origin: string; lastmod: string | null },
): Promise<string> {
    const { defaultLocale, locales } = await siteLocales();
    const pages = (snapshot.site?.pages || []).map((entry) => ({
        ...entry,
        seo: snapshot.pages?.[entry.id]?.seo || {},
        updatedAt: snapshot.pageMeta?.[entry.id]?.lastModifiedAt || lastmod,
        locales: localesForPage(snapshot, entry.id, defaultLocale, locales),
    }));
    const blogEntries = await blogSitemap(siteId, { snapshot, defaultLocale, locales, lastmod: lastmod || undefined });
    const integrations = integrationSitemapEntries(listGalleryItems(), { defaultLocale, locales, lastmod: lastmod || undefined });
    return buildSitemap([...pages, ...blogEntries, ...integrations], { origin, defaultLocale, locales });
}
