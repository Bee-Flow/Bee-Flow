import { ArrowDown, ArrowUp, Plus, Workflow } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import {
    GROUPS, NO_FOLDER, SORTS, TRIGGER_KINDS, VIEWS,
    countFolders, countStates, countTriggers, filterRows, flowSummaryOf, folderLabel, groupRows, sortRows,
    statusLabelOf, triggerLabelOf, triggerTextOf,
} from './overviewModel';
import { OutcomeBit, StatusBadge, TriggerTile, titleOf, useRowMenu } from './OverviewBits';
import { Card, CardsView } from './OverviewCards';
import OverviewToolbar, { type PillOption } from './OverviewToolbar';
import useRelativeTime from '../../../../hooks/useRelativeTime';
import { useTranslation } from '../../../../hooks/useTranslation';
import scopedStorage from '../../../../utils/scopedStorage';
import { formatNextRun } from '../../../automation/taskFormatters';
import EmptyState from '../../../shared/EmptyState';
import Modal from '../../../shared/Modal';
import { STATUS_TOKENS } from '../../../shared/statusTokens';
import type { AutomationsOverviewProps, NewFolderDialogProps, SortHeadProps, ListViewProps, NameCellProps, ListRowProps, BoardViewProps } from './AutomationsOverview.types';
import { logger } from '../../../../utils/logger';

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

const VIEW_KEY = 'automationsOverviewView';
const SORT_KEY = 'automationsOverviewSort';
const GROUP_KEY = 'automationsOverviewGroup';

// The column every view shares on a wide screen: the toolbar, the table, the
// cards and the board stay in one centred column instead of spreading a
// three-row library across an ultrawide monitor.
const COLUMN = 'mx-auto w-full max-w-[110rem]';

function readStored(key: string, allowed: readonly string[], fallback: string) {
    let v: string | null = null;
    try { v = scopedStorage.getItem(key); } catch (err) { logger.debug('storage best-effort', err); }
    return v !== null && allowed.includes(v) ? v : fallback;
}
function store(key: string, value: string) {
    try { scopedStorage.setItem(key, value); } catch (err) { logger.debug('storage best-effort', err); }
}

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
        ...folders.map(f => ({ value: f.id, label: folderLabel(folders, f.id) || t('studio_misc.overview.untitled_folder', 'Untitled folder'), count: folderCounts[f.id] })),
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
        body = <CardsView rows={rows} folders={folders} rowProps={rowProps} activeRunIds={activeRunIds} column={COLUMN} />;
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

// ── List ─────────────────────────────────────────────────────────────

// The columns by the overview's OWN width (@container/overview). A laptop
// keeps what answers "is it on, did it work": Automation · Status · Last run,
// with Trigger from 60rem. Next run joins at 76rem and Updated (what the
// default sort orders by) at 100rem, so a wide screen gets more to read rather
// than the same three facts spread further apart. A hidden cell takes no
// track, so header and rows stay aligned at every stage.
const LIST_GRID = 'grid grid-cols-[minmax(0,1fr)_90px_minmax(150px,190px)_32px] '
    + '@[60rem]/overview:grid-cols-[minmax(0,1fr)_minmax(140px,200px)_90px_minmax(150px,190px)_32px] '
    + '@[76rem]/overview:grid-cols-[minmax(0,1fr)_minmax(140px,200px)_90px_minmax(150px,190px)_140px_32px] '
    + '@[100rem]/overview:grid-cols-[minmax(0,1fr)_minmax(140px,200px)_90px_minmax(150px,190px)_140px_110px_32px]';
const WITH_TRIGGER = 'hidden @[60rem]/overview:block';
const WITH_NEXT_RUN = 'hidden @[76rem]/overview:block';
const WITH_UPDATED = 'hidden @[100rem]/overview:block';

// Which sort a column header stands for; a header without one is not sortable.
const COL_SORT: Record<string, string> = { name: 'name', status: 'status', lastRun: 'lastRun', nextRun: 'nextRun', updated: 'updated' };

