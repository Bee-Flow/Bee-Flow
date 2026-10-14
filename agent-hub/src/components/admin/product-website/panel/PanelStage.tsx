import { AddBlockDialog, PreviewStage } from './panelJsComponents';
import type { PanelView } from './panelView';
import { StageEmptyOverlay } from './PanelSlots';
import type useCmsPagesTemplates from './useCmsPagesTemplates';
import type useCmsPanelState from './useCmsPanelState';
import { useTranslation } from '../../../../hooks/useTranslation';
import { SaveTemplateDialog } from '../PageList';
import { isVirtualPageId } from '../sentinels';
import SitemapView from '../SitemapView';

interface PanelStageProps {
    ps: ReturnType<typeof useCmsPanelState>;
    view: PanelView;
    onCreateFirstPage: () => void;
    /** Pull the sitemap flyout's server-side changes into panel state. */
    onSitemapMutated: () => Promise<void>;
}

/** The centre stage: the preview iframe (or the sitemap) with its status line and empty states. */
export default function PanelStage({ ps, view, onCreateFirstPage, onSitemapMutated }: PanelStageProps) {
    const { t } = useTranslation();
    const { rightView, device, activeLocale, activePageId, setActivePageId, setRightView } = ps;
    // The iframe node is built HERE so the container keeps owning iframeRef
    // and the key={activeLocale} remount semantics (cms-preview-ready
    // re-handshake); PreviewStage only decides visibility.
    const iframe = (
        <iframe
            ref={ps.iframeRef}
            title={t('cms_site.site.panel.preview_title', 'Product website preview')}
            src={view.iframeSrc}
            className="flex-1 w-full bg-white"
            key={activeLocale}
        />
    );
    return (
        <PreviewStage
            view={rightView}
            statusText={view.statusText}
            errorText={ps.error}
            onDismissError={() => ps.setError(null)}
            deviceWidth={device === 'tablet' ? 768 : device === 'mobile' ? 390 : null}
            overlay={view.showStageOverlay ? <StageEmptyOverlay noPages={view.noPages} onCreateFirstPage={onCreateFirstPage} /> : null}
            iframe={iframe}
            sitemap={rightView === 'sitemap' ? (
                <SitemapView
                    siteId={ps.activeSiteId}
                    activePageId={isVirtualPageId(activePageId) ? null : activePageId}
                    onSelectPage={(id: string) => {
                        setActivePageId(id);
                        setRightView('preview');
                    }}
                    onMutated={onSitemapMutated}
                />
            ) : null}
        />
    );
}

interface PanelDialogsProps {
    ps: ReturnType<typeof useCmsPanelState>;
    addBlock: (type: string, index: number | null, extra: { variant: string } | null) => void;
    submitTemplate: ReturnType<typeof useCmsPagesTemplates>['submitTemplate'];
}

/** Save-as-template, add-block and the shared confirm dialog. */
export function PanelDialogs({ ps, addBlock, submitTemplate }: PanelDialogsProps) {
    const { pendingTemplatePage, setPendingTemplatePage, addBlockRequest, setAddBlockRequest, site, confirmDialog } = ps;
    return (
        <>
            {pendingTemplatePage ? (
                <SaveTemplateDialog
                    page={pendingTemplatePage}
                    onCancel={() => setPendingTemplatePage(null)}
                    onConfirm={submitTemplate}
                />
            ) : null}
            {addBlockRequest ? (
                <AddBlockDialog
                    design={site?.design || null}
                    onAdd={(type: string, variant?: string) => {
                        addBlock(type, addBlockRequest.index, variant ? { variant } : null);
                        setAddBlockRequest(null);
                    }}
                    onCancel={() => setAddBlockRequest(null)}
                />
            ) : null}
            {confirmDialog}
        </>
    );
}
