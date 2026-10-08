/**
 * SourceCard — one source in the notebook's rail, with its status said in
 * words: still processing (which stage, with a way to cancel), ready (with
 * its word count), or failed (with the server's own message and Retry /
 * Remove in plain sight, not behind a hover).
 */
import React, { useEffect, useRef, useState } from 'react';
import {
    AlertCircle, Check, ChevronDown, ChevronUp, Copy, Eye, GripVertical, Loader2, Pencil, RotateCw, Trash2, XCircle,
} from 'lucide-react';
import useTranslation from '../../../../hooks/useTranslation';
import { metaFor, stageText, type SourceRow } from './sourceMeta';

export interface SourceCardProps {
    source: SourceRow;
    onDelete?: (id: string) => void;
    onRetry?: (id: string) => void;
    onCancel?: (id: string) => void;
    onPreview?: (source: SourceRow) => void;
    onRename?: (id: string, name: string) => void;
    selectable?: boolean;
    selected?: boolean;
    onToggleSelect?: (id: string) => void;
    onDragStart?: (e: React.DragEvent, id: string) => void;
    onDragOver?: (e: React.DragEvent, id: string) => void;
    onDrop?: (e: React.DragEvent, id: string) => void;
    dragging?: boolean;
    readOnly?: boolean;
}

const ICON_BTN = 'p-1 rounded-lg text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] transition-colors';