// Ascending reads naturally for a name and for "what runs next"; the other
// sorts are newest-first.
const ASC_SORTS = new Set(['name', 'nextRun']);

function SortHead({ col, sort, onSort, className = '', children }: SortHeadProps) {
    const key = COL_SORT[col];
    if (!key) return <span className={className}>{children}</span>;
    const active = sort === key;
    const asc = ASC_SORTS.has(key);
    return (
        <button
            type="button"
            onClick={() => onSort(key)}
            aria-sort={active ? (asc ? 'ascending' : 'descending') : undefined}
            className={`items-center gap-1 text-left uppercase tracking-[.08em] font-semibold hover:text-[var(--text-primary)] transition ${active ? 'text-[var(--text-primary)]' : ''} ${className || 'inline-flex'}`}
        >
            {children}
            {active && (asc ? <ArrowUp size={10} aria-hidden="true" /> : <ArrowDown size={10} aria-hidden="true" />)}
        </button>
    );
}

function ListView({ rows, rowProps, activeRunIds, sort, onSort }: ListViewProps) {
    const { t } = useTranslation();
    return (
        <div role="table" aria-label={t('studio_misc.overview.col_automations', 'Automations')} className={`${COLUMN} min-w-[34rem]`}>
            <div
                role="row"
                className={`${LIST_GRID} gap-3 px-4 py-2 border-b border-[var(--border-default)] text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)] sticky top-0 bg-[var(--bg-primary)] z-[1]`}
            >
                <SortHead col="name" sort={sort} onSort={onSort}>{t('studio_misc.overview.col_automation', 'Automation')}</SortHead>
                <span className={WITH_TRIGGER}>{t('studio_misc.overview.col_trigger', 'Trigger')}</span>
                <SortHead col="status" sort={sort} onSort={onSort}>{t('studio_misc.overview.col_status', 'Status')}</SortHead>
                <SortHead col="lastRun" sort={sort} onSort={onSort}>{t('studio_misc.overview.col_last_run', 'Last run')}</SortHead>
                <SortHead col="nextRun" sort={sort} onSort={onSort} className="hidden @[76rem]/overview:inline-flex">{t('studio_misc.overview.col_next_run', 'Next run')}</SortHead>
                <SortHead col="updated" sort={sort} onSort={onSort} className="hidden @[100rem]/overview:inline-flex">
                    {t('automations.overview.colUpdated', 'Updated')}
                </SortHead>
                <span />
            </div>
            {rows.map(a => <ListRow key={a.id} automation={a} props={rowProps?.(a)} liveRunning={!!activeRunIds?.has?.(a.id)} />)}
        </div>
    );
}

function NameCell({ automation: a, liveRunning, onSelect }: NameCellProps) {
    const { t } = useTranslation();
    const description = (a.description || '').trim();
    // No description: say what the flow does instead (trigger → first steps).
    const secondLine = description || flowSummaryOf(a, t);
    return (
        <button type="button" onClick={onSelect} className="text-left min-w-0 flex items-center gap-3">
            <TriggerTile automation={a} size="md" />
            {/* Narrow: the description sits under the title, so neither
                is cut to a stub. Wide: beside it, where the description
                gives way first and the title only truncates once it
                alone is wider than the column. */}
            <span className="flex-1 min-w-0 flex flex-col @[76rem]/overview:flex-row @[76rem]/overview:items-baseline @[76rem]/overview:gap-2">
                <span className="min-w-0 flex items-center gap-2 @[76rem]/overview:shrink-0 @[76rem]/overview:max-w-full">
                    <span className="text-[13px] font-medium truncate text-[var(--text-primary)]" title={titleOf(a, t)}>{titleOf(a, t)}</span>
                    {liveRunning && <span className={`h-1.5 w-1.5 rounded-full animate-pulse ${STATUS_TOKENS.running.solid} bg-current shrink-0`} aria-hidden="true" />}
                </span>
                <span className="min-w-0 @[76rem]/overview:flex-1 text-xs text-[var(--text-tertiary)] truncate" title={secondLine}>
                    {secondLine}
                </span>
            </span>
        </button>
    );
}

