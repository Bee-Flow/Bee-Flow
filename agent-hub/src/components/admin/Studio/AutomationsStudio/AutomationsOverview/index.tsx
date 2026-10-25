import { Plus, Workflow } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { GROUPS, NO_FOLDER, SORTS, TRIGGER_KINDS, VIEWS, type OverviewLane, type RunIdSet, countFolders, countStates, countTriggers, filterRows, groupRows, sortRows, statusLabelOf, triggerLabelOf } from '../overviewModel';
import OverviewToolbar, { type PillOption } from '../OverviewToolbar';
import { useTranslation } from '../../../../../hooks/useTranslation';
import EmptyState from '../../../../shared/EmptyState';
import Modal from '../../../../shared/Modal';
import type { ProjectContextPillProject } from '../../../../chat/ProjectContextPill';
import type { RowPropsFn, AutomationsOverviewProps, NewFolderDialogProps, CardsViewProps } from '../AutomationsOverview.types';
import { VIEW_KEY, SORT_KEY, GROUP_KEY, COLUMN, readStored, store } from './AutomationsOverview.helpers';
import { ListView } from './ListView';
import { Card, BoardView } from './BoardView';

/**
 * "All automations" — the landing in the right pane when nothing is open.
 *
 * The sidebar is the navigation: one narrow column, folders, a filter box.
 * It answers "where is X". This surface answers the other questions someone
 * asks about a library of forty automations — what is on, what is broken, what
 * runs tonight, what has not run in a month — and it answers them in the
 * shape the person prefers:
 *
 *   list    a sortable table (the Skills "All skills" idiom): one automation per
 *           row, trigger · status · last run · next run · updated in columns
 *           that join as the overview widens (LIST_GRID)
 *   cards   a gallery (the Apps / Datatables idiom): title, description and
 *           the same facts in a card, for the library you browse by name
 *   board   lanes (Live · Paused · Draft, or per trigger kind, or per folder)
 *           so the shape of the library is visible at a glance
 *
 * The view, sort and grouping are per user, per browser (scopedStorage) —
 * presentation, like the sidebar's open folders.
 *
 * ── ONE WIDTH, ITS OWN ───────────────────────────────────────────────
 * Everything here adapts to the overview's own width (`@container/overview`),
 * never the viewport's. A laptop gets fewer columns and the pills folded
 * into a Filter button (OverviewToolbar); an ultrawide gets every column in
 * one centred column (COLUMN), cards at a fixed-ish size in more columns,
 * and board lanes that share the width up to a readable maximum.
 *
 * ── THE ROWS ARRIVE FILTERED ─────────────────────────────────────────
 * `automations` is what the sidebar's filter box let through, and `query` is
 * that filter — without it this component cannot tell "no automations" from
 * "none match", and the empty-library invitation would show for a typo. The
 * state/trigger pills here narrow further, on top of that.
 *
 * ── ONE MENU ─────────────────────────────────────────────────────────
 * `rowProps(a)` is index.jsx's `makeAutomationRowProps` — the same callbacks
 * the sidebar row gets. The kebab on a row, a card or a board tile opens the
 * menu `automationMenuItems` builds from them, so "Move to folder…" and
 * "Export JSON" are wherever the automation is.
 */

