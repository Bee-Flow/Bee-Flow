import { useMemo } from 'react';
import type { CmsActivePage, CmsBlock, CmsLocaleOverrides, CmsPageDoc, CmsSiteDoc } from './cmsPanelTypes';
import { isVirtualPageId } from '../sentinels';

interface DerivedInput {
    site: CmsSiteDoc | null;
    pages: CmsPageDoc[];
    activePageId: string | null;
    activeBlockId: string | null;
    activeLocale: string;
    defaultLocale: string;
    localeOverrides: CmsLocaleOverrides;
}

/** A link-picker entry: the public page index. */
export interface CmsPageLink {
    id: string;
    slug?: string;
    title?: string;
    isHomepage?: boolean;
}

export interface CmsDerived {
    activePage: CmsActivePage | null;
    activeBlock: CmsBlock | null;
    /** Editing a non-default locale: text only, into sparse overrides. */
    translationMode: boolean;
    activeSiteOverride: Record<string, unknown> | null;
    activePageOverride: Record<string, unknown> | null;
    pageIndex: CmsPageLink[];
    /** The page the iframe renders (the homepage while a virtual entry is open). */
    previewPage: CmsPageDoc | null;
}

/**
 * Merge the PageDoc with its matching site.pages[i] index entry so the
 * PageMetaStrip can read isHomepage/hideHeader/hideFooter/isNotFound/
 * noAnalytics (which live on the index, not the PageDoc). Every index-only
 * field MUST be listed here — the PageDoc sanitizer strips them, so an omitted
 * field reads as undefined forever and its toggle can never be switched back off.
 */
function mergeActivePage(site: CmsSiteDoc | null, pages: CmsPageDoc[], activePageId: string | null): CmsActivePage | null {
    if (isVirtualPageId(activePageId)) return null;
    const doc = pages.find(p => p.id === activePageId);
    if (!doc) return null;
    const idx = (site?.pages || []).find(p => p.id === activePageId);
    return idx
        ? { ...doc, isHomepage: !!idx.isHomepage,
            hideHeader: !!idx.hideHeader,
            hideFooter: !!idx.hideFooter,
            isNotFound: !!idx.isNotFound,
            noAnalytics: !!idx.noAnalytics }
        : doc;
}

/** Everything the panel derives from the loaded documents and the current selection. */
export default function useCmsDerived({ site, pages, activePageId, activeBlockId, activeLocale, defaultLocale, localeOverrides }: DerivedInput): CmsDerived {
    const activePage = useMemo(() => mergeActivePage(site, pages, activePageId), [pages, activePageId, site]);

    const activeBlock = useMemo(() => {
        if (!activePage || !activeBlockId) return null;
        return activePage.blocks?.find(b => b.id === activeBlockId) || null;
    }, [activePage, activeBlockId]);

    // ── translation mode ────────────────────────────────────────────
    // Editing any non-default locale switches the panel into "translation
    // mode": structure is authored in the default locale, so here we edit
    // TEXT ONLY and write into sparse per-locale overrides.
    const translationMode = activeLocale !== defaultLocale;
    const activeSiteOverride = useMemo(
        () => localeOverrides.siteByLocale?.[activeLocale] || null,
        [localeOverrides, activeLocale]);
    const activePageOverride = useMemo(
        () => (activePage ? localeOverrides.pagesByLocale?.[activePage.id]?.[activeLocale] : null) || null,
        [localeOverrides, activePage, activeLocale]);

    // Public page index — passed to LinkField pickers
    const pageIndex = useMemo(() =>
        (site?.pages || []).map(p => ({ id: p.id, slug: p.slug, title: p.title, isHomepage: p.isHomepage })),
        [site]
    );

    // What page does the iframe preview render?
    //   - editing a real page → that page
    //   - editing a virtual entry (Design / Site chrome) → fall back to the
    //     homepage so the user can see chrome and design changes against
    //     real block content (otherwise the preview is just header+footer).
    const previewPage = useMemo(() => {
        if (activePage) return activePage;
        const homePageId = site?.homepageId || (site?.pages || [])[0]?.id;
        if (!homePageId) return null;
        return pages.find(p => p.id === homePageId) || null;
    }, [activePage, pages, site]);

    return { activePage, activeBlock, translationMode, activeSiteOverride, activePageOverride, pageIndex, previewPage };
}
