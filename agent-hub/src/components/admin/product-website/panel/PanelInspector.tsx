import type { CmsActivePage, CmsBlock, CmsSiteDoc } from './cmsPanelTypes';
import { InspectorHost } from './panelJsComponents';
import { BlogInspectorSlot } from './PanelSlots';
import type { CmsBlogPanel } from './useCmsBlogPanel';
import type useCmsBlockEditing from './useCmsBlockEditing';
import type useCmsContentMutations from './useCmsContentMutations';
import type { CmsPageLink } from './useCmsDerived';
import type useCmsPageMeta from './useCmsPageMeta';
import type useCmsPanelState from './useCmsPanelState';
import type useCmsPreviewBridge from './useCmsPreviewBridge';
import type useCmsPublishing from './useCmsPublishing';
import RedirectsInspector from '../inspector/RedirectsInspector';
import { COOKIE_VIRTUAL_ID } from '../sentinels';
import type { EditableDesign } from '@/marketing/ProductWebsite.types';
import type { FieldPath } from '../translatable';

interface PanelInspectorProps {
    ps: ReturnType<typeof useCmsPanelState>;
    activePage: CmsActivePage | null;
    activeBlock: CmsBlock | null;
    activePageOverride: Record<string, unknown> | null;
    activeSiteOverride: Record<string, unknown> | null;
    pageIndex: CmsPageLink[];
    translationMode: boolean;
    isChromeView: boolean;
    activeLocaleName: string;
    defaultLocaleName: string;
    mutations: ReturnType<typeof useCmsContentMutations>;
    blockOps: ReturnType<typeof useCmsBlockEditing>;
    publish: ReturnType<typeof useCmsPublishing>;
    pageMeta: ReturnType<typeof useCmsPageMeta>;
    selectAndScrollToBlock: ReturnType<typeof useCmsPreviewBridge>['selectAndScrollToBlock'];
    blogPanel: CmsBlogPanel;
    onNavigate?: (path: string) => void;
}

type TranslateInput = Pick<PanelInspectorProps, 'ps' | 'activePage' | 'activePageOverride' | 'activeSiteOverride' | 'isChromeView' | 'activeLocaleName' | 'defaultLocaleName' | 'mutations' | 'selectAndScrollToBlock'>;

/** The translation inspector's props: text-only edits into the active locale's overrides. */
function translateProps({ ps, activePage, activePageOverride, activeSiteOverride, isChromeView, activeLocaleName, defaultLocaleName, mutations, selectAndScrollToBlock }: TranslateInput) {
    const { site, activeLocale, aiStatus, translateTier, changeTranslateTier } = ps;
    const { updatePageOverride, updateSiteOverride, handleAiTranslate, handleClearAndRetranslateBlock, handleResetTranslations } = mutations;
    return {
        site,
        page: activePage,
        localeName: activeLocaleName,
        defaultLocaleName,
        pageOverride: activePageOverride,
        siteOverride: activeSiteOverride,
        aiStatus,
        onPageLeaf: (blockId: string, fieldPath: FieldPath, value: unknown) =>
            activePage && updatePageOverride(activePage.id, activeLocale, ['blocks', blockId, 'content', ...fieldPath], value),
        onPageSeo: (field: string, value: unknown) =>
            activePage && updatePageOverride(activePage.id, activeLocale, ['seo', field], value),
        onChromeLeaf: (storagePath: FieldPath, value: unknown) =>
            updateSiteOverride(activeLocale, storagePath, value),
        onSelectBlock: selectAndScrollToBlock,
        tier: translateTier,
        onTierChange: changeTranslateTier,
        onAiTranslate: () => handleAiTranslate(isChromeView ? 'site' : 'page', translateTier),
        onClearAndRetranslateBlock: isChromeView ? undefined : handleClearAndRetranslateBlock,
        onResetTranslations: () => handleResetTranslations(isChromeView ? 'site' : 'page'),
    };
}

/** The right pane: whichever inspector the open entry needs. */
export default function PanelInspector(props: PanelInspectorProps) {
    const { ps, activePage, activeBlock, pageIndex, translationMode, activeLocaleName, mutations, blockOps, publish, pageMeta, blogPanel, onNavigate } = props;
    const { site, locales, defaultLocale, activeLocale } = ps;
    return (
        <InspectorHost
            blogInspector={blogPanel.isBlogView ? (
                <BlogInspectorSlot
                    blog={blogPanel.blog}
                    blogSettings={blogPanel.blogSettings}
                    site={site as CmsSiteDoc | null}
                    translationMode={translationMode}
                    activeLocale={activeLocale}
                    localeName={activeLocaleName}
                    defaultLocale={defaultLocale}
                    updateSiteChrome={publish.updateSiteChrome}
                />
            ) : null}
            redirectsInspector={<RedirectsInspector siteId={ps.activeSiteId} onSaved={() => ps.setDirtySincePublish(true)} />}
            activePageId={ps.activePageId}
            activePage={activePage}
            translationMode={translationMode}
            translateProps={translateProps(props)}
            chromeProps={{
                site,
                pages: pageIndex,
                locales,
                defaultLocale,
                onChangeSite: publish.updateSiteChrome,
            }}
            designProps={{
                // The stored design is an open record; the editor works on its typed view.
                design: site?.design as EditableDesign | undefined,
                onChange: (next: EditableDesign) => publish.updateDesign({ ...next } as Record<string, unknown>),
            }}
            analyticsProps={{
                site,
                onChange: publish.updateSiteAnalytics,
                onOpenCookieSettings: () => ps.setActivePageId(COOKIE_VIRTUAL_ID),
                onOpenAnalytics: onNavigate ? () => onNavigate('admin/website-analytics') : undefined,
            }}
            pageProps={{
                pageIndex,
                activeBlock,
                blockEditorTab: ps.blockEditorTab,
                onBlockEditorTab: ps.setBlockEditorTab,
                siteDesign: site?.design,
                onMetaChange: pageMeta.updatePageMeta,
                onSeoChange: pageMeta.updatePageSeo,
                onBlockContentChange: (next: unknown) => activePage && activeBlock && mutations.updateBlockContent(activePage.id, activeBlock.id, next),
                onBlockStyleChange: (next: unknown) => activePage && activeBlock && mutations.updateBlockStyle(activePage.id, activeBlock.id, next),
                onToggleBlock: blockOps.toggleBlock,
            }}
        />
    );
}