export default function AutomationsOverview({
    automations = [],
    folders = [],
    query = '',
    loading = false,
    activeRunIds = null,
    rowProps,
    onCreate = null,
    onCreateBlock = null,
    onCreateFolder = null,
    canCreate = true,
}: AutomationsOverviewProps) {
    const { t } = useTranslation();
    const [view, setViewState] = useState(() => readStored(VIEW_KEY, VIEWS, 'cards'));
    const [sort, setSortState] = useState(() => readStored(SORT_KEY, SORTS, 'updated'));
    const [groupBy, setGroupState] = useState(() => readStored(GROUP_KEY, GROUPS, 'status'));
    const [state, setState] = useState('all');
    const [trigger, setTrigger] = useState('all');
    const [folder, setFolder] = useState('all');
    // "New folder" opens a small name dialog — the naming input the sidebar
    // hosts inline cannot sit in a toolbar menu.
    const [folderDialogOpen, setFolderDialogOpen] = useState(false);

    const setView = (v: string) => { setViewState(v); store(VIEW_KEY, v); };
    const setSort = (v: string) => { setSortState(v); store(SORT_KEY, v); };
    const setGroupBy = (v: string) => { setGroupState(v); store(GROUP_KEY, v); };

    // A folder deleted elsewhere (or by the sidebar) must not leave the
    // filter stuck on a lane that no longer exists.
    const effectiveFolder = folder !== 'all' && folder !== NO_FOLDER && !folders.some((f) => f.id === folder) ? 'all' : folder;

    // Each pill row counts over what the OTHER rows let through, so a number
    // on a pill is what clicking it shows.
    const stateCounts = useMemo(
        () => countStates(filterRows(automations, { trigger, folder: effectiveFolder, folders, activeRunIds }), activeRunIds),
        [automations, trigger, effectiveFolder, folders, activeRunIds],
    );
    const triggerCounts = useMemo(
        () => countTriggers(filterRows(automations, { state, folder: effectiveFolder, folders, activeRunIds })),
        [automations, state, effectiveFolder, folders, activeRunIds],
    );
    const folderCounts = useMemo(
        () => countFolders(filterRows(automations, { state, trigger, activeRunIds }), folders),
        [automations, state, trigger, activeRunIds, folders],
    );
    const rows = useMemo(
        () => sortRows(filterRows(automations, { state, trigger, folder: effectiveFolder, folders, activeRunIds }), sort),
        [automations, state, trigger, effectiveFolder, folders, activeRunIds, sort],
    );
    const lanes = useMemo(
        () => (view === 'board' ? groupRows(rows, groupBy, { folders, t }) : null),
        [view, rows, groupBy, folders, t],
    );

    const filtering = String(query || '').trim() !== '';
    const narrowed = state !== 'all' || trigger !== 'all' || effectiveFolder !== 'all';
    const clearFilters = () => { setState('all'); setTrigger('all'); setFolder('all'); };

    const stateOptions: PillOption[] = [
        { value: 'all', label: t('studio_misc.overview.filter_all', 'All'), count: stateCounts.all },
        { value: 'live', label: statusLabelOf('live', t), count: stateCounts.live, tone: 'success' },
        { value: 'paused', label: statusLabelOf('paused', t), count: stateCounts.paused, tone: 'muted' },
        { value: 'draft', label: statusLabelOf('draft', t), count: stateCounts.draft },
        { value: 'failing', label: t('studio_misc.overview.filter_failing', 'Failing'), count: stateCounts.failing, tone: 'error' },
        { value: 'running', label: t('studio_misc.overview.filter_running', 'Running'), count: stateCounts.running },
    ];
    // A trigger kind nobody uses is not a filter worth offering.
    const triggerOptions = [
        { value: 'all', label: t('studio_misc.overview.filter_any_trigger', 'Any trigger'), count: triggerCounts.all },
        ...TRIGGER_KINDS.filter(k => triggerCounts[k]).map(k => ({ value: k, label: triggerLabelOf(k, t), count: triggerCounts[k] })),
    ];
    // Folders always keep their pill, even at 0 — an empty folder is still a
    // place to file into. Only offered at all when the library HAS folders.
    const folderOptions = folders.length === 0 ? [] : [
        { value: 'all', label: t('studio_misc.overview.filter_any_folder', 'Any folder'), count: folderCounts.all },
        { value: NO_FOLDER, label: t('studio_misc.overview.no_folder', 'No folder'), count: folderCounts[NO_FOLDER] },
        ...folders.map(f => ({ value: f.id, label: f.name || t('studio_misc.overview.untitled_folder', 'Untitled folder'), count: folderCounts[f.id] })),
    ];

    let body: React.JSX.Element;
    if (loading && automations.length === 0) {
        body = <p className="text-xs text-[var(--text-tertiary)] px-4 py-6 m-0">{t('studio_misc.overview.loading', 'Loading…')}</p>;
    } else if (automations.length === 0 && !filtering) {
        body = (
            <EmptyState
                icon={<Workflow className="w-12 h-12" />}
                title={t('studio_misc.overview.empty_title', 'No automations yet')}
                description={t('studio_misc.overview.empty_description', 'Describe repeating work to the AI, pick a template, or build one step by step. Everything you make shows up here.')}
                action={onCreate && canCreate ? { label: t('studio_misc.overview.new_automation', 'New automation'), icon: <Plus size={14} />, onClick: onCreate } : undefined}
            />
        );
    } else if (rows.length === 0) {
        body = (
            <div className="px-4 py-10 text-center text-sm text-[var(--text-secondary)]">
                {filtering && !narrowed
                    ? <>{t('studio_misc.overview.no_match_query', 'No automation matches “{query}”.', { query: query.trim() })}</>
                    : (
                        <>
                            {t('studio_misc.overview.no_match_filters', 'Nothing matches these filters.')}{' '}
                            <button type="button" onClick={clearFilters} className="underline text-[var(--text-primary)]">
                                {t('studio_misc.overview.clear_filters', 'Clear filters')}
                            </button>
                        </>
                    )}
            </div>
        );
    } else if (view === 'cards') {
        body = <CardsView rows={rows} rowProps={rowProps} activeRunIds={activeRunIds} />;
    } else if (view === 'board') {
        body = <BoardView lanes={lanes} groupBy={groupBy} rowProps={rowProps} activeRunIds={activeRunIds} />;
    } else {
        body = <ListView rows={rows} rowProps={rowProps} activeRunIds={activeRunIds} sort={sort} onSort={setSort} />;
    }

    return (
        <div className="@container/overview h-full flex flex-col min-h-0 bg-[var(--bg-primary)]" data-testid="automations-overview" data-view={view}>
            {/* One toolbar, not a header plus a filter row: the tab above
                already says "All automations", so the row under it gets to
                work — what to show on the left, how to show it on the right. */}
            <OverviewToolbar
                hasRows={automations.length > 0}
                state={state}
                onState={setState}
                stateOptions={stateOptions}
                trigger={trigger}
                onTrigger={setTrigger}
                triggerOptions={triggerOptions}
                folder={effectiveFolder}
                onFolder={setFolder}
                folderOptions={folderOptions}
                narrowed={narrowed}
                onClear={clearFilters}
                view={view}
                onView={setView}
                sort={sort}
                onSort={setSort}
                groupBy={groupBy}
                onGroup={setGroupBy}
                onCreate={onCreate}
                onCreateBlock={onCreateBlock}
                onCreateFolder={onCreateFolder ? () => setFolderDialogOpen(true) : null}
                canCreate={canCreate}
            />

            <div className={`flex-1 min-h-0 ${view === 'board' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
                {body}
            </div>
            {folderDialogOpen && (
                <NewFolderDialog
                    onCreate={(name) => { setFolderDialogOpen(false); onCreateFolder?.(name); }}
                    onClose={() => setFolderDialogOpen(false)}
                />
            )}
        </div>
    );
}

function NewFolderDialog({ onCreate, onClose }: NewFolderDialogProps) {
    const { t } = useTranslation();
    const [name, setName] = useState('');
    const commit = () => { if (name.trim()) onCreate(name); };
    return (
        <Modal open onClose={onClose} size="sm" label={t('automations.library.newFolder', 'New folder')}>
            <form
                onSubmit={(e) => { e.preventDefault(); commit(); }}
                className="flex flex-col gap-3"
            >
                <span className="text-sm font-semibold text-[var(--text-primary)]">
                    {t('automations.library.newFolder', 'New folder')}
                </span>
                <input
                    autoFocus
                    value={name}
                    aria-label={t('automations.library.folderName', 'Folder name')}
                    placeholder={t('automations.library.folderName', 'Folder name')}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
                    className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
                />
                <div className="flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-3 py-1.5 rounded-md text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition"
                    >
                        {t('automations.library.cancel', 'Cancel')}
                    </button>
                    <button
                        type="submit"
                        disabled={!name.trim()}
                        className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] transition disabled:opacity-50"
                    >
                        {t('automations.library.createFolder', 'Create folder')}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

// ── Building blocks shared by the three views ───────────────────────

// ── List ─────────────────────────────────────────────────────────────

// ── Cards ────────────────────────────────────────────────────────────

function CardsView({ rows, rowProps, activeRunIds }: CardsViewProps) {
    return (
        // As many columns as fit at 21rem, by the overview's own width: two on a
        // laptop, five in the centred column of an ultrawide. auto-fill keeps
        // empty tracks, so three automations stay card-sized instead of stretching.
        <div className={`${COLUMN} grid grid-cols-[repeat(auto-fill,minmax(min(21rem,100%),1fr))] gap-3 p-4`} data-testid="automations-overview-cards">
            {rows.map(a => <Card key={a.id} automation={a} props={rowProps?.(a)} liveRunning={!!activeRunIds?.has?.(a.id)} />)}
        </div>
    );
}

// ── Board ────────────────────────────────────────────────────────────

