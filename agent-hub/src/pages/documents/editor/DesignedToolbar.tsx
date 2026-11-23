// The toolbar of a designed document: back, name, save status, who else is
// here, Viewing / Editing, house style, the side panels, print and download.

import {
    ArrowLeft, Download, Eye, FileDown, History, Keyboard, ListTree, Loader2, Maximize2, MessageSquare, Pencil, Presentation, Printer, Search, Stamp, X,
} from 'lucide-react';
import { useState } from 'react';
import { exportTemplateFile } from '@/api/templateFileApi';
import SegmentedControl from '@/components/shared/SegmentedControl';
import { logger } from '@/utils/logger';
import useTranslation from '@/hooks/useTranslation';
import type { People, StudioDocument } from '../documentQueries';
import type { PresencePeer } from '../useSectionPresence';
import type { SaveState } from '../useDocumentAutosave';
import PresenceAvatars from './PresenceAvatars';
import SaveStatusChip from './SaveStatusChip';
import { ICON_BUTTON, PRIMARY_BUTTON, TOOL_BUTTON, TOOL_BUTTON_ACTIVE, TOOL_BUTTON_OFF } from './ui';

// The toolbar is a container: when it runs out of room the quieter tools drop
// their words first (the icon stays, with the word as its tooltip and name), so
// the row never wraps a download button onto a second line.
const LABEL_WIDE = 'hidden @[78rem]/toolbar:inline';
const LABEL_MID = 'hidden @[66rem]/toolbar:inline';

export type EditorMode = 'viewing' | 'editing';
export type SidePanel = 'outline' | 'history' | 'comments' | 'suggestions' | null;

export interface DesignedToolbarProps {
    doc: StudioDocument;
    isPanel: boolean;
    readOnly: boolean;
    mode: EditorMode;
    onMode: (mode: EditorMode) => void;
    save: { state: SaveState; lastSavedAt: Date | null; onRetry: () => void; onResolve: () => void };
    presence: { peers: PresencePeer[]; people: People; sectionLabel: (id: string | null) => string | null };
    side: SidePanel;
    onSide: (panel: SidePanel) => void;
    canComment: boolean;
    findOpen: boolean;
    onFind: () => void;
    onShortcuts: () => void;
    downloading: boolean;
    onLeave: () => void;
    onRename: (name: string) => void;
    /** Moves when the saved name should be shown again (a refused rename). */
    nameKey?: number;
    onToggleHouseStyle: () => void;
    onOpenInStudio?: () => void;
    onPrint: () => void;
    /** Saves the settings and the typed text: the template file is built from the stored document. */
    onBeforeExport?: () => Promise<void>;
    onDownload: (format: 'pdf' | 'pptx') => void;
}

function SideButtons({ side, onSide, canComment, findOpen, onFind, isDeck }: Pick<DesignedToolbarProps, 'side' | 'onSide' | 'canComment' | 'findOpen' | 'onFind'> & { isDeck: boolean }) {
    const { t } = useTranslation();
    const toggle = (panel: SidePanel) => onSide(side === panel ? null : panel);
    const cls = (on: boolean) => (on ? TOOL_BUTTON_ACTIVE : TOOL_BUTTON);
    return (
        <>
            {!isDeck && (
                <>
                    <button type="button" className={cls(side === 'outline')} aria-pressed={side === 'outline'} onClick={() => toggle('outline')} title={t('documents.outline.title', 'Outline')} data-testid="document-outline-toggle">
                        <ListTree size={14} aria-hidden="true" /><span className="sr-only">{t('documents.outline.title', 'Outline')}</span>
                    </button>
                    <button type="button" className={cls(findOpen)} aria-pressed={findOpen} onClick={onFind} title={t('documents.find.label', 'Find in document')}>
                        <Search size={14} aria-hidden="true" /><span className="sr-only">{t('documents.find.label', 'Find in document')}</span>
                    </button>
                </>
            )}
            {canComment && (
                <button type="button" className={cls(side === 'comments')} aria-pressed={side === 'comments'} onClick={() => toggle('comments')} data-testid="document-comments-toggle"
                    title={t('documents.comments', 'Comments')} aria-label={t('documents.comments', 'Comments')}>
                    <MessageSquare size={14} aria-hidden="true" /><span className={LABEL_WIDE}>{t('documents.comments', 'Comments')}</span>
                </button>
            )}
            <button type="button" className={cls(side === 'history')} aria-pressed={side === 'history'} onClick={() => toggle('history')} data-testid="document-history-toggle"
                title={t('documents.history', 'History')} aria-label={t('documents.history', 'History')}>
                <History size={14} aria-hidden="true" /><span className={LABEL_WIDE}>{t('documents.history', 'History')}</span>
            </button>
        </>
    );
}

/** The document as a .bftemplate file (body, stylesheet, fields, design), to import in another Bee Flow or library. */
function TemplateFileButton({ id, name, before }: { id: string; name: string; before?: () => Promise<void> }) {
    const { t } = useTranslation();
    const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
    const run = async () => {
        setState('busy');
        try {
            // The file is built from the stored document: save what was typed first.
            await before?.();
            await exportTemplateFile(id, name);
            setState('idle');
        } catch (err) {
            logger.debug('template file export failed', err);
            setState('failed');
        }
    };
    return (
        <button type="button" className={TOOL_BUTTON} onClick={() => { void run(); }} disabled={state === 'busy'} data-testid="document-export-template" aria-label={t('doc_template_file.export_button', 'Template file')}
            title={t('doc_template_file.export_hint', 'Download as a .bftemplate file: the layout, styling and fields, to import elsewhere')}>
            {state === 'busy' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <FileDown size={14} aria-hidden="true" />}
            <span aria-live="polite" className={state === 'failed' ? undefined : LABEL_MID}>{state === 'failed' ? t('doc_template_file.export_failed_short', 'Export failed') : t('doc_template_file.export_button', 'Template file')}</span>
        </button>
    );
}

