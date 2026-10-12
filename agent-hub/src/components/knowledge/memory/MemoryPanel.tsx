import { Lightbulb, ChevronLeft, Plus, CheckSquare, Trash2, Download } from 'lucide-react';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { useTranslation } from '../../../hooks/useTranslation';
import { toast } from '../../shared/Toast';
import useConfirm from '../../shared/useConfirm';
import LoadingState from '../../shared/LoadingState';
import type { MemoryDraft } from './MemoryEditor';
import MemoryEditor from './MemoryEditor';
import MemoryFilters from './MemoryFilters';
import MemoryList from './MemoryList';
import ReviewQueue from './ReviewQueue';
import {
    addableTypes, MEMORY_TYPE_IDS,
    type Memory, type MemoryScope, type MemorySort, type MemoryType, type MemoryView,
} from './memoryTypes';
import { writeFailureMessage } from './memoryErrors';
import { exportMemories, useMemories, useMemoryStats } from './useMemories';

export interface MemoryPanelProps {
    onClose?: () => void;
    projectId?: string;
    /** false for a project VIEWER: project memory is a shared pool, so the role is the only thing between a read-only member and the delete button. */
    canEdit?: boolean;
    embedded?: boolean;
    extractMemories?: boolean;
    /** The person allowed sensitive topics, so the review queue is worth showing even while empty. */
    sensitiveOptIn?: boolean;
    initialView?: MemoryView;
    /** The organisation turned memory off: nothing can be added, only managed and exported. */
    orgMemoryOff?: boolean;
    /** Called after anything that changes the stored memories (the host refreshes its counts). */
    onChanged?: () => void;
}