export default function SourceCard({
    source, onDelete, onRetry, onCancel, onPreview, onRename,
    selectable = false, selected = false, onToggleSelect,
    onDragStart, onDragOver, onDrop, dragging = false, readOnly = false,
}: SourceCardProps) {
    const { t } = useTranslation();
    const meta = metaFor(source.type);
    const { Icon } = meta;
    const isProcessing = source.status === 'processing';
    const isError = source.status === 'error';
    const isReady = source.status === 'ready';
    const isDuplicate = isReady && !!source.metadata?.duplicate;
    const [showDetails, setShowDetails] = useState(false);
    const [editing, setEditing] = useState(false);
    // Removing asks once, in place ("Remove?" → Remove / Keep); the removal
    // itself can still be undone for a few seconds.
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [draft, setDraft] = useState(source.name);
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => { setDraft(source.name); }, [source.name]);
    useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

    // File + url sources retry from stored bytes/URL; text/meeting retry from
    // stored extracted text (hasContent).
    const canRetry = isError && !readOnly && (source.type === 'url' || !!source.storageKey || !!source.hasContent);
    const canPreview = !!source.hasContent;
    const errorText = typeof source.error === 'string' ? source.error.trim() : '';
    const longError = errorText.length > 90 || errorText.includes('\n');

    const commitRename = () => {
        setEditing(false);
        const v = draft.trim();
        if (v && v !== source.name) onRename?.(source.id, v);
        else setDraft(source.name);
    };

    let border = 'border-[var(--border-subtle)]';
    if (selected) border = 'border-[var(--accent-primary)]';
    else if (isError) border = 'border-[color-mix(in_srgb,var(--error)_40%,transparent)]';
    else if (isProcessing) border = 'border-[color-mix(in_srgb,var(--warning)_35%,transparent)]';

    return (
        <div
            draggable={!editing && !readOnly}
            onDragStart={(e) => onDragStart?.(e, source.id)}
            onDragOver={(e) => onDragOver?.(e, source.id)}
            onDrop={(e) => onDrop?.(e, source.id)}
            data-testid="source-card"
            data-status={source.status}
            className={`group relative flex items-start gap-2 p-2.5 rounded-xl border transition-all hover:shadow-sm ${border} ${
                selected ? 'bg-[color-mix(in_srgb,var(--accent-primary)_6%,var(--bg-primary))]' : 'bg-[var(--bg-primary)]'
            } ${dragging ? 'opacity-40' : ''}`}
        >
            {/* drag handle / select checkbox */}
            <div className="shrink-0 flex flex-col items-center pt-0.5">
                {selectable ? (
                    <button
                        type="button"
                        role="checkbox"
                        aria-checked={selected}
                        aria-label={t('notebooks.select_source', 'Select {name}', { name: source.name })}
                        onClick={(e) => { e.stopPropagation(); onToggleSelect?.(source.id); }}
                        className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                            selected ? 'bg-[var(--accent-primary)] border-[var(--accent-primary)]' : 'border-[var(--border-default)]'
                        }`}
                    >
                        {selected && <Check className="w-3 h-3 text-[var(--accent-primary-fg)]" aria-hidden="true" />}
                    </button>
                ) : (
                    !readOnly && (
                        <span className="cursor-grab opacity-0 group-hover:opacity-60 transition-opacity" title={t('notebooks.drag_to_reorder', 'Drag to reorder')}>
                            <GripVertical className="w-3.5 h-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />
                        </span>
                    )
                )}
            </div>

            {/* Type tile */}
            <div className={`shrink-0 w-7 h-7 rounded-lg flex items-center justify-center ${meta.tone}`} aria-hidden="true">
                <Icon className="w-3.5 h-3.5" />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
                {editing ? (
                    <input
                        ref={inputRef}
                        value={draft}
                        aria-label={t('notebooks.rename_source', 'Source name')}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename();
                            if (e.key === 'Escape') { setDraft(source.name); setEditing(false); }
                        }}
                        className="w-full text-xs font-semibold px-1 py-0.5 rounded border outline-none bg-[var(--bg-secondary)] border-[var(--accent-primary)] text-[var(--text-primary)]"
                    />
                ) : (
                    <button
                        type="button"
                        onClick={() => canPreview && onPreview?.(source)}
                        onDoubleClick={() => { if (!readOnly) setEditing(true); }}
                        className={`block w-full text-left text-xs font-semibold truncate leading-tight text-[var(--text-primary)] ${
                            canPreview ? 'cursor-pointer hover:underline' : 'cursor-default'
                        }`}
                        title={source.name}
                    >
                        {source.name}
                    </button>
                )}

                <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide ${meta.tone}`}>
                        {t(meta.labelKey, meta.label)}
                    </span>
                    {isProcessing && (
                        <span className="flex items-center gap-1 text-[11px] font-medium text-[var(--warning-ink)]" role="status">
                            <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                            {stageText(t, source.stage)}
                        </span>
                    )}
                    {isReady && (source.wordCount ?? 0) > 0 && (
                        <span className="flex items-center gap-1 text-[11px] text-[var(--text-tertiary)]">
                            <Check className="w-3 h-3 text-[var(--success)]" aria-hidden="true" />
                            {t('notebooks.n_words', { count: (source.wordCount ?? 0).toLocaleString() })}
                        </span>
                    )}
                    {isDuplicate && (
                        <span
                            className="flex items-center gap-1 text-[10px] font-medium px-1 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]"
                            title={t('notebooks.duplicate_title', 'Duplicate of an existing source')}
                        >
                            <Copy className="w-2.5 h-2.5" aria-hidden="true" /> {t('notebooks.duplicate', 'Duplicate')}
                        </span>
                    )}
                    {isError && (
                        <span className="flex items-center gap-1 text-[11px] font-medium text-[var(--error-ink)]">
                            <AlertCircle className="w-3 h-3" aria-hidden="true" /> {t('notebooks.failed', 'Failed')}
                        </span>
                    )}
                </div>

                {isError && errorText && (
                    <div className="mt-1" role="alert">
                        <p className={`m-0 text-[11px] leading-snug text-[var(--error-ink)] break-words ${showDetails ? 'whitespace-pre-wrap max-h-32 overflow-auto' : 'line-clamp-2'}`}>
                            {errorText}
                        </p>
                        {longError && (
                            <button
                                type="button"
                                onClick={() => setShowDetails((v) => !v)}
                                aria-expanded={showDetails}
                                className="mt-0.5 flex items-center gap-0.5 text-[10px] font-medium text-[var(--error-ink)] hover:underline"
                            >
                                {showDetails ? <ChevronUp className="w-2.5 h-2.5" aria-hidden="true" /> : <ChevronDown className="w-2.5 h-2.5" aria-hidden="true" />}
                                {showDetails ? t('notebooks.hide_details', 'Hide details') : t('notebooks.show_details', 'Show details')}
                            </button>
                        )}
                    </div>
                )}

                {(canRetry || (isProcessing && onCancel && !readOnly)) && (
                    <div className="flex items-center gap-1.5 mt-1.5">
                        {canRetry && (
                            <button
                                type="button"
                                onClick={() => onRetry?.(source.id)}
                                className="flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-md bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] hover:opacity-90"
                                title={t('notebooks.retry_ingestion', 'Retry ingestion')}
                            >
                                <RotateCw className="w-3 h-3" aria-hidden="true" /> {t('notebooks.retry', 'Retry')}
                            </button>
                        )}
                        {isProcessing && onCancel && !readOnly && (
                            <button
                                type="button"
                                onClick={() => onCancel(source.id)}
                                className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--error-ink)]"
                                title={t('notebooks.cancel_ingestion', 'Cancel ingestion')}
                            >
                                <XCircle className="w-3 h-3" aria-hidden="true" /> {t('common.cancel', 'Cancel')}
                            </button>
                        )}
                    </div>
                )}

                {isProcessing && (
                    <div className="mt-1.5 h-0.5 rounded-full overflow-hidden bg-[var(--bg-tertiary)]" aria-hidden="true">
                        <div className="h-full w-1/2 rounded-full animate-pulse bg-[var(--warning)]" />
                    </div>
                )}
            </div>

            {/* Actions. focus-within keeps them reachable by keyboard; a failed
                source keeps them visible, since that is when you need them. */}
            {!selectable && confirmingDelete && (
                <div className="shrink-0 flex items-center gap-1" role="group" aria-label={t('notebooks.remove_source_confirm', 'Remove this source?')} data-testid="source-confirm-delete">
                    <button
                        type="button"
                        onClick={() => { setConfirmingDelete(false); onDelete?.(source.id); }}
                        className="px-1.5 py-0.5 rounded-md text-[11px] font-semibold text-[var(--error-ink)] hover:bg-[var(--bg-tertiary)]"
                        autoFocus
                    >
                        {t('notebooks.remove', 'Remove')}
                    </button>
                    <button type="button" onClick={() => setConfirmingDelete(false)} className="px-1.5 py-0.5 rounded-md text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
                        {t('notebooks.keep', 'Keep')}
                    </button>
                </div>
            )}
            {/* A failed source keeps its actions in the row; otherwise they float
                over the card's corner on hover or focus, so the narrow rail gives
                the name and the word count the whole width. */}
            {!selectable && !confirmingDelete && (
                <div className={isError
                    ? 'shrink-0 flex items-center gap-0.5'
                    : 'absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] shadow-sm transition-opacity opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto'}>
                    {canPreview && (
                        <button type="button" onClick={() => onPreview?.(source)} className={ICON_BTN} title={t('notebooks.preview', 'Preview')} aria-label={t('notebooks.preview', 'Preview')}>
                            <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                    )}
                    {!readOnly && (
                        <>
                            <button type="button" onClick={() => setEditing(true)} className={ICON_BTN} title={t('notebooks.rename', 'Rename')} aria-label={t('notebooks.rename', 'Rename')}>
                                <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                            <button
                                type="button"
                                onClick={() => setConfirmingDelete(true)}
                                className="p-1 rounded-lg text-[var(--text-tertiary)] hover:bg-[color-mix(in_srgb,var(--error)_12%,transparent)] hover:text-[var(--error-ink)] transition-colors"
                                title={t('notebooks.remove_source', 'Remove source')}
                                aria-label={t('notebooks.remove_source', 'Remove source')}
                            >
                                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
