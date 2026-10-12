import { Lightbulb, Trash2, RotateCcw } from 'lucide-react';
import React from 'react';

import { useTranslation } from '../../../hooks/useTranslation';
import EmptyState from '../../shared/EmptyState';
import Spinner from '../../shared/Spinner';
import MemoryRow from './MemoryRow';
import type { MemoryDraft } from './MemoryEditor';
import { MEMORY_TYPE_IDS, isMemoryType, typeSingularLabel, type Memory, type MemoryType } from './memoryTypes';

interface MemoryListProps {
    items: Memory[];
    total: number;
    hasMore: boolean;
    loadingMore: boolean;
    filtered: boolean;
    archived: boolean;
    embedded: boolean;
    emptyDescription: string;
    /** Whether the person may change a row (a project viewer may not). */
    canWriteRow: (m: Memory) => boolean;
    showCreator: boolean;
    selectMode: boolean;
    selected: ReadonlySet<string>;
    editingId: string | null;
    onToggleSelect: (id: string) => void;
    onSelectAll: (select: boolean) => void;
    onEdit: (id: string) => void;
    onCancelEdit: () => void;
    onSaveEdit: (id: string, draft: MemoryDraft) => void;
    onDelete: (id: string) => void;
    onRestore: (id: string) => void;
    onBulkDelete: () => void;
    onBulkType: (type: MemoryType) => void;
    onLoadMore: () => void;
}

export default function MemoryList(props: MemoryListProps) {
    const {
        items, total, hasMore, loadingMore, filtered, archived, embedded, emptyDescription, canWriteRow, showCreator,
        selectMode, selected, editingId, onToggleSelect, onSelectAll, onEdit, onCancelEdit, onSaveEdit, onDelete,
        onRestore, onBulkDelete, onBulkType, onLoadMore,
    } = props;
    const { t } = useTranslation();
    const [bulkType, setBulkType] = React.useState<MemoryType>('fact');

    if (items.length === 0) {
        return (
            <EmptyState
                className={embedded ? '!py-6' : ''}
                icon={<Lightbulb className="h-8 w-8" />}
                title={filtered
                    ? t('knowledge.memory_no_memories_match_your_filter', 'No memories match your filter')
                    : archived
                        ? t('knowledge.memory_archived_empty', 'Nothing archived')
                        : t('project_content.memory_empty', 'No memories yet')}
                description={filtered ? undefined : archived
                    ? t('knowledge.memory_archived_empty_desc', 'Memories that were replaced or retired show up here, and you can restore them.')
                    : emptyDescription}
            />
        );
    }

    const writable = items.filter(canWriteRow);
    const allSelected = writable.length > 0 && writable.every((m) => selected.has(m.id));

    return (
        <div className="space-y-3">
            {selectMode && (
                <div
                    role="toolbar"
                    aria-label={t('knowledge.memory_bulk_toolbar', 'Actions for the selected memories')}
                    className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-4 py-2.5"
                >
                    <label className="flex items-center gap-2 text-xs font-medium text-[var(--text-primary)]">
                        <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={(e) => onSelectAll(e.target.checked)}
                            className="h-4 w-4 accent-[var(--accent-primary)]"
                        />
                        {t('knowledge.memory_select_all', 'Select all')}
                    </label>
                    <span className="text-xs text-[var(--text-tertiary)]" aria-live="polite">
                        {t('knowledge.memory_selected', '{count} selected', { count: selected.size })}
                    </span>
                    {selected.size > 0 && (
                        <div className="ml-auto flex flex-wrap items-center gap-2">
                            <label className="sr-only" htmlFor="memory-bulk-type">{t('knowledge.memory_bulk_type_label', 'New type for the selected memories')}</label>
                            <select
                                id="memory-bulk-type"
                                value={bulkType}
                                onChange={(e) => { if (isMemoryType(e.target.value)) setBulkType(e.target.value); }}
                                className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)]"
                            >
                                {MEMORY_TYPE_IDS.map((id) => <option key={id} value={id}>{typeSingularLabel(t, id)}</option>)}
                            </select>
                            <button
                                type="button"
                                onClick={() => onBulkType(bulkType)}
                                className="rounded-lg border border-[var(--border-default)] px-3 py-1 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)]"
                            >
                                {t('knowledge.memory_change_type', 'Change type')}
                            </button>
                            <button
                                type="button"
                                onClick={onBulkDelete}
                                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium text-rose-500 hover:bg-rose-500/10"
                            >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                {t('knowledge.memory_delete_selected', 'Delete selected')}
                            </button>
                        </div>
                    )}
                </div>
            )}
            <ul className="space-y-2" aria-label={t('knowledge.memory_list_label', 'Memories')}>
                {items.map((m) => (
                    <MemoryRow
                        key={m.id}
                        memory={m}
                        canWrite={canWriteRow(m)}
                        selectMode={selectMode}
                        selected={selected.has(m.id)}
                        editing={editingId === m.id}
                        showCreator={showCreator}
                        onToggleSelect={onToggleSelect}
                        onEdit={onEdit}
                        onDelete={onDelete}
                        onSaveEdit={onSaveEdit}
                        onCancelEdit={onCancelEdit}
                        actions={archived && canWriteRow(m) ? (
                            <button
                                type="button"
                                onClick={() => onRestore(m.id)}
                                className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-2.5 py-1 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                            >
                                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                                {t('knowledge.memory_restore', 'Restore')}
                                <span className="sr-only">{`: ${m.content.slice(0, 40)}`}</span>
                            </button>
                        ) : undefined}
                    />
                ))}
            </ul>
            {hasMore && (
                <div className="flex justify-center pt-2">
                    <button
                        type="button"
                        onClick={onLoadMore}
                        disabled={loadingMore}
                        className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] disabled:opacity-50"
                    >
                        {loadingMore && <Spinner size="xs" />}
                        {loadingMore
                            ? t('knowledge.memory_loading_more', 'Loading…')
                            : t('knowledge.memory_load_more', 'Load more ({count} remaining)', { count: total - items.length })}
                    </button>
                </div>
            )}
        </div>
    );
}