export default function MemoryPanel({
    onClose, projectId, canEdit = true, embedded = false, extractMemories = true,
    sensitiveOptIn = false, initialView = 'active', orgMemoryOff = false, onChanged,
}: MemoryPanelProps) {
    const { t } = useTranslation();
    const headingId = useId();
    const headingRef = useRef<HTMLHeadingElement>(null);
    const { confirm, confirmDialog } = useConfirm();

    const [requestedView, setView] = useState<MemoryView>(initialView);
    const [scope, setScope] = useState<MemoryScope>(projectId ? 'project' : 'personal');
    const [search, setSearch] = useState('');
    const [type, setType] = useState<MemoryType | 'all'>('all');
    const [sort, setSort] = useState<MemorySort>('recent');
    const [selectMode, setSelectMode] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [editingId, setEditingId] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);

    const { stats, refresh: refreshStats } = useMemoryStats(!projectId);
    const pendingReview = stats?.pendingReview ?? 0;
    const showReview = !projectId && (pendingReview > 0 || sensitiveOptIn);
    const view: MemoryView = requestedView === 'review' && !showReview ? 'active' : requestedView;

    const handleChanged = useCallback(() => { refreshStats(); onChanged?.(); }, [refreshStats, onChanged]);
    const memories = useMemories({ view, scope, projectId, search, type, sort }, handleChanged);
    const { items } = memories;

    // A selection or an open editor must not point at rows that left the view.
    useEffect(() => { setSelected(new Set()); setEditingId(null); }, [view, scope, search, type, sort]);

    // A full-page panel moves focus in on open and hands it back on close.
    useEffect(() => {
        if (embedded) return undefined;
        const previous = document.activeElement as HTMLElement | null;
        headingRef.current?.focus();
        return () => { if (previous && document.contains(previous)) previous.focus(); };
    }, [embedded]);

    const canWriteRow = useCallback((m: Memory) => (m.project_id ? canEdit : true), [canEdit]);
    const writesToProject = scope === 'project' && !!projectId;
    const canAdd = !orgMemoryOff && view === 'active' && (writesToProject ? canEdit : scope === 'personal' || scope === 'all');
    const canClear = view === 'active' && items.length > 0 && (scope === 'personal' || (writesToProject && canEdit));
    const canSelect = view === 'active' && items.some(canWriteRow);
    const filtered = search !== '' || type !== 'all';

    const typeCounts = useMemo(() => {
        if (projectId || !stats?.typeDistribution) return undefined;
        const map: Record<string, number> = {};
        stats.typeDistribution.labels.forEach((label, i) => { map[label] = stats.typeDistribution?.data[i] ?? 0; });
        return map;
    }, [projectId, stats]);

    const fail = (message: string) => toast.error(message);

    const onSaveEdit = async (id: string, draft: MemoryDraft) => {
        const current = items.find((m) => m.id === id);
        const patch: { content?: string; type?: MemoryType; importance?: number } = {};
        if (!current || draft.content !== current.content) patch.content = draft.content;
        if (!current || draft.type !== current.type) patch.type = draft.type;
        if (!current || Math.abs(draft.importance - (current.importance ?? 0.5)) > 1e-6) patch.importance = draft.importance;
        setEditingId(null);
        if (Object.keys(patch).length === 0) return;
        const result = await memories.update(id, patch);
        if (result.ok) toast.success(t('knowledge.memory_saved', 'Memory saved'));
        else fail(writeFailureMessage(t, result, t('knowledge.memory_save_error', 'Could not save this memory. Please try again.')));
    };

    const onDelete = async (id: string) => {
        const ok = await confirm({
            title: t('knowledge.memory_delete_title', 'Delete this memory?'),
            description: t('knowledge.memory_delete_desc', 'It will no longer be used in your chats. This cannot be undone.'),
            confirmLabel: t('knowledge.memory_delete', 'Delete'),
            destructive: true,
        });
        if (!ok) return;
        if (await memories.remove(id)) toast.success(t('knowledge.memory_deleted', 'Memory deleted'));
        else fail(t('knowledge.memory_delete_error', 'Could not delete this memory. Please try again.'));
    };

    const onBulkDelete = async () => {
        const ids = [...selected];
        if (ids.length === 0) return;
        const ok = await confirm({
            title: t('knowledge.memory_bulk_delete_title', 'Delete the selected memories?'),
            description: t('knowledge.memory_bulk_delete_desc', 'They will no longer be used in your chats. This cannot be undone.'),
            confirmLabel: t('knowledge.memory_delete_count', 'Delete {count}', { count: ids.length }),
            destructive: true,
        });
        if (!ok) return;
        if (await memories.bulkRemove(ids)) {
            setSelected(new Set());
            setSelectMode(false);
            toast.success(t('knowledge.memory_bulk_deleted', 'Selected memories deleted'));
        } else {
            fail(t('knowledge.memory_bulk_delete_error', 'Could not delete the selected memories. Please try again.'));
        }
    };

    const onBulkType = async (next: MemoryType) => {
        const ids = [...selected];
        if (ids.length === 0) return;
        if (await memories.bulkType(ids, next)) {
            setSelected(new Set());
            toast.success(t('knowledge.memory_bulk_type_done', 'Type changed'));
            memories.reload();
        } else {
            fail(t('knowledge.memory_bulk_type_error', 'Could not change the type. Please try again.'));
        }
    };

    const onClearAll = async () => {
        const ok = await confirm(writesToProject
            ? {
                title: t('settings.memory_clear_project_title', 'Delete all memories of this project?'),
                description: t('settings.memory_clear_project_desc', 'Every memory in this project will be removed for all members and no longer used in the project\'s chats. Your personal memories are not affected. This cannot be undone.'),
                confirmLabel: t('settings.memory_clear_confirm', 'Delete all'),
                destructive: true,
            }
            : {
                title: t('settings.memory_clear_personal_title', 'Delete all your personal memories?'),
                description: t('settings.memory_clear_personal_desc', 'Every personal memory will be removed and no longer used in your chats. Project memories are not affected. This cannot be undone.'),
                confirmLabel: t('settings.memory_clear_confirm', 'Delete all'),
                destructive: true,
            });
        if (!ok) return;
        if (!(await memories.clearAll(writesToProject ? projectId : undefined))) {
            fail(writesToProject
                ? t('settings.memory_clear_project_error', 'Could not delete this project\'s memories. Please try again.')
                : t('settings.memory_clear_personal_error', 'Could not delete your personal memories. Please try again.'));
        }
    };

    const onCreate = async (draft: MemoryDraft) => {
        const result = await memories.create({ content: draft.content, type: draft.type, ...(writesToProject ? { projectId } : {}) });
        if (result.ok) { setAdding(false); toast.success(t('knowledge.memory_added_toast', 'Memory added')); }
        else fail(writeFailureMessage(t, result, t('knowledge.memory_add_error', 'Could not add this memory. Please try again.')));
    };

    const onRestore = async (id: string) => {
        if (await memories.restore(id)) toast.success(t('knowledge.memory_restored', 'Memory restored'));
        else fail(t('knowledge.memory_restore_error', 'Could not restore this memory. Please try again.'));
    };
    const onApprove = async (id: string) => {
        if (await memories.approve(id)) toast.success(t('knowledge.memory_approved', 'Memory approved'));
        else fail(t('knowledge.memory_review_error', 'Could not update this memory. Please try again.'));
    };
    const onReject = async (id: string) => {
        if (await memories.reject(id)) toast.success(t('knowledge.memory_rejected', 'Memory deleted'));
        else fail(t('knowledge.memory_review_error', 'Could not update this memory. Please try again.'));
    };

    const onExport = async () => {
        try { await exportMemories(); } catch { fail(t('knowledge.memory_export_error', 'Could not export your memories. Please try again.')); }
    };

    const toggleSelect = (id: string) => setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });
    const selectAll = (on: boolean) => setSelected(on ? new Set(items.filter(canWriteRow).map((m) => m.id)) : new Set());

    const emptyDescription = projectId
        ? (extractMemories
            ? t('project_content.memory_auto', 'Useful project facts can be saved from chats. All project members can read them.')
            : t('project_content.memory_manual', 'Automatic memory is off. Editors can add shared project facts here.'))
        : t('knowledge.memory_empty_personal', 'Memories are automatically extracted from conversations. Tell your AI about yourself to start building memory!');

    const errorText = memories.error === 'forbidden'
        ? t('knowledge.memory_load_forbidden', 'You no longer have access to these memories.')
        : t('knowledge.memory_load_error', 'Failed to load memories');

    return (
        <section
            aria-labelledby={headingId}
            data-testid="memory-panel"
            className={`${embedded ? 'max-h-[65vh] min-h-48' : 'h-full'} flex flex-col bg-[var(--bg-primary)]`}
            onKeyDown={(e) => {
                if (e.key !== 'Escape' || embedded || !onClose || e.defaultPrevented) return;
                if ((e.target as HTMLElement).closest?.('[role="dialog"],[role="alertdialog"]')) return;
                onClose();
            }}
        >
            <header className="space-y-4 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                        {onClose && (
                            <button
                                type="button"
                                onClick={onClose}
                                aria-label={t('knowledge.memory_back_to_settings', 'Back to Settings')}
                                title={t('knowledge.memory_back_to_settings', 'Back to Settings')}
                                className="-ml-1 rounded-lg p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                            >
                                <ChevronLeft className="h-5 w-5" aria-hidden="true" />
                            </button>
                        )}
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--bg-tertiary)] text-[var(--accent-primary)]">
                            <Lightbulb className="h-5 w-5" aria-hidden="true" />
                        </div>
                        <div>
                            <h2 id={headingId} ref={headingRef} tabIndex={-1} className="font-semibold text-[var(--text-primary)] outline-none">
                                {projectId ? t('project_content.shared_memory', 'Shared project memory') : t('settings.memory_title', 'Memory')}
                            </h2>
                            <p className="text-xs text-[var(--text-tertiary)]">
                                {t('knowledge.memory_count_stored', '{count} stored', { count: memories.total })}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {canSelect && (
                            <button
                                type="button"
                                aria-pressed={selectMode}
                                onClick={() => { setSelectMode((v) => !v); setSelected(new Set()); }}
                                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium ${selectMode ? 'border-[var(--accent-primary)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)]'}`}
                            >
                                <CheckSquare className="h-4 w-4" aria-hidden="true" />
                                {selectMode ? t('project_content.cancel', 'Cancel') : t('project_content.memory_select', 'Select')}
                            </button>
                        )}
                        {canAdd && (
                            <button
                                type="button"
                                onClick={() => setAdding((v) => !v)}
                                aria-expanded={adding}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent-primary)] px-3.5 py-2 text-sm font-medium text-white"
                            >
                                <Plus className="h-4 w-4" aria-hidden="true" />
                                {t('project_content.memory_add', 'Add memory')}
                            </button>
                        )}
                    </div>
                </div>
                <MemoryFilters
                    view={view}
                    onViewChange={setView}
                    showReview={showReview}
                    pendingReview={pendingReview}
                    scope={scope}
                    onScopeChange={setScope}
                    hasProject={!!projectId}
                    search={search}
                    onSearchChange={setSearch}
                    type={type}
                    onTypeChange={setType}
                    typeCounts={typeCounts}
                    allowedTypes={projectId ? addableTypes(true) : MEMORY_TYPE_IDS}
                    sort={sort}
                    onSortChange={setSort}
                />
            </header>

            {adding && canAdd && (
                <div className="border-b border-[var(--border-default)] bg-[var(--bg-tertiary)] p-4">
                    <div className="mx-auto max-w-2xl">
                        <MemoryEditor
                            initial={{ content: '', type: 'fact', importance: 0.5 }}
                            types={addableTypes(writesToProject)}
                            showImportance={false}
                            onSave={onCreate}
                            onCancel={() => setAdding(false)}
                        />
                    </div>
                </div>
            )}

            <div className="flex-1 overflow-auto p-5">
                <div className="mx-auto max-w-2xl">
                    <LoadingState
                        loading={memories.loading}
                        error={memories.error}
                        errorFallback={() => (
                            <div role="alert" data-testid="memory-load-error" className="space-y-3 py-8 text-center text-[var(--error)]">
                                <p>{errorText}</p>
                                {memories.error === 'failed' && (
                                    <button
                                        type="button"
                                        onClick={memories.reload}
                                        className="rounded-lg border border-[var(--border-default)] px-3 py-1.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                                    >
                                        {t('settings.memory_stats_retry', 'Retry')}
                                    </button>
                                )}
                            </div>
                        )}
                    >
                        {view === 'review' ? (
                            <ReviewQueue
                                items={items}
                                total={memories.total}
                                hasMore={memories.hasMore}
                                loadingMore={memories.loadingMore}
                                onApprove={onApprove}
                                onReject={onReject}
                                onLoadMore={memories.loadMore}
                            />
                        ) : (
                            <MemoryList
                                items={items}
                                total={memories.total}
                                hasMore={memories.hasMore}
                                loadingMore={memories.loadingMore}
                                filtered={filtered}
                                archived={view === 'archived'}
                                embedded={embedded}
                                emptyDescription={emptyDescription}
                                canWriteRow={canWriteRow}
                                showCreator={!!projectId}
                                selectMode={selectMode}
                                selected={selected}
                                editingId={editingId}
                                onToggleSelect={toggleSelect}
                                onSelectAll={selectAll}
                                onEdit={setEditingId}
                                onCancelEdit={() => setEditingId(null)}
                                onSaveEdit={onSaveEdit}
                                onDelete={onDelete}
                                onRestore={onRestore}
                                onBulkDelete={onBulkDelete}
                                onBulkType={onBulkType}
                                onLoadMore={memories.loadMore}
                            />
                        )}
                    </LoadingState>
                </div>
            </div>

            {items.length > 0 && view !== 'review' && (
                <footer className="flex items-center justify-between border-t border-[var(--border-default)] bg-[var(--bg-secondary)] px-5 py-3">
                    {canClear ? (
                        <button
                            type="button"
                            onClick={onClearAll}
                            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-rose-500 hover:bg-rose-500/10"
                        >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            {t('knowledge.memory_clear_all', 'Clear All')}
                        </button>
                    ) : <span />}
                    <button
                        type="button"
                        onClick={onExport}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                    >
                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('knowledge.memory_export_json', 'Export JSON')}
                    </button>
                </footer>
            )}
            {confirmDialog}
        </section>
    );
}