function Downloads({ isDeck, downloading, onPrint, onDownload }: { isDeck: boolean; downloading: boolean; onPrint: () => void; onDownload: (f: 'pdf' | 'pptx') => void }) {
    const { t } = useTranslation();
    const spin = <Loader2 size={14} className="animate-spin" aria-hidden="true" />;
    return (
        <>
            <button type="button" className={TOOL_BUTTON} onClick={onPrint} disabled={downloading} title={t('documents.print_hint', 'Opens the PDF with its page breaks, ready to print')} aria-label={t('documents.print', 'Print')} data-testid="document-print">
                <Printer size={14} aria-hidden="true" /><span className={LABEL_MID}>{t('documents.print', 'Print')}</span>
            </button>
            {isDeck && (
                <button type="button" className={PRIMARY_BUTTON} onClick={() => onDownload('pptx')} disabled={downloading} data-testid="document-download-pptx">
                    {downloading ? spin : <Presentation size={14} aria-hidden="true" />}{t('documents.download_pptx', 'Download PowerPoint')}
                </button>
            )}
            <button type="button" className={isDeck ? TOOL_BUTTON : PRIMARY_BUTTON} onClick={() => onDownload('pdf')} disabled={downloading} data-testid="document-download-pdf">
                {downloading ? spin : <Download size={14} aria-hidden="true" />}{isDeck ? t('documents.download_pdf_short', 'PDF') : t('documents.download_pdf', 'Download PDF')}
            </button>
        </>
    );
}

export default function DesignedToolbar(props: DesignedToolbarProps) {
    const { t } = useTranslation();
    const { doc, isPanel, readOnly, mode } = props;
    const isDeck = doc.docType === 'presentation';
    const usesHouseStyle = doc.settings?.houseStyle !== false;
    const backLabel = isPanel ? t('documents.close', 'Close') : t('documents.back', 'Back to Documents');
    return (
        <div className="@container/toolbar shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]" data-testid="document-toolbar">
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
            <button type="button" onClick={props.onLeave} className={ICON_BUTTON} aria-label={backLabel}>{isPanel ? <X size={17} /> : <ArrowLeft size={17} />}</button>
            <input key={`${doc.name}:${props.nameKey ?? 0}`} disabled={readOnly} defaultValue={doc.name} aria-label={t('documents.name', 'Document name')}
                onBlur={(e) => props.onRename(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                className="flex-1 min-w-[6rem] bg-transparent text-sm font-semibold px-1.5 py-1 rounded outline-none focus:ring-1 focus:ring-[var(--accent-primary)] text-[var(--text-primary)]" />
            <SaveStatusChip state={props.save.state} lastSavedAt={props.save.lastSavedAt} onRetry={props.save.onRetry} onResolve={props.save.onResolve} />
            <PresenceAvatars peers={props.presence.peers} people={props.presence.people} sectionLabel={props.presence.sectionLabel} />
            <SegmentedControl size="sm" value={mode} onChange={props.onMode} ariaLabel={t('documents.mode.label', 'Mode')}
                options={[
                    { value: 'viewing', label: t('documents.mode.viewing', 'Viewing'), icon: <Eye size={13} aria-hidden="true" /> },
                    { value: 'editing', label: isDeck ? t('documents.mode.editing_outline', 'Outline') : t('documents.mode.editing', 'Editing'), icon: <Pencil size={13} aria-hidden="true" />, disabled: readOnly },
                ]} />
            <button type="button" className={usesHouseStyle ? TOOL_BUTTON : TOOL_BUTTON_OFF}
                onClick={props.onToggleHouseStyle} disabled={readOnly} data-testid="document-house-style-toggle" data-on={String(usesHouseStyle)}
                aria-label={usesHouseStyle ? t('documents.house_style_on', 'House style') : t('documents.house_style_off', 'No house style')}
                title={usesHouseStyle ? t('doc_house_style.toggle_on_hint', 'This document follows the organisation\'s current house style. Click to turn it off for this document only.') : t('doc_house_style.toggle_off_hint', 'This document does not use the house style. Click to follow the organisation\'s current house style again.')}>
                <Stamp size={14} aria-hidden="true" /><span className={LABEL_MID}>{usesHouseStyle ? t('documents.house_style_on', 'House style') : t('documents.house_style_off', 'No house style')}</span>
            </button>
            <SideButtons side={props.side} onSide={props.onSide} canComment={props.canComment} findOpen={props.findOpen} onFind={props.onFind} isDeck={isDeck} />
            <button type="button" className={ICON_BUTTON} onClick={props.onShortcuts} aria-label={t('documents.shortcuts.title', 'Keyboard shortcuts')}><Keyboard size={15} /></button>
            {isPanel && props.onOpenInStudio && (
                <button type="button" onClick={props.onOpenInStudio} className={ICON_BUTTON} aria-label={t('documents.open_in_studio', 'Open in Studio')} title={t('documents.open_in_studio', 'Open in Studio')} data-testid="document-open-in-studio">
                    <Maximize2 size={15} />
                </button>
            )}
            {!isPanel && <TemplateFileButton id={doc.id} name={doc.name} before={props.onBeforeExport} />}
            <Downloads isDeck={isDeck} downloading={props.downloading} onPrint={props.onPrint} onDownload={props.onDownload} />
        </div>
        </div>
    );
}