function ListRow({ automation: a, props, liveRunning }: ListRowProps) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const { onContextMenu, kebab, menu } = useRowMenu(props);
    const nextRun = a.nextRunAt && a.isActive ? formatNextRun(a.nextRunAt) : null;
    return (
        <>
            <div
                role="row"
                data-testid="automations-overview-row"
                data-automation-id={a.id}
                onContextMenu={onContextMenu}
                className={`group ${LIST_GRID} gap-3 items-center px-4 h-12 border-b border-[var(--border-subtle,var(--border-default))] transition ${
                    props?.selected ? 'bg-[var(--bg-secondary)]' : 'hover:bg-[var(--bg-secondary)]'
                }`}
            >
                <NameCell automation={a} liveRunning={liveRunning} onSelect={props?.onSelect} />
                <span className={`text-xs text-[var(--text-secondary)] truncate ${WITH_TRIGGER}`} title={triggerTextOf(a, t)}>{triggerTextOf(a, t)}</span>
                <span><StatusBadge automation={a} /></span>
                <span className="flex items-center gap-2 min-w-0">
                    <OutcomeBit automation={a} liveRunning={liveRunning} when={a.lastRunAt ? rel(a.lastRunAt) : null} />
                </span>
                <span className={`text-xs truncate ${nextRun ? 'text-[var(--text-secondary)]' : 'text-[var(--border-default)]'} ${WITH_NEXT_RUN}`}>
                    {nextRun || '—'}
                </span>
                <span className={`text-xs truncate text-[var(--text-tertiary)] ${WITH_UPDATED}`}>
                    {a.updatedAt ? rel(a.updatedAt) : '—'}
                </span>
                <span className="flex justify-end">{kebab}</span>
            </div>
            {menu}
        </>
    );
}

// ── Board ────────────────────────────────────────────────────────────

function BoardView({ lanes, groupBy, rowProps, activeRunIds }: BoardViewProps) {
    const { t } = useTranslation();
    // In a status board the lane already says Live / Paused / Draft; a chip
    // repeating it on every tile is noise.
    const hideLifecycle = groupBy === 'status';
    return (
        // Lanes share the width between 17.5rem and 24rem: three status lanes
        // fill a laptop, stay readable on an ultrawide, and a board with many
        // folder lanes scrolls sideways rather than squeezing them.
        <div className={`${COLUMN} h-full flex items-start gap-3 p-4 overflow-x-auto`} data-testid="automations-overview-board">
            {lanes?.map(lane => (
                <section
                    key={lane.id}
                    data-testid="automations-overview-lane"
                    data-lane={lane.id}
                    aria-label={lane.label}
                    className="flex-1 min-w-[17.5rem] max-w-[24rem] flex flex-col max-h-full rounded-xl bg-[var(--bg-secondary)]"
                >
                    <header className="flex items-center gap-2 px-3 py-2.5">
                        <span className="text-[11px] uppercase tracking-[.08em] font-semibold text-[var(--text-secondary)]">{lane.label}</span>
                        <span className="text-[11px] tabular-nums text-[var(--text-tertiary)]">{lane.rows.length}</span>
                    </header>
                    <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-2">
                        {lane.rows.length === 0
                            ? <p className="text-[11px] text-[var(--text-tertiary)] px-1 py-3 m-0 text-center">{t('studio_misc.overview.nothing_here', 'Nothing here')}</p>
                            : lane.rows.map(a => <Card key={a.id} automation={a} props={rowProps?.(a)} liveRunning={!!activeRunIds?.has?.(a.id)} compact hideLifecycle={hideLifecycle} />)}
                    </div>
                </section>
            ))}
        </div>
    );
}
