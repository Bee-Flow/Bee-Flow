import type { KeyboardEvent, MouseEvent } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import FileExplorer from '../FileExplorer';
import WebpageAppsPanel from '../WebpageAppsPanel';
import WebpageDbViewer from '../WebpageDbViewer';
import WebpageSources from '../WebpageSources';
import { ResizeHandle } from './IdeChrome';
import { explorerActiveFile, keyForExplorerSelection, type FileKey } from './ideFiles';
import type { WebpageIDEProps } from './ideProps';

interface IdeSidebarProps extends Pick<WebpageIDEProps, 'selected' | 'extraFiles' | 'onCreateFile' | 'onRenameFile' | 'onDeleteFile' | 'onUploadAsset' | 'sources' | 'onSourcesChange' | 'onVersionsClick'> {
    pane: string;
    width: number;
    isOwner: boolean;
    activeKey: FileKey | null;
    dirtyFiles: Record<string, boolean>;
    openFile: (key: FileKey) => void;
    onResizeMouseDown: (e: MouseEvent) => void;
    onResizeKey: (e: KeyboardEvent, dir?: number) => void;
}

/**
 * The developer view's sidebar — only mounted when a pane is selected.
 * Clicking the same activity-bar icon again collapses it.
 */
export default function IdeSidebar(p: IdeSidebarProps) {
    const { t } = useTranslation();
    const { pane, selected, isOwner } = p;
    const handleExplorerSelect = (file: unknown) => {
        const key = keyForExplorerSelection(file);
        if (key !== null) p.openFile(key);
    };
    return (
        <>
            <div
                className="flex flex-col shrink-0 overflow-hidden"
                style={{ width: p.width, borderRight: '1px solid var(--vsc-border)', background: 'var(--vsc-sidebar-bg)' }}
            >
                {pane === 'files' && (
                    <FileExplorer
                        activeFile={explorerActiveFile(p.activeKey)}
                        onFileSelect={handleExplorerSelect}
                        dirtyFiles={p.dirtyFiles}
                        extraFiles={p.extraFiles}
                        framework={selected?.settings?.framework}
                        onCreateFile={p.onCreateFile}
                        onRename={p.onRenameFile}
                        onDelete={p.onDeleteFile}
                        onUploadAsset={p.onUploadAsset}
                        readOnly={!isOwner}
                    />
                )}
                {pane === 'database' && <WebpageDbViewer webpageId={selected?.id} />}
                {pane === 'knowledge' && (
                    <WebpageSources webpageId={selected.id} sources={p.sources} onSourcesChange={p.onSourcesChange} />
                )}
                {pane === 'apps' && <WebpageAppsPanel webpageId={selected?.id} readOnly={!isOwner} />}
                {pane === 'history' && (
                    <div className="flex items-center justify-center h-full text-[12px] text-[var(--vsc-fg-muted)]">
                        <button
                            onClick={p.onVersionsClick}
                            className="px-3 py-1.5 rounded text-[12px]"
                            style={{ background: 'var(--vsc-accent)', color: '#fff' }}
                        >
                            {t('webpages.ide.open_history', 'Open version history')}
                        </button>
                    </div>
                )}
            </div>

            {/* Sidebar resize handle (only when sidebar is open) */}
            <ResizeHandle
                orientation="vertical"
                onMouseDown={p.onResizeMouseDown}
                onKeyDown={(e) => p.onResizeKey(e, 1)}
                label={t('webpages.ide.resize_sidebar', 'Resize sidebar')}
            />
        </>
    );
}
