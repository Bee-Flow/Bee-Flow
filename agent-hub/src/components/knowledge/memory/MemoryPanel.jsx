import {
    Bookmark, User, Folder, Settings as SettingsIcon, Workflow, FileText, Building2,
    Lightbulb, CheckSquare, Plus, X, Search, Edit2, Trash2, Download, ChevronLeft, AlertTriangle,
} from 'lucide-react';
import React, { useState, useEffect, useCallback } from 'react';

import { useTranslation } from '../../../hooks/useTranslation';
import { formatRelativeTime } from '../../../utils/dateFormatters';
import { API_BASE, authFetch } from '../../../utils/helpers';
import ConfirmDialog from '../../shared/ConfirmDialog';

const PAGE_SIZE = 50;

// A 403 means the pool is no longer ours (project role changed, membership
// revoked); anything else is a transient failure worth retrying as-is.
const loadErrorFor = (status) => (status === 403
    ? 'You no longer have access to these memories.'
    : 'Failed to load memories');

/**
 * @param {boolean} [canEdit=true] — false for a project VIEWER. Project memory
 *   is a shared pool: the store drops its user_id filter for project-scoped
 *   rows so every member sees the same entries, which means the role check is
 *   the only thing between a read-only member and the delete button. The API
 *   now enforces editor for writes; this hides the controls so a viewer is not
 *   offered actions that will come back 403.
 */
