/**
 * NotebookSources — the notebook's source rail: four clearly named ways to
 * add a source (upload a file, a website URL, pasted text, a meeting note),
 * the upload queue, the list of sources with their status, and a footer that
 * says how many are ready. The list doubles as a drop zone for files.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { CheckSquare, Globe, Mic, Trash2, Type, Upload, type LucideIcon } from 'lucide-react';
import ConfirmDialog from '../../../components/shared/ConfirmDialog';
import EmptyState from '../../../components/shared/EmptyState';
import useTranslation from '../../../hooks/useTranslation';
import SourceActivity from './SourceActivity';
import SourceCard from './sources/SourceCard';
import SourcePreviewModal, { type SourcePreview } from './sources/SourcePreviewModal';
import { AddUrlPanel, MeetingSourcePanel, PasteTextPanel, type MeetingMode } from './sources/AddSourcePanels';
import { SOURCE_META, type SourceRow } from './sources/sourceMeta';

export { SOURCE_META };

type PanelKey = 'file' | 'url' | 'text' | 'meeting';

interface AddOption { key: PanelKey; label: string; desc: string; Icon: LucideIcon }

export interface NotebookSourcesProps {
    sources: SourceRow[];
    onFileUpload: (files: File[]) => void;
    onAddUrl?: (url: string) => void;
    onAddText?: (text: string, name?: string) => void;
    onAddMeeting?: (id: string, opts: { mode: MeetingMode }) => void;
    onDeleteSource?: (id: string) => void;
    onRetrySource?: (id: string) => void;
    onCancelSource?: (id: string) => void;
    onRenameSource?: (id: string, name: string) => void;
    onReorderSources?: (next: SourceRow[]) => void;
    onBulkDelete?: (ids: string[]) => void;
    onPreviewSource?: (id: string) => Promise<{ name?: string; content?: string } | undefined | null>;
    dragOver: boolean;
    setDragOver: (over: boolean) => void;
    totalWords: number;
    readyCount: number;
    showMeetingNotes?: boolean;
    /** A viewer reads the sources (and previews them) but changes nothing. */
    readOnly?: boolean;
    /** The upload queue and the pending removal (hooks/useSourcesPolling). */
    uploads?: React.ComponentProps<typeof SourceActivity>['uploads'];
    pendingDelete?: React.ComponentProps<typeof SourceActivity>['pendingDelete'];
    onUndoDelete?: (() => void) | null;
    onRetryUpload?: ((id: string) => void) | null;
    onDismissUpload?: ((id: string) => void) | null;
}

