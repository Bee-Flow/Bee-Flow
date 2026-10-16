import type { CmsActivePage, CmsLocale, CmsLocaleOverrides, CmsPageDoc, CmsSiteDoc, CmsSiteListEntry } from './cmsPanelTypes';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { LocaleCoverage } from '../shell/LocaleMenu';
import {
    ANALYTICS_VIRTUAL_ID, DESIGN_VIRTUAL_ID, REDIRECTS_VIRTUAL_ID,
    isChromeEntryId, normalizeVirtualId,
} from '../sentinels';
import { coverageForLocale } from '../translatable';

interface PanelViewInput {
    t: TranslateFn;
    sites: CmsSiteListEntry[];
    site: CmsSiteDoc | null;
    pages: CmsPageDoc[];
    locales: CmsLocale[];
    localeOverrides: CmsLocaleOverrides;
    activeSiteId: string | null;
    liveSiteId: string | null;
    activePageId: string | null;
    activePage: CmsActivePage | null;
    activeLocale: string;
    defaultLocale: string;
    rightView: string;
    isBlogView: boolean;
    translationMode: boolean;
}

export interface PanelView {
    entryId: string | null;
    isChromeView: boolean;
    /** Dedicated CMS preview route; locale switches remount the iframe (key). */
    iframeSrc: string;
    /** Every site sharing the active site's versionGroupId. */
    versions: CmsSiteListEntry[];
    activeLocaleName: string;
    defaultLocaleName: string;
    isLive: boolean;
    coverageByLocale: Record<string, LocaleCoverage>;
    otherLiveSite: CmsSiteListEntry | null;
    statusText: string | null;
    /** Which empty-state the stage shows, if any. */
    noPages: boolean;
    showStageOverlay: boolean;
}

function viewName(t: TranslateFn, entryId: string | null, isBlogView: boolean, isChromeView: boolean, activePage: CmsActivePage | null): string {
    if (isBlogView) return t('cms_blog.navigator.blog', 'Blog');
    if (isChromeView) return t('cms_site.site.panel.view_chrome', 'site chrome');
    if (entryId === DESIGN_VIRTUAL_ID) return t('cms_site.site.panel.view_design', 'design');
    if (entryId === ANALYTICS_VIRTUAL_ID) return t('cms_site.site.panel.view_analytics', 'analytics');
    if (entryId === REDIRECTS_VIRTUAL_ID) return t('cms_redirects.view', 'redirects');
    return activePage?.slug || 'home';
}

/** What the builder chrome shows around the stage, derived from the loaded state. */
export function derivePanelView(input: PanelViewInput): PanelView {
    const {
        t, sites, site, pages, locales, localeOverrides, activeSiteId, liveSiteId,
        activePageId, activePage, activeLocale, defaultLocale, rightView, isBlogView, translationMode,
    } = input;
    const entryId = normalizeVirtualId(activePageId);
    const isChromeView = isChromeEntryId(activePageId);

    // Page switches do NOT reload the iframe; they're pushed via postMessage.
    const iframeSrc = `/__cms_preview__?preview=1&locale=${encodeURIComponent(activeLocale)}`;

    // Versions of the active site = every site sharing its versionGroupId.
    // listSites() carries versionGroupId/versionName on each entry; the
    // `|| s.id` fallback covers entries that pre-date versioning.
    const activeGroupId =
        sites.find(s => s.id === activeSiteId)?.versionGroupId
        || site?.versionGroupId
        || activeSiteId;
    const versions = sites.filter(s => (s.versionGroupId || s.id) === activeGroupId);

    const activeLocaleName = locales.find(l => l.code === activeLocale)?.name || activeLocale;
    const defaultLocaleName = locales.find(l => l.code === defaultLocale)?.name || defaultLocale;
    const isLive = liveSiteId === activeSiteId;

    // Per-locale translation coverage for the locale menu ("n/m fields").
    // Cheap walk over client-side state; soft numbers by design (D3).
    const coverageByLocale: Record<string, LocaleCoverage> = {};
    for (const l of locales) {
        if (l.code === defaultLocale || !site) continue;
        coverageByLocale[l.code] = coverageForLocale(site, pages, localeOverrides, l.code);
    }
    const otherLiveSite = liveSiteId && liveSiteId !== activeSiteId
        ? (sites.find(s => s.id === liveSiteId) ?? null)
        : null;

    const statusText = rightView === 'preview'
        ? t('cms_site.site.panel.status', '{view} · {locale}{editorOnly} · Click text to edit', {
            view: viewName(t, entryId, isBlogView, isChromeView, activePage),
            locale: activeLocale,
            editorOnly: !isLive ? t('cms_site.site.panel.editor_only', ' · editor only') : '',
        })
        : null;

    const noPages = (site?.pages || []).length === 0;
    const activePageEmpty = !!activePage && (activePage.blocks || []).length === 0 && !translationMode;
    const showStageOverlay = rightView === 'preview' && (noPages || activePageEmpty);

    return {
        entryId, isChromeView, iframeSrc, versions, activeLocaleName, defaultLocaleName,
        isLive, coverageByLocale, otherLiveSite, statusText, noPages, showStageOverlay,
    };
}