const MemoryPanel = ({ onClose, projectId, canEdit = true, embedded = false, extractMemories = true }) => {
    const { t } = useTranslation();
    const [memories, setMemories] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState(null);
    const [editingId, setEditingId] = useState(null);
    const [editContent, setEditContent] = useState('');
    const [showAddForm, setShowAddForm] = useState(false);
    const [newMemory, setNewMemory] = useState({ content: '', type: 'fact' });
    const [filterType, setFilterType] = useState('all');
    const [searchTerm, setSearchTerm] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [isSelectMode, setIsSelectMode] = useState(false);
    const [total, setTotal] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    // A mutation that failed. Delete, edit, add, clear and export used to act
    // only `if (res.ok)`, so a 403 or a 500 produced no feedback at all — the
    // row simply stayed put.
    const [actionError, setActionError] = useState(null);
    // The pending destructive action, confirmed through the app's own dialog
    // rather than window.confirm:
    //   { kind: 'delete', id } | { kind: 'bulk', count } | { kind: 'clear' }
    const [confirmAction, setConfirmAction] = useState(null);
    // Full per-type distribution across ALL memories (filter-independent), used to
    // decide which filter chips to show. Derived from the loaded list it would
    // collapse to only the selected type once a filter is active (BFSF-180).
    const [allTypeCounts, setAllTypeCounts] = useState({});
    // For project-scoped panel we still fetch the full list and filter client-side
    // (project memory backlogs are small and the API doesn't paginate that path).
    const isPaginated = !projectId;

    // Debounce the search input so we don't refetch on every keystroke.
    useEffect(() => {
        const t = setTimeout(() => setDebouncedSearch(searchTerm.trim()), 300);
        return () => clearTimeout(t);
    }, [searchTerm]);

    const fetchMemories = useCallback(async ({ append = false, offset = 0 } = {}) => {
        try {
            if (append) setLoadingMore(true); else setLoading(true);
            // Reset on every attempt: the render checks `error` before the
            // list, so a sticky error hid every later successful fetch until
            // the panel was remounted.
            setError(null);
            const params = new URLSearchParams();
            if (projectId) {
                params.set('projectId', projectId);
            } else {
                params.set('limit', String(PAGE_SIZE));
                params.set('offset', String(offset));
                if (debouncedSearch) params.set('search', debouncedSearch);
                if (filterType !== 'all') params.set('type', filterType);
            }
            const url = `${API_BASE}/agents/memory?${params.toString()}`;
            const res = await authFetch(url);
            if (!res.ok) {
                // A 403 body has no `.memories`; falling through the `if`
                // below left the previous list on screen with no error shown.
                // Access gone: drop the stale rows too, so the footer's
                // Export / Clear All do not linger behind the error.
                setError(loadErrorFor(res.status));
                if (res.status === 403 && !append) { setMemories([]); setTotal(0); setHasMore(false); }
                return;
            }
            const data = await res.json();
            if (data.memories) {
                setMemories(prev => append ? [...prev, ...data.memories] : data.memories);
                if (isPaginated) {
                    setTotal(typeof data.total === 'number' ? data.total : data.memories.length);
                    setHasMore(!!data.hasMore);
                } else {
                    setTotal(data.memories.length);
                    setHasMore(false);
                }
            }
        } catch (err) {
            setError('Failed to load memories');
            console.error(err);
        } finally {
            setLoading(false);
            setLoadingMore(false);
        }
    }, [projectId, debouncedSearch, filterType, isPaginated]);

    // Reload from the top whenever filter/search changes.
    useEffect(() => {
        fetchMemories({ append: false, offset: 0 });
        // Reset selection so it doesn't reference items no longer in view.
        setSelectedIds(new Set());
    }, [fetchMemories]);

    // Fetch the full type distribution (filter-independent) for the global panel.
    // Re-run explicitly after add/delete/clear (each adjusts the count) rather
    // than keyed on `total`, which fetched twice on mount and raced the next
    // request. The project panel already holds the full client-side list.
    const fetchStats = useCallback(async () => {
        if (projectId) return;
        try {
            const res = await authFetch(`${API_BASE}/agents/memory/stats`);
            if (!res.ok) return;
            const data = await res.json();
            const labels = data?.typeDistribution?.labels || [];
            const counts = data?.typeDistribution?.data || [];
            const map = {};
            labels.forEach((label, i) => { map[label] = counts[i] || 0; });
            setAllTypeCounts(map);
        } catch (_) { /* non-fatal: chips fall back to loaded counts */ }
    }, [projectId]);

    useEffect(() => { fetchStats(); }, [fetchStats]);

    const handleLoadMore = () => {
        if (!hasMore || loadingMore) return;
        fetchMemories({ append: true, offset: memories.length });
    };

    // Destructive actions ask first, in the app's own dialog (see the
    // ConfirmDialog at the bottom), and run only once the user confirms.
    const requestDelete = (id) => setConfirmAction({ kind: 'delete', id });
    const requestBulkDelete = () => {
        if (selectedIds.size === 0) return;
        setConfirmAction({ kind: 'bulk', count: selectedIds.size });
    };
    const requestClearAll = () => setConfirmAction({ kind: 'clear' });

    const performDelete = async (id) => {
        try {
            const res = await authFetch(`${API_BASE}/agents/memory/${id}`, {
                method: 'DELETE'
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setMemories(prev => prev.filter(m => m.id !== id));
            setTotal(t => Math.max(0, t - 1));
            fetchStats();
        } catch (err) {
            console.error('Failed to delete memory:', err);
            setActionError('Could not delete this memory. Please try again.');
        }
    };

    const performBulkDelete = async () => {
        if (selectedIds.size === 0) return;
        try {
            const res = await authFetch(`${API_BASE}/agents/memory/bulk-delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: Array.from(selectedIds) })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const deletedCount = selectedIds.size;
            setMemories(prev => prev.filter(m => !selectedIds.has(m.id)));
            setSelectedIds(new Set());
            setIsSelectMode(false);
            setTotal(t => Math.max(0, t - deletedCount));
            fetchStats();
        } catch (err) {
            console.error('Failed to bulk delete memories:', err);
            setActionError('Could not delete the selected memories. Please try again.');
        }
    };

    // Clear All clears the pool on the screen. Without a body /clear is the
    // PERSONAL clear, so the project tab used to wipe the member's personal
    // memory and leave the project's pool standing; it names the project now.
    const performClearAll = async () => {
        try {
            const res = await authFetch(`${API_BASE}/agents/memory/clear`, projectId
                ? {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ projectId }),
                }
                : { method: 'POST' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setMemories([]);
            setTotal(0);
            setHasMore(false);
            fetchStats();
        } catch (err) {
            console.error('Failed to clear memories:', err);
            setActionError(projectId
                ? t('settings.memory_clear_project_error', 'Could not delete this project\'s memories. Please try again.')
                : t('settings.memory_clear_personal_error', 'Could not delete your personal memories. Please try again.'));
        }
    };

    const runConfirmedAction = async () => {
        const action = confirmAction;
        if (!action) return;
        setActionError(null);
        if (action.kind === 'delete') await performDelete(action.id);
        else if (action.kind === 'bulk') await performBulkDelete();
        else if (action.kind === 'clear') await performClearAll();
        setConfirmAction(null);
    };

    const confirmCopy = (() => {
        if (!confirmAction) return { title: '', description: '', confirmLabel: 'Delete' };
        if (confirmAction.kind === 'bulk') {
            const n = confirmAction.count;
            return {
                title: `Delete ${n} selected ${n === 1 ? 'memory' : 'memories'}?`,
                description: 'They will no longer be used in your chats. This cannot be undone.',
                confirmLabel: `Delete ${n}`,
            };
        }
        if (confirmAction.kind === 'clear') {
            // Say whose memory goes: "Delete all memories?" read the same in
            // Settings and in a project, and cleared the personal one in both.
            return projectId
                ? {
                    title: t('settings.memory_clear_project_title', 'Delete all memories of this project?'),
                    description: t('settings.memory_clear_project_desc', 'Every memory in this project will be removed for all members and no longer used in the project\'s chats. Your personal memories are not affected. This cannot be undone.'),
                    confirmLabel: t('settings.memory_clear_confirm', 'Delete all'),
                }
                : {
                    title: t('settings.memory_clear_personal_title', 'Delete all your personal memories?'),
                    description: t('settings.memory_clear_personal_desc', 'Every personal memory will be removed and no longer used in your chats. Project memories are not affected. This cannot be undone.'),
                    confirmLabel: t('settings.memory_clear_confirm', 'Delete all'),
                };
        }
        return {
            title: 'Delete this memory?',
            description: 'It will no longer be used in your chats. This cannot be undone.',
            confirmLabel: 'Delete',
        };
    })();

    const toggleSelect = (id) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const selectAll = () => {
        const ids = filteredMemories.map(m => m.id);
        setSelectedIds(new Set(ids));
    };

    const deselectAll = () => setSelectedIds(new Set());

    const handleEdit = (memory) => {
        setEditingId(memory.id);
        setEditContent(memory.content);
    };

    const handleSaveEdit = async (id) => {
        try {
            const res = await authFetch(`${API_BASE}/agents/memory/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: editContent })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setMemories(prev => prev.map(m =>
                m.id === id ? { ...m, content: editContent } : m
            ));
            setEditingId(null);
        } catch (err) {
            console.error('Failed to update memory:', err);
            setActionError('Could not save this memory. Please try again.');
        }
    };

    const handleAdd = async () => {
        if (!newMemory.content.trim()) return;

        try {
            const payload = { ...newMemory };
            if (projectId) payload.projectId = projectId;
            
            const res = await authFetch(`${API_BASE}/agents/memory`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = res.ok ? await res.json() : null;
            if (!data?.id) throw new Error(`HTTP ${res.status}`);
            setMemories(prev => [{
                id: data.id,
                content: newMemory.content,
                type: newMemory.type,
                created_at: new Date().toISOString()
            }, ...prev]);
            setTotal(t => t + 1);
            setNewMemory({ content: '', type: 'fact' });
            setShowAddForm(false);
            fetchStats();
        } catch (err) {
            console.error('Failed to add memory:', err);
            setActionError('Could not add this memory. Please try again.');
        }
    };

    const handleExport = async () => {
        try {
            const res = await authFetch(`${API_BASE}/agents/memory/export/all`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'memories.json';
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('Failed to export memories:', err);
            setActionError('Could not export your memories. Please try again.');
        }
    };

    const typeConfig = {
        instruction: { Icon: Bookmark,    label: 'Instruction', color: '#d97706', bg: 'rgba(245, 158, 11, 0.1)', border: 'rgba(245, 158, 11, 0.25)' },
        person:      { Icon: User,        label: 'Person',      color: '#0d9488', bg: 'rgba(13, 148, 136, 0.1)', border: 'rgba(13, 148, 136, 0.25)' },
        project:     { Icon: Folder,      label: 'Project',     color: '#2563eb', bg: 'rgba(37, 99, 235, 0.1)',  border: 'rgba(37, 99, 235, 0.25)' },
        preference:  { Icon: SettingsIcon,label: 'Preference',  color: '#475569', bg: 'rgba(71, 85, 105, 0.1)',  border: 'rgba(71, 85, 105, 0.25)' },
        workflow:    { Icon: Workflow,    label: 'Workflow',    color: '#16a34a', bg: 'rgba(22, 163, 74, 0.1)',  border: 'rgba(22, 163, 74, 0.25)' },
        fact:        { Icon: FileText,    label: 'Fact',        color: '#525252', bg: 'rgba(82, 82, 82, 0.1)',   border: 'rgba(82, 82, 82, 0.25)' },
        context:     { Icon: Building2,   label: 'Context',     color: '#0891b2', bg: 'rgba(8, 145, 178, 0.1)',  border: 'rgba(8, 145, 178, 0.25)' },
    };

    // Types available when adding a memory manually, scoped by context:
    // - Project panel: project-relevant types only (no personal/workflow entries)
    // - User-global panel: personal types only (never 'project' — those belong to projects)
    const allowedAddTypes = projectId
        ? ['instruction', 'project', 'fact', 'context']
        : ['instruction', 'person', 'preference', 'workflow', 'fact', 'context'];

    const formatDate = formatRelativeTime;

    // Filtered memories — for the paginated/global view the server has
    // already applied search + type filters, so we just show what was loaded.
    // For project-scoped panels we still filter client-side.
    const filteredMemories = isPaginated
        ? memories
        : memories.filter(m => {
            if (filterType !== 'all' && m.type !== filterType) return false;
            if (searchTerm && !m.content.toLowerCase().includes(searchTerm.toLowerCase())) return false;
            return true;
        });

    // Count per type (of what's currently loaded)
    const typeCounts = memories.reduce((acc, m) => {
        acc[m.type] = (acc[m.type] || 0) + 1;
        return acc;
    }, {});

    // Filter-chip visibility/counts must NOT depend on the active filter. For the
    // global (paginated) view use the full stats distribution; the project view
    // already holds the complete client-side list, so its typeCounts is accurate.
    const typeTotals = isPaginated ? allTypeCounts : typeCounts;

    return (
        <div className={`${embedded ? 'max-h-[65vh] min-h-48' : 'h-full'} flex flex-col`} style={{ background: 'var(--bg-primary)' }} data-testid="memory-panel">
            {/* Header */}
            <div className="px-5 py-4 border-b" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-secondary)' }}>
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                        {onClose && (
                            <button onClick={onClose} className="p-1.5 -ml-1 rounded-lg transition-colors hover:bg-black/5"
                                style={{ color: 'var(--text-muted)' }} title={t('knowledge.memory_back_to_settings', 'Back to Settings')}>
                                <ChevronLeft className="w-5 h-5" />
                            </button>
                        )}
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(245, 158, 11, 0.15)' }}>
                            <Lightbulb className="w-5 h-5" style={{ color: '#d97706' }} />
                        </div>
                        <div>
                            <h2 className="font-semibold" style={{ color: 'var(--text-primary)' }}>{projectId ? t('project_content.shared_memory', 'Shared project memory') : 'Memory'}</h2>
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                {isPaginated && total > memories.length
                                    ? `${memories.length} of ${total} ${total === 1 ? 'memory' : 'memories'} loaded`
                                    : `${total || memories.length} ${(total || memories.length) === 1 ? 'memory' : 'memories'} stored`}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {/* Select mode exists only to bulk-delete, so a viewer never sees it. */}
                        {canEdit && (
                        <button
                            onClick={() => { setIsSelectMode(!isSelectMode); setSelectedIds(new Set()); }}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-all"
                            style={{
                                background: isSelectMode ? 'rgba(245, 158, 11, 0.1)' : 'transparent',
                                color: isSelectMode ? 'var(--text-primary)' : 'var(--text-muted)',
                                border: `1px solid ${isSelectMode ? 'rgba(245, 158, 11, 0.3)' : 'var(--border-subtle)'}`,
                            }}
                            title={isSelectMode ? 'Exit select mode' : 'Select multiple'}
                            data-testid="memory-select-toggle"
                        >
                            <CheckSquare className="w-4 h-4" />
                            {isSelectMode ? t('project_content.cancel', 'Cancel') : t('project_content.memory_select', 'Select')}
                        </button>
                        )}
                        <button
                            onClick={() => setShowAddForm(!showAddForm)}
                            hidden={!canEdit}
                            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition-all"
                            style={{
                                background: showAddForm ? 'var(--bg-tertiary)' : 'var(--accent-primary)',
                                color: showAddForm ? 'var(--text-muted)' : 'white',
                            }}
                        >
                            {showAddForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                            {showAddForm ? t('project_content.cancel', 'Cancel') : t('project_content.memory_add', 'Add memory')}
                        </button>
                    </div>
                </div>

                {/* Search + Filter */}
                <div className="flex gap-2 items-center">
                    <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                        <input
                            type="text"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            placeholder={t('project_content.memory_search', 'Search memories…')}
                            className="input w-full pl-10 text-sm"
                            data-testid="memory-search"
                        />
                    </div>
                    <div className="flex gap-1">
                        <button
                            onClick={() => setFilterType('all')}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all"
                            style={{
                                background: filterType === 'all' ? 'var(--accent-primary)' : 'transparent',
                                color: filterType === 'all' ? 'white' : 'var(--text-muted)',
                            }}
                            data-testid="memory-filter-all"
                        >
                            {t('knowledge.memory_all', 'All')}
                        </button>
                        {Object.entries(typeConfig).filter(([key]) => allowedAddTypes.includes(key)).map(([key, cfg]) => (
                            // Keep the currently-selected chip visible even when its live
                            // count is 0, so selecting a filter can never make its own chip
                            // vanish and strand the user on "All" (BFSF-180).
                            (typeTotals[key] > 0 || filterType === key) && (
                                <button
                                    key={key}
                                    onClick={() => setFilterType(filterType === key ? 'all' : key)}
                                    className="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1"
                                    style={{
                                        background: filterType === key ? cfg.bg : 'transparent',
                                        color: filterType === key ? cfg.color : 'var(--text-muted)',
                                        border: filterType === key ? `1px solid ${cfg.border}` : '1px solid transparent',
                                    }}
                                    data-testid={`memory-filter-${key}`}
                                >
                                    <cfg.Icon className="w-3 h-3" />
                                    {typeTotals[key]}
                                </button>
                            )
                        ))}
                    </div>
                </div>
            </div>

            {/* Add Memory Form */}
            {showAddForm && canEdit && (
                <div className="p-4 border-b" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-tertiary)' }}>
                    <div className="max-w-2xl mx-auto">
                        <div className="flex gap-2 mb-3">
                            {Object.entries(typeConfig).filter(([key]) => allowedAddTypes.includes(key)).map(([key, cfg]) => (
                                <button
                                    key={key}
                                    onClick={() => setNewMemory(prev => ({ ...prev, type: key }))}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                                    style={{
                                        background: newMemory.type === key ? cfg.bg : 'transparent',
                                        color: newMemory.type === key ? cfg.color : 'var(--text-muted)',
                                        border: `1px solid ${newMemory.type === key ? cfg.border : 'var(--border-subtle)'}`,
                                    }}
                                >
                                    <cfg.Icon className="w-3.5 h-3.5" />
                                    {cfg.label}
                                </button>
                            ))}
                        </div>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={newMemory.content}
                                onChange={(e) => setNewMemory(prev => ({ ...prev, content: e.target.value }))}
                                placeholder={t('knowledge.memory_enter_something_to_remember', 'Enter something to remember...')}
                                className="input text-sm flex-1"
                                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                                autoFocus
                            />
                            <button onClick={handleAdd} className="btn-primary text-sm px-5">
                                {t('knowledge.memory_save', 'Save')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Memories List */}
            <div className="flex-1 overflow-auto p-5">
                <div className="max-w-2xl mx-auto">
                    {actionError && (
                        <div
                            role="alert"
                            data-testid="memory-action-error"
                            className="flex items-start gap-2 rounded-xl px-4 py-3 mb-3 text-sm"
                            style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid var(--error)', color: 'var(--error-ink)' }}
                        >
                            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
                            <span className="flex-1">{actionError}</span>
                            <button
                                type="button"
                                onClick={() => setActionError(null)}
                                className="p-0.5 rounded-md transition-colors hover:bg-black/5"
                                title={t('knowledge.memory_dismiss', 'Dismiss')}
                                data-testid="memory-action-error-dismiss"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                    )}
                    {loading ? (
                        <div className="flex items-center justify-center h-32">
                            <div className="spinner"></div>
                        </div>
                    ) : error ? (
                        <div role="alert" className="text-center py-8" style={{ color: 'var(--error)' }} data-testid="memory-load-error">{error}</div>
                    ) : filteredMemories.length === 0 ? (
                        <div className={`text-center ${embedded ? 'py-6' : 'py-16'}`}>
                            <div style={{
                                width: '64px', height: '64px', borderRadius: '16px', margin: '0 auto 16px',
                                background: 'rgba(245, 158, 11, 0.12)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}>
                                <Lightbulb className="w-7 h-7" style={{ color: '#d97706' }} />
                            </div>
                            {memories.length === 0 ? (
                                <>
                                    <h3 className="text-base font-semibold mb-1.5" style={{ color: 'var(--text-primary)' }}>{t('project_content.memory_empty', 'No memories yet')}</h3>
                                    <p className="text-sm" style={{ color: 'var(--text-muted)', maxWidth: '320px', margin: '0 auto', lineHeight: '1.6' }}>
                                        {projectId ? (extractMemories ? t('project_content.memory_auto', 'Useful project facts can be saved from chats. All project members can read them.') : t('project_content.memory_manual', 'Automatic memory is off. Editors can add shared project facts here.')) : 'Memories are automatically extracted from conversations. Tell your AI about yourself to start building memory!'}
                                    </p>
                                </>
                            ) : (
                                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{t('knowledge.memory_no_memories_match_your_filter', 'No memories match your filter')}</p>
                            )}
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {/* Bulk select actions bar */}
                            {isSelectMode && canEdit && filteredMemories.length > 0 && (
                                <div className="flex items-center justify-between px-4 py-2.5 rounded-xl mb-3" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}>
                                    <div className="flex items-center gap-3">
                                        <button onClick={selectedIds.size === filteredMemories.length ? deselectAll : selectAll}
                                            className="text-xs font-medium px-2.5 py-1 rounded-md transition-all"
                                            style={{ color: 'var(--accent-primary)', background: 'rgba(245, 158, 11, 0.1)' }}
                                            data-testid="memory-select-all-btn">
                                            {selectedIds.size === filteredMemories.length ? 'Deselect All' : 'Select All'}
                                        </button>
                                        <span className="text-xs" style={{ color: 'var(--text-muted)' }} data-testid="memory-selected-count">
                                            {t('knowledge.memory_selected', '{count} selected', { count: selectedIds.size })}
                                        </span>
                                    </div>
                                    {selectedIds.size > 0 && (
                                        <button onClick={requestBulkDelete}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:bg-red-500/20"
                                            style={{ color: '#f87171' }}
                                            data-testid="memory-bulk-delete-btn">
                                            <Trash2 className="w-3.5 h-3.5" />
                                            {t('knowledge.memory_delete_count', 'Delete {count}', { count: selectedIds.size })}
                                        </button>
                                    )}
                                </div>
                            )}
                            {filteredMemories.map(memory => {
                                const cfg = typeConfig[memory.type] || typeConfig.fact;
                                return (
                                    <div
                                        key={memory.id}
                                        className={`rounded-xl p-4 transition-all group ${isSelectMode ? 'cursor-pointer' : ''}`}
                                        style={{
                                            background: selectedIds.has(memory.id) ? 'rgba(245, 158, 11, 0.08)' : 'var(--bg-secondary)',
                                            border: selectedIds.has(memory.id) ? '1px solid rgba(245, 158, 11, 0.3)' : '1px solid var(--border-subtle)',
                                            borderLeft: `3px solid ${cfg.color}`,
                                        }}
                                        onClick={isSelectMode ? () => toggleSelect(memory.id) : undefined}
                                        data-testid={`memory-item-${memory.id}`}
                                    >
                                        <div className="flex items-start gap-3">
                                            {isSelectMode && (
                                                <div className="flex items-center mt-1 flex-shrink-0">
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedIds.has(memory.id)}
                                                        onChange={() => toggleSelect(memory.id)}
                                                        onClick={(e) => e.stopPropagation()}
                                                        className="w-4 h-4 rounded"
                                                        style={{ accentColor: 'var(--accent-primary)' }}
                                                        data-testid={`memory-checkbox-${memory.id}`}
                                                    />
                                                </div>
                                            )}
                                            <div
                                                className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                                                style={{ background: cfg.bg }}
                                            >
                                                <cfg.Icon className="w-4 h-4" style={{ color: cfg.color }} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span
                                                        className="text-xs font-semibold uppercase tracking-wider"
                                                        style={{ color: cfg.color, fontSize: '10px' }}
                                                    >
                                                        {cfg.label}
                                                    </span>
                                                    {memory.created_at && (
                                                        <span className="text-xs" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                                                            • {formatDate(memory.created_at)}
                                                        </span>
                                                    )}
                                                    {memory.created_by_name && projectId && (
                                                        <span className="text-xs" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                                                            {t('knowledge.memory_by', '• by {name}', { name: memory.created_by_name })}
                                                        </span>
                                                    )}
                                                </div>
                                                {editingId === memory.id ? (
                                                    <div>
                                                        <input
                                                            type="text"
                                                            value={editContent}
                                                            onChange={(e) => setEditContent(e.target.value)}
                                                            className="input text-sm w-full"
                                                            autoFocus
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter') handleSaveEdit(memory.id);
                                                                if (e.key === 'Escape') setEditingId(null);
                                                            }}
                                                        />
                                                        <div className="flex gap-2 mt-2">
                                                            <button onClick={() => setEditingId(null)} className="btn-secondary text-xs">
                                                                {t('knowledge.memory_cancel', 'Cancel')}
                                                            </button>
                                                            <button onClick={() => handleSaveEdit(memory.id)} className="btn-primary text-xs">
                                                                {t('knowledge.memory_save', 'Save')}
                                                            </button>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <p className="text-sm leading-relaxed" style={{ color: 'var(--text-primary)' }}>
                                                        {memory.content}
                                                    </p>
                                                )}
                                            </div>
                                            {editingId !== memory.id && canEdit && (
                                                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                                                    <button
                                                        onClick={() => handleEdit(memory)}
                                                        className="p-1.5 rounded-lg transition-colors hover:bg-white/10"
                                                        style={{ color: 'var(--text-muted)' }}
                                                        title={t('knowledge.memory_edit', 'Edit')}
                                                        data-testid={`memory-edit-${memory.id}`}
                                                    >
                                                        <Edit2 className="w-4 h-4" />
                                                    </button>
                                                    <button
                                                        onClick={() => requestDelete(memory.id)}
                                                        className="p-1.5 rounded-lg transition-colors hover:bg-red-500/20"
                                                        style={{ color: 'var(--text-muted)' }}
                                                        title={t('knowledge.memory_delete', 'Delete')}
                                                        data-testid={`memory-delete-${memory.id}`}
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                            {isPaginated && hasMore && (
                                <div className="flex justify-center pt-4">
                                    <button
                                        onClick={handleLoadMore}
                                        disabled={loadingMore}
                                        className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50"
                                        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
                                        data-testid="memory-load-more"
                                    >
                                        {loadingMore ? 'Loading…' : `Load more (${total - memories.length} remaining)`}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Footer */}
            {memories.length > 0 && (
                <div className="px-5 py-3 border-t flex items-center justify-between" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-secondary)' }}>
                    <button
                        onClick={requestClearAll}
                        hidden={!canEdit}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:bg-red-500/10"
                        style={{ color: '#f87171' }}
                        data-testid="memory-clear-all"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                        {t('knowledge.memory_clear_all', 'Clear All')}
                    </button>
                    <button
                        onClick={handleExport}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:bg-white/5"
                        style={{ color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}
                        data-testid="memory-export"
                    >
                        <Download className="w-3.5 h-3.5" />
                        {t('knowledge.memory_export_json', 'Export JSON')}
                    </button>
                </div>
            )}

            <ConfirmDialog
                open={!!confirmAction}
                title={confirmCopy.title}
                description={confirmCopy.description}
                confirmLabel={confirmCopy.confirmLabel}
                destructive
                onConfirm={runConfirmedAction}
                onCancel={() => setConfirmAction(null)}
            />
        </div>
    );
};

export default MemoryPanel;