export default function NotebookSources({
    sources, onFileUpload, onAddUrl, onAddText, onAddMeeting, onDeleteSource,
    onRetrySource, onCancelSource, onRenameSource, onReorderSources, onBulkDelete, onPreviewSource,
    dragOver, setDragOver, totalWords, readyCount, showMeetingNotes = true, readOnly = false,
    uploads = [], pendingDelete = null, onUndoDelete = null, onRetryUpload = null, onDismissUpload = null,
}: NotebookSourcesProps) {
    const { t } = useTranslation();
    const options = useMemo<AddOption[]>(() => {
        const all: AddOption[] = [
            { key: 'file', label: t('notebooks.add_opt_file', 'Upload file'), desc: t('notebooks.src_file_desc', 'PDF, Word, Excel, CSV…'), Icon: Upload },
            { key: 'url', label: t('notebooks.add_opt_url', 'Website'), desc: t('notebooks.src_url_desc', 'Fetch a web page'), Icon: Globe },
            { key: 'text', label: t('notebooks.add_opt_text', 'Paste text'), desc: t('notebooks.src_text_desc', 'Paste any text'), Icon: Type },
            { key: 'meeting', label: t('notebooks.add_opt_meeting', 'Meeting'), desc: t('notebooks.src_notes_desc', 'From a meeting note'), Icon: Mic },
        ];
        return showMeetingNotes ? all : all.filter((o) => o.key !== 'meeting');
    }, [t, showMeetingNotes]);

    const [activePanel, setActivePanel] = useState<Exclude<PanelKey, 'file'> | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // selection (bulk delete)
    const [selectMode, setSelectMode] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(() => new Set());
    const [confirmBulk, setConfirmBulk] = useState(false);
    const [dragId, setDragId] = useState<string | null>(null);
    const [preview, setPreview] = useState<SourcePreview | null>(null);

    const [meetingMode, setMeetingMode] = useState<MeetingMode>(() => {
        try { return localStorage.getItem('nb_meeting_mode') === 'summary' ? 'summary' : 'full'; } catch { return 'full'; }
    });
    const updateMeetingMode = useCallback((m: MeetingMode) => {
        setMeetingMode(m);
        try { localStorage.setItem('nb_meeting_mode', m); } catch { /* storage unavailable: the choice lasts for this visit */ }
    }, []);

    const choose = (key: PanelKey) => {
        if (readOnly) return;
        if (key === 'file') { fileInputRef.current?.click(); return; }
        setActivePanel((prev) => (prev === key ? null : key));
    };

    const toggleSelect = (id: string) => setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });
    const clearSelection = () => { setSelected(new Set()); setSelectMode(false); };
    const doBulkDelete = () => { onBulkDelete?.([...selected]); clearSelection(); setConfirmBulk(false); };

    const openPreview = useCallback(async (source: SourceRow) => {
        setPreview({ name: source.name, loading: true, content: '' });
        try {
            const data = await onPreviewSource?.(source.id);
            setPreview({ name: data?.name || source.name, loading: false, content: data?.content || '' });
        } catch {
            setPreview({ name: source.name, loading: false, content: '', failed: true });
        }
    }, [onPreviewSource]);

    // drag reorder
    const onCardDragStart = (e: React.DragEvent, id: string) => {
        setDragId(id);
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', id); } catch { /* some browsers refuse */ }
    };
    const onCardDragOver = (e: React.DragEvent) => { if (dragId) e.preventDefault(); };
    const onCardDrop = (e: React.DragEvent, targetId: string) => {
        if (!dragId || dragId === targetId) { setDragId(null); return; }
        e.preventDefault(); e.stopPropagation();
        const arr = sources.slice();
        const from = arr.findIndex((s) => s.id === dragId);
        const to = arr.findIndex((s) => s.id === targetId);
        if (from < 0 || to < 0) { setDragId(null); return; }
        const [moved] = arr.splice(from, 1);
        arr.splice(to, 0, moved);
        onReorderSources?.(arr);
        setDragId(null);
    };

    const allReady = sources.length > 0 && readyCount === sources.length;

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="shrink-0 px-3 py-2 border-b flex items-center justify-between border-[var(--border-subtle)]">
                <h2 className="m-0 text-xs font-bold tracking-wide uppercase text-[var(--text-secondary)]">{t('notebooks.sources', 'Sources')}</h2>
                <div className="flex items-center gap-1.5">
                    {sources.length > 0 && (
                        <>
                            {!readOnly && (
                                <button
                                    type="button"
                                    onClick={() => { setSelectMode((v) => !v); setSelected(new Set()); }}
                                    aria-pressed={selectMode}
                                    className={`p-1 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors ${selectMode ? 'text-[var(--accent-primary)]' : 'text-[var(--text-tertiary)]'}`}
                                    title={t('notebooks.select_multiple', 'Select multiple')}
                                    aria-label={t('notebooks.select_multiple', 'Select multiple')}
                                >
                                    <CheckSquare className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                            )}
                            <span
                                className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]"
                                title={t('notebooks.n_of_m_ready', { ready: readyCount, total: sources.length })}
                            >
                                {readyCount}<span className="opacity-50">/{sources.length}</span>
                            </span>
                        </>
                    )}
                </div>
            </div>

            {/* Add a source */}
            {!readOnly && (
                <div className="shrink-0 px-3 pt-2.5 pb-2">
                    <div className="grid grid-cols-2 gap-1.5" role="group" aria-label={t('notebooks.add_source_group', 'Add a source')}>
                        {options.map(({ key, label, desc, Icon }) => {
                            const active = activePanel === key;
                            return (
                                <button
                                    key={key}
                                    type="button"
                                    onClick={() => choose(key)}
                                    aria-expanded={key === 'file' ? undefined : active}
                                    title={desc}
                                    className={`flex items-center gap-2 min-w-0 px-2 py-1.5 rounded-xl border text-left transition-colors ${
                                        active
                                            ? 'border-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_8%,var(--bg-secondary))] text-[var(--text-primary)]'
                                            : 'border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[var(--border-default)] hover:text-[var(--text-primary)]'
                                    }`}
                                >
                                    <span className="shrink-0 w-6 h-6 rounded-lg flex items-center justify-center bg-[var(--bg-tertiary)]" aria-hidden="true">
                                        <Icon className="w-3.5 h-3.5" />
                                    </span>
                                    {/* The rail is narrow: the label alone, its description as the tooltip. */}
                                    <span className="min-w-0 text-xs font-semibold truncate">{label}</span>
                                </button>
                            );
                        })}
                    </div>
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.json"
                        className="hidden"
                        tabIndex={-1}
                        aria-hidden="true"
                        onChange={(e) => { onFileUpload(Array.from(e.target.files || [])); e.target.value = ''; }}
                    />
                </div>
            )}

            <SourceActivity
                uploads={uploads}
                pendingDelete={pendingDelete}
                onUndoDelete={() => onUndoDelete?.()}
                onRetryUpload={(id: string) => onRetryUpload?.(id)}
                onDismissUpload={(id: string) => onDismissUpload?.(id)}
            />

            {activePanel === 'url' && (
                <AddUrlPanel onSubmit={(u) => { onAddUrl?.(u); setActivePanel(null); }} onClose={() => setActivePanel(null)} />
            )}
            {activePanel === 'text' && (
                <PasteTextPanel onSubmit={(body, name) => { onAddText?.(body, name); setActivePanel(null); }} onClose={() => setActivePanel(null)} />
            )}
            {activePanel === 'meeting' && (
                <MeetingSourcePanel
                    mode={meetingMode}
                    onChangeMode={updateMeetingMode}
                    onAddMeeting={(id) => { onAddMeeting?.(id, { mode: meetingMode }); setActivePanel(null); }}
                    onClose={() => setActivePanel(null)}
                />
            )}

            {/* Bulk action bar */}
            {selectMode && selected.size > 0 && (
                <div className="shrink-0 mx-3 mb-2 flex items-center justify-between px-3 py-1.5 rounded-lg bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]">
                    <span className="text-[11px] font-semibold" role="status">{t('notebooks.n_selected', { count: selected.size })}</span>
                    <div className="flex items-center gap-2">
                        <button type="button" onClick={() => setConfirmBulk(true)} className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-md bg-black/15 hover:bg-black/25 transition-colors">
                            <Trash2 className="w-3 h-3" aria-hidden="true" /> {t('notebooks.delete', 'Delete')}
                        </button>
                        <button type="button" onClick={clearSelection} className="text-[11px] font-medium px-2 py-1 rounded-md hover:bg-black/15 transition-colors">{t('common.cancel', 'Cancel')}</button>
                    </div>
                </div>
            )}

            {/* Source list (scrollable, file drop zone) */}
            <div
                data-testid="sources-dropzone"
                className={`flex-1 min-h-0 overflow-y-auto custom-scrollbar space-y-1.5 mx-2 mb-2 rounded-xl border-2 border-dashed transition-colors ${
                    dragOver
                        ? 'p-2 border-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_8%,transparent)]'
                        : 'px-1 py-1 border-[var(--border-subtle)] bg-transparent'
                }`}
                onDragOver={(e) => { if (!dragId && !readOnly) { e.preventDefault(); setDragOver(true); } }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false); }}
                onDrop={(e) => {
                    if (!readOnly && e.dataTransfer.files?.length) {
                        e.preventDefault();
                        setDragOver(false);
                        onFileUpload(Array.from(e.dataTransfer.files));
                    }
                }}
            >
                {sources.length === 0 && readOnly ? (
                    <p className="m-0 py-7 px-2 text-center text-xs text-[var(--text-tertiary)]" data-testid="sources-empty-readonly">
                        {t('notebooks.sources_empty_readonly', 'This notebook has no sources yet.')}
                    </p>
                ) : sources.length === 0 ? (
                    <EmptyState
                        icon={<Upload className="w-7 h-7" aria-hidden="true" />}
                        title={<span className="text-sm">{t('notebooks.add_first_source', 'Add your first source')}</span>}
                        description={<span className="text-xs">{t('notebooks.sources_empty_hint2', 'Sources power the AI chat & citations. Drag & drop a file here, or pick a type above.')}</span>}
                        action={{ label: t('notebooks.add_opt_file', 'Upload file'), onClick: () => choose('file'), icon: <Upload className="w-3.5 h-3.5" aria-hidden="true" /> }}
                    />
                ) : (
                    sources.map((source) => (
                        <SourceCard
                            key={source.id}
                            source={source}
                            onDelete={onDeleteSource}
                            onRetry={onRetrySource}
                            onCancel={onCancelSource}
                            onPreview={openPreview}
                            onRename={onRenameSource}
                            selectable={selectMode}
                            selected={selected.has(source.id)}
                            onToggleSelect={toggleSelect}
                            onDragStart={onCardDragStart}
                            onDragOver={onCardDragOver}
                            onDrop={onCardDrop}
                            dragging={dragId === source.id}
                            readOnly={readOnly}
                        />
                    ))
                )}
            </div>

            {/* Footer stats */}
            {sources.length > 0 && (
                <div className="shrink-0 px-3 pb-2.5 space-y-1.5">
                    <progress
                        value={readyCount}
                        max={sources.length}
                        aria-label={t('notebooks.n_of_m_ready', { ready: readyCount, total: sources.length })}
                        className={`block w-full h-1 rounded-full overflow-hidden appearance-none [&::-webkit-progress-bar]:bg-[var(--bg-tertiary)] ${
                            allReady
                                ? '[&::-webkit-progress-value]:bg-[var(--success)] [&::-moz-progress-bar]:bg-[var(--success)]'
                                : '[&::-webkit-progress-value]:bg-[var(--accent-primary)] [&::-moz-progress-bar]:bg-[var(--accent-primary)]'
                        } bg-[var(--bg-tertiary)]`}
                    />
                    <div className="flex items-center justify-between text-[11px] text-[var(--text-tertiary)]">
                        <span className="font-medium">
                            {allReady
                                ? t('notebooks.all_n_sources_ready', { count: sources.length })
                                : t('notebooks.n_of_m_ready', { ready: readyCount, total: sources.length })}
                        </span>
                        <span>{t('notebooks.n_words', { count: totalWords.toLocaleString() })}</span>
                    </div>
                </div>
            )}

            {preview && <SourcePreviewModal preview={preview} onClose={() => setPreview(null)} />}
            <ConfirmDialog
                open={confirmBulk}
                title={t('notebooks.confirm_bulk_delete_title', 'Delete sources?')}
                description={t('notebooks.confirm_bulk_delete_body', { count: selected.size })}
                confirmLabel={t('notebooks.delete', 'Delete')}
                cancelLabel={t('common.cancel', 'Cancel')}
                destructive
                onConfirm={doBulkDelete}
                onCancel={() => setConfirmBulk(false)}
            />
        </div>
    );
}
