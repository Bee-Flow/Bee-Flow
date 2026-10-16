import { Code2, Download, History, MessageSquare, Upload } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';
import SaveStatus from '../SaveStatus';
import { IdeBarButton } from './IdeChrome';
import type { WebpageIDEProps } from './ideProps';

interface IdeTopBarProps extends Pick<WebpageIDEProps, 'saveState' | 'lastSavedAt' | 'onRetrySave' | 'onUploadAsset' | 'onDownload' | 'onVersionsClick' | 'managed'> {
    devMode: boolean;
    toggleDevMode: () => void;
    hideHoistedActions: boolean;
    isOwner: boolean;
    chatOpen: boolean;
    onOpenChat: () => void;
    onPickUpload: () => void;
}

/**
 * Slim top bar — always present. Holds the code/dev toggle, and (in the
 * simplified surface where the status bar is hidden) the upload / download /
 * history controls.
 */
export default function IdeTopBar(p: IdeTopBarProps) {
    const { t } = useTranslation();
    const { devMode, hideHoistedActions } = p;
    return (
        <div className="flex items-center justify-between px-3 py-1.5 shrink-0 gap-2"
             style={{ borderBottom: '1px solid var(--vsc-border)', background: 'var(--vsc-sidebar-bg)' }}>
            <div className="flex items-center gap-3 min-w-0">
                <span className="text-[11px] shrink-0 text-[var(--vsc-fg-muted)]">
                    {devMode ? t('webpages.ide.view_developer', 'Developer view') : t('webpages.preview.title', 'Preview')}
                </span>
                {/* The save status lives in the section header from W2 on;
                    it stays here for a standalone mount (no header above). */}
                {!hideHoistedActions && (
                    <SaveStatus saveState={p.saveState} lastSavedAt={p.lastSavedAt} onRetry={p.onRetrySave} size={11} />
                )}
            </div>
            <div className="flex items-center gap-1">
                {!devMode && !hideHoistedActions && (
                    <>
                        {p.isOwner && p.onUploadAsset && (
                            <IdeBarButton Icon={Upload} label={t('webpages.action.add_image', 'Add image')} onClick={p.onPickUpload} />
                        )}
                        <IdeBarButton Icon={Download} label={t('webpages.ide.zip', 'ZIP')} onClick={p.onDownload} />
                        <IdeBarButton Icon={History} label={t('webpages.tab.history', 'History')} onClick={p.onVersionsClick} />
                    </>
                )}
                {!p.chatOpen && !p.managed && (
                    <IdeBarButton
                        Icon={MessageSquare}
                        label={t('webpages.ide.chat', 'Chat')}
                        onClick={p.onOpenChat}
                        title={t('webpages.ide.chat_hint', 'Show the AI chat')}
                    />
                )}
                {!hideHoistedActions && (
                    <IdeBarButton
                        Icon={Code2}
                        label={devMode ? t('webpages.ide.hide_code', 'Hide code') : t('webpages.tab.code', 'Code')}
                        onClick={p.toggleDevMode}
                        active={devMode}
                        title={devMode
                            ? t('webpages.ide.hide_code_hint', 'Back to the simple preview')
                            : t('webpages.ide.show_code_hint', 'Show the code editor')}
                    />
                )}
            </div>
        </div>
    );
}
