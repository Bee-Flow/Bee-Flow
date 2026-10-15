import React, { type ComponentProps, type ReactNode } from 'react';
import TranslationPanel from '../TranslationPanel';
import AnalyticsInspector from './AnalyticsInspector';
import ChromeInspector from './ChromeInspector';
import DesignInspector from './DesignInspector';
import PageInspector from './PageInspector';
import { useTranslation } from '../../../../hooks/useTranslation';
import {
    ANALYTICS_VIRTUAL_ID, BLOG_VIRTUAL_ID, DESIGN_VIRTUAL_ID, isChromeEntryId, normalizeVirtualId,
} from '../sentinels';

function CenteredNote({ children }: { children: ReactNode }) {
    return (
        <div className="flex-1 h-full flex items-center justify-center text-[var(--text-muted)] text-xs p-4 text-center">
            {children}
        </div>
    );
}

/**
 * Inspector mode router — the right panel's single decision point. Priority
 * order is identical to the old Pane B ternary:
 *
 *   translation mode  →  blocked note (design/analytics) | TranslationPanel | pick-a-page
 *   chrome entry      →  ChromeInspector (header / footer / cookie)
 *   design entry      →  DesignInspector
 *   analytics entry   →  AnalyticsInspector
 *   real page         →  PageInspector (page settings + block editor)
 *   nothing           →  placeholder
 */
export interface InspectorHostProps {
    activePageId: string;
    activePage: ComponentProps<typeof PageInspector>['page'] | null | undefined;
    translationMode: boolean;
    translateProps: Omit<ComponentProps<typeof TranslationPanel>, 'scope'>;     // TranslationPanel props minus `scope` (added here)
    chromeProps: Omit<ComponentProps<typeof ChromeInspector>, 'entryId'>;       // { site, pages, onChangeSite }
    designProps: ComponentProps<typeof DesignInspector>;                        // { design, onChange }
    analyticsProps: ComponentProps<typeof AnalyticsInspector>;                  // { site, onChange, onOpenCookieSettings, onOpenAnalytics }
    pageProps: Omit<ComponentProps<typeof PageInspector>, 'page'>;              // PageInspector props minus `page` (added here)
    blogInspector?: ReactNode;                                                  // the Blog entry's inspector (handles translation mode itself)
}

export default function InspectorHost({
    activePageId,
    activePage,
    translationMode,
    translateProps,
    chromeProps,
    designProps,
    analyticsProps,
    pageProps,
    blogInspector = null,
}: InspectorHostProps) {
    const { t } = useTranslation();
    const entryId = normalizeVirtualId(activePageId) as string;
    if (entryId === BLOG_VIRTUAL_ID && blogInspector) return blogInspector;
    const isChrome = isChromeEntryId(entryId);
    const isDesign = entryId === DESIGN_VIRTUAL_ID;
    const isAnalytics = entryId === ANALYTICS_VIRTUAL_ID;

    if (translationMode) {
        if (isDesign) {
            return (
                <CenteredNote>
                    {t('cms_site.site.inspector.design_shared', 'Design is shared across all languages. Switch to the default language to edit it.')}
                </CenteredNote>
            );
        }
        if (isAnalytics) {
            return (
                <CenteredNote>
                    {t('cms_site.site.inspector.analytics_shared', 'Analytics settings are shared across all languages. Switch to the default language to edit them.')}
                </CenteredNote>
            );
        }
        if (isChrome || activePage) {
            return (
                <TranslationPanel
                    scope={isChrome ? 'site' : 'page'}
                    {...translateProps}
                />
            );
        }
        return <CenteredNote>{t('cms_site.site.inspector.select_translate', 'Select a page to translate.')}</CenteredNote>;
    }

    if (isChrome) return <ChromeInspector entryId={entryId} {...chromeProps} />;
    if (isDesign) return <DesignInspector {...designProps} />;
    if (isAnalytics) return <AnalyticsInspector {...analyticsProps} />;
    if (activePage) return <PageInspector page={activePage} {...pageProps} />;

    return <CenteredNote>{t('cms_site.site.inspector.select_page', 'Select a page from the list.')}</CenteredNote>;
}
