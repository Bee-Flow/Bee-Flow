// The toolbar of a page: back, name, live presence (or the save status of a
// page saved by revision), and the side panels, print and download.

import { ArrowLeft, Download, History, ListTree, Loader2, Maximize2, MessageSquare, Printer, Search, X } from 'lucide-react';
import React from 'react';
import CollabPresence from '../../../editor/react/CollabPresence';
import type { CollabHandle } from '../../../editor/collab/useCollab';
import useTranslation from '../../../hooks/useTranslation';
import type { StudioDocument } from '../documentQueries';
import type { SaveState } from '../useDocumentAutosave';
import type { SidePanel } from './DesignedToolbar';
import SaveStatusChip from './SaveStatusChip';
import { ICON_BUTTON, PRIMARY_BUTTON, TOOL_BUTTON, TOOL_BUTTON_ACTIVE } from './ui';

export interface PageToolbarProps {
    doc: StudioDocument;
    isPanel: boolean;
    readOnly: boolean;
    live: CollabHandle | null;
    save: { state: SaveState; lastSavedAt: Date | null; onRetry: () => void; onResolve: () => void };
    side: SidePanel;
    onSide: (panel: SidePanel) => void;
    canComment: boolean;
    downloading: boolean;
    onLeave: () => void;
    onRename: (name: string) => void;
    onFind: () => void;
    onPrint: () => void;
    onDownload: () => void;
    onOpenInStudio?: () => void;
}

export default function PageToolbar(props: PageToolbarProps) {
    const { t } = useTranslation();
    const { doc, isPanel, side } = props;
    const toggle = (panel: SidePanel) => props.onSide(side === panel ? null : panel);
    const cls = (on: boolean) => (on ? TOOL_BUTTON_ACTIVE : TOOL_BUTTON);
    const backLabel = isPanel ? t('documents.close', 'Close') : t('documents.back', 'Back to Documents');
    return (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]" data-testid="page-toolbar">
            <button type="button" onClick={props.onLeave} className={ICON_BUTTON} aria-label={backLabel}>{isPanel ? <X size={17} /> : <ArrowLeft size={17} />}</button>
            <input key={doc.name} disabled={props.readOnly} defaultValue={doc.name} aria-label={t('documents.name', 'Document name')}
                onBlur={(e) => props.onRename(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                className="flex-1 min-w-[8rem] bg-transparent text-sm font-semibold px-1.5 py-1 rounded outline-none focus:ring-1 focus:ring-[var(--accent-primary)] text-[var(--text-primary)]" />
            {props.live
                ? <CollabPresence handle={props.live} />
                : <SaveStatusChip state={props.save.state} lastSavedAt={props.save.lastSavedAt} onRetry={props.save.onRetry} onResolve={props.save.onResolve} />}
            <button type="button" className={cls(side === 'outline')} aria-pressed={side === 'outline'} onClick={() => toggle('outline')} title={t('documents.outline.title', 'Outline')} data-testid="document-outline-toggle">
                <ListTree size={14} aria-hidden="true" /><span className="sr-only">{t('documents.outline.title', 'Outline')}</span>
            </button>
            <button type="button" className={TOOL_BUTTON} onClick={props.onFind} title={t('documents.find.label', 'Find in document')}>
                <Search size={14} aria-hidden="true" /><span className="sr-only">{t('documents.find.label', 'Find in document')}</span>
            </button>
            {props.canComment && (
                <button type="button" className={cls(side === 'comments')} aria-pressed={side === 'comments'} onClick={() => toggle('comments')} data-testid="document-comments-toggle">
                    <MessageSquare size={14} aria-hidden="true" />{t('documents.comments', 'Comments')}
                </button>
            )}
            <button type="button" className={cls(side === 'history')} aria-pressed={side === 'history'} onClick={() => toggle('history')} data-testid="document-history-toggle">
                <History size={14} aria-hidden="true" />{t('documents.history', 'History')}
            </button>
            {isPanel && props.onOpenInStudio && (
                <button type="button" onClick={props.onOpenInStudio} className={ICON_BUTTON} aria-label={t('documents.open_in_studio', 'Open in Studio')} title={t('documents.open_in_studio', 'Open in Studio')}>
                    <Maximize2 size={15} />
                </button>
            )}
            <button type="button" className={TOOL_BUTTON} onClick={props.onPrint} disabled={props.downloading} data-testid="document-print">
                <Printer size={14} aria-hidden="true" />{t('documents.print', 'Print')}
            </button>
            <button type="button" className={PRIMARY_BUTTON} onClick={props.onDownload} disabled={props.downloading} data-testid="document-download-pdf">
                {props.downloading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
                {t('documents.download_pdf', 'Download PDF')}
            </button>
        </div>
    );
}
