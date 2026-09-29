import {
    ArrowDown, ArrowUp, Bot, Clock, Mail, MoreVertical, MousePointer2, Plus, Webhook, Workflow,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';
import ContextMenu from './ContextMenu';
import {
    GROUPS, SORTS, STATUS_LABEL, TRIGGER_KINDS, TRIGGER_LABEL, VIEWS,
    countStates, countTriggers, filterRows, groupRows, isFailing, sortRows,
    stepCountOf, triggerKindOf, triggerTextOf,
} from './overviewModel';
import OverviewToolbar from './OverviewToolbar';
import { buildRoutineMenuItems } from './routineMenuItems';
import useRelativeTime from '../../../../hooks/useRelativeTime';
import { useTranslation } from '../../../../hooks/useTranslation';
import scopedStorage from '../../../../utils/scopedStorage';
import { formatNextRun } from '../../../automation/taskFormatters';
import EmptyState from '../../../shared/EmptyState';
import { kindColorVar } from '../../../shared/kindColors';
import { automation as lifecycleOf } from '../../../shared/statusOf';
import { STATUS_TOKENS, statusLabel, tokenFor } from '../../../shared/statusTokens';

/**
 * "All automations" — the landing in the right pane when nothing is open.
 *
 * The sidebar is the navigation: one narrow column, folders, a filter box.
 * It answers "where is X". This surface answers the other questions someone
 * asks about a library of forty routines — what is on, what is broken, what
 * runs tonight, what has not run in a month — and it answers them in the
 * shape the person prefers:
 *
 *   list    a sortable table (the Skills "All skills" idiom): one routine per
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
 * menu `routineMenuItems` builds from them, so "Move to folder…" and
 * "Export JSON" are wherever the routine is.
 */

const VIEW_KEY = 'automationsOverviewView';
const SORT_KEY = 'automationsOverviewSort';
const GROUP_KEY = 'automationsOverviewGroup';

const TRIGGER_ICON = { schedule: Clock, manual: MousePointer2, webhook: Webhook, app_event: Mail, other: Bot };

// The column every view shares on a wide screen: the toolbar, the table, the
// cards and the board stay in one centred column instead of spreading a
// three-row library across an ultrawide monitor.
const COLUMN = 'mx-auto w-full max-w-[110rem]';

function readStored(key, allowed, fallback) {
    let v = null;
    try { v = scopedStorage.getItem(key); } catch (_) { /* storage best-effort */ }
    return allowed.includes(v) ? v : fallback;
}
function store(key, value) {
    try { scopedStorage.setItem(key, value); } catch (_) { /* storage best-effort */ }
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
    canCreate = true,
}) {
    const [view, setViewState] = useState(() => readStored(VIEW_KEY, VIEWS, 'list'));
    const [sort, setSortState] = useState(() => readStored(SORT_KEY, SORTS, 'updated'));
    const [groupBy, setGroupState] = useState(() => readStored(GROUP_KEY, GROUPS, 'status'));
    const [state, setState] = useState('all');
    const [trigger, setTrigger] = useState('all');

    const setView = (v) => { setViewState(v); store(VIEW_KEY, v); };
    const setSort = (v) => { setSortState(v); store(SORT_KEY, v); };
    const setGroupBy = (v) => { setGroupState(v); store(GROUP_KEY, v); };

    // Each pill row counts over what the OTHER row lets through, so a number
    // on a pill is what clicking it shows.
    const stateCounts = useMemo(
        () => countStates(filterRows(automations, { trigger, activeRunIds }), activeRunIds),
        [automations, trigger, activeRunIds],
    );
    const triggerCounts = useMemo(
        () => countTriggers(filterRows(automations, { state, activeRunIds })),
        [automations, state, activeRunIds],
    );
    const rows = useMemo(
        () => sortRows(filterRows(automations, { state, trigger, activeRunIds }), sort),
        [automations, state, trigger, activeRunIds, sort],
    );
    const lanes = useMemo(
        () => (view === 'board' ? groupRows(rows, groupBy, { folders }) : null),
        [view, rows, groupBy, folders],
    );

    const filtering = String(query || '').trim() !== '';
    const narrowed = state !== 'all' || trigger !== 'all';
    const clearFilters = () => { setState('all'); setTrigger('all'); };

    const stateOptions = [
        { value: 'all', label: 'All', count: stateCounts.all },
        { value: 'live', label: 'Live', count: stateCounts.live, tone: 'success' },
        { value: 'paused', label: 'Paused', count: stateCounts.paused, tone: 'muted' },
        { value: 'draft', label: 'Draft', count: stateCounts.draft },
        { value: 'failing', label: 'Failing', count: stateCounts.failing, tone: 'error' },
        { value: 'running', label: 'Running', count: stateCounts.running },
    ];
    // A trigger kind nobody uses is not a filter worth offering.
    const triggerOptions = [
        { value: 'all', label: 'Any trigger', count: triggerCounts.all },
        ...TRIGGER_KINDS.filter(k => triggerCounts[k]).map(k => ({ value: k, label: TRIGGER_LABEL[k], count: triggerCounts[k] })),
    ];

    let body;
    if (loading && automations.length === 0) {
        body = <p className="text-xs text-[var(--text-tertiary)] px-4 py-6 m-0">Loading…</p>;
    } else if (automations.length === 0 && !filtering) {
        body = (
            <EmptyState
                icon={<Workflow className="w-12 h-12" />}
                title="No automations yet"
                description="Describe repeating work to the AI, pick a template, or build one step by step. Everything you make shows up here."
                action={onCreate && canCreate ? { label: 'New automation', icon: <Plus size={14} />, onClick: onCreate } : undefined}
            />
        );
    } else if (rows.length === 0) {
        body = (
            <div className="px-4 py-10 text-center text-sm text-[var(--text-secondary)]">
                {filtering && !narrowed
                    ? <>No automation matches “{query.trim()}”.</>
                    : (
                        <>
                            Nothing matches these filters.{' '}
                            <button type="button" onClick={clearFilters} className="underline text-[var(--text-primary)]">
                                Clear filters
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
                canCreate={canCreate}
            />

            <div className={`flex-1 min-h-0 ${view === 'board' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
                {body}
            </div>
        </div>
    );
}

// ── Building blocks shared by the three views ───────────────────────

/** Live / Paused / Draft — the pill's vocabulary, at row size. */
function LifecycleChip({ routine }) {
    const status = lifecycleOf(routine);
    const live = status === 'live';
    return (
        <span
            className="inline-flex items-center gap-1.5 text-[11px] font-medium"
            data-testid="overview-lifecycle"
            data-status={status}
            style={{ color: live ? 'var(--success-ink)' : 'var(--text-secondary)' }}
        >
            <span
                className="h-1.5 w-1.5 rounded-full"
                aria-hidden="true"
                style={live
                    ? { background: 'var(--success)' }
                    : status === 'draft'
                        ? { background: 'transparent', boxShadow: 'inset 0 0 0 1.5px var(--text-tertiary)' }
                        : { background: 'var(--text-tertiary)' }}
            />
            {STATUS_LABEL[status]}
        </span>
    );
}

/** What the last run did, in the shared status table's colour and word. */
function OutcomeChip({ routine, liveRunning, t }) {
    if (liveRunning) {
        const tok = STATUS_TOKENS.running;
        const Icon = tok.icon;
        return (
            <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md font-semibold ${tok.badge}`}>
                <Icon className="w-3 h-3 animate-spin" aria-hidden="true" />{statusLabel(t, tok)}
            </span>
        );
    }
    if (!routine.lastStatus) return <span className="text-xs text-[var(--text-tertiary)]">Never ran</span>;
    const tok = tokenFor(routine.lastStatus);
    const Icon = tok.icon;
    return (
        <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md font-semibold ${tok.badge}`}>
            <Icon className={`w-3 h-3 ${tok.spin ? 'animate-spin' : ''}`} aria-hidden="true" />{statusLabel(t, tok)}
        </span>
    );
}

function TriggerGlyph({ routine, size = 14, className = '' }) {
    const Icon = TRIGGER_ICON[triggerKindOf(routine)];
    return <Icon size={size} aria-hidden="true" className={className} />;
}

/**
 * The icon tile's colours: the automation kind's teal while the routine is
 * on, plain grey when it is off or a draft, red when its last run failed —
 * so a column of tiles reads as a column of states before a word is read.
 */
function tileStyle(routine) {
    if (isFailing(routine)) {
        return { background: 'color-mix(in srgb, var(--error) 12%, transparent)', color: 'var(--error-ink)' };
    }
    if (lifecycleOf(routine) === 'live') {
        const c = kindColorVar('automation');
        return { background: `color-mix(in srgb, ${c} 12%, transparent)`, color: c };
    }
    return { background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' };
}

/** The kebab + its menu — one per row/card/tile, opened on click or right-click. */
function useRowMenu(props) {
    const [pos, setPos] = useState(null);
    const items = useMemo(() => buildRoutineMenuItems({
        isAutomation: true,
        isActive: !!props?.routine?.isActive,
        onToggleActive: props?.onToggleActive,
        onOpenRuns: props?.onOpenRuns,
        onDuplicate: props?.onDuplicate,
        onExportJson: props?.onExportJson,
        onMoveToFolder: props?.onMoveToFolder,
        onCopyId: props?.onCopyId,
        onDelete: props?.onDelete,
    }), [props]);
    const onContextMenu = (e) => {
        if (!items.length) return;
        e.preventDefault();
        setPos({ x: e.clientX, y: e.clientY });
    };
    const onKebab = (e) => {
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        setPos({ x: rect.right, y: rect.bottom });
    };
    const menu = <ContextMenu position={pos} items={items} onClose={() => setPos(null)} />;
    const kebab = items.length > 0 && (
        <button
            type="button"
            onClick={onKebab}
            title="More options"
            aria-label="More options"
            className="opacity-60 group-hover:opacity-100 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded p-0.5 transition"
        >
            <MoreVertical size={14} aria-hidden="true" />
        </button>
    );
    return { onContextMenu, kebab, menu };
}

const TITLE = (a) => a.title || 'Untitled automation';

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
const COL_SORT = { name: 'name', status: 'status', lastRun: 'lastRun', nextRun: 'nextRun', updated: 'updated' };

// Ascending reads naturally for a name and for "what runs next"; the other
// sorts are newest-first.
const ASC_SORTS = new Set(['name', 'nextRun']);

function SortHead({ col, sort, onSort, className = '', children }) {
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

function ListView({ rows, rowProps, activeRunIds, sort, onSort }) {
    const { t } = useTranslation();
    return (
        <div role="table" aria-label="Automations" className={`${COLUMN} min-w-[34rem]`}>
            <div
                role="row"
                className={`${LIST_GRID} gap-3 px-4 py-2 border-b border-[var(--border-default)] text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)] sticky top-0 bg-[var(--bg-primary)] z-[1]`}
            >
                <SortHead col="name" sort={sort} onSort={onSort}>Automation</SortHead>
                <span className={WITH_TRIGGER}>Trigger</span>
                <SortHead col="status" sort={sort} onSort={onSort}>Status</SortHead>
                <SortHead col="lastRun" sort={sort} onSort={onSort}>Last run</SortHead>
                <SortHead col="nextRun" sort={sort} onSort={onSort} className="hidden @[76rem]/overview:inline-flex">Next run</SortHead>
                <SortHead col="updated" sort={sort} onSort={onSort} className="hidden @[100rem]/overview:inline-flex">
                    {t('routines.overview.colUpdated', 'Updated')}
                </SortHead>
                <span />
            </div>
            {rows.map(a => <ListRow key={a.id} routine={a} props={rowProps?.(a)} liveRunning={!!activeRunIds?.has?.(a.id)} />)}
        </div>
    );
}

/** The first cell: the trigger tile, the name and one line about it. */
function NameCell({ routine: a, liveRunning, onSelect }) {
    const description = (a.description || '').trim();
    const steps = stepCountOf(a);
    const stepsText = steps != null ? `${steps} step${steps === 1 ? '' : 's'}` : '';
    return (
        <button type="button" onClick={onSelect} className="text-left min-w-0 flex items-center gap-3">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md shrink-0" style={tileStyle(a)}>
                <TriggerGlyph routine={a} size={13} />
            </span>
            {/* Narrow: the description sits under the title, so neither
                is cut to a stub. Wide: beside it, where the description
                gives way first and the title only truncates once it
                alone is wider than the column. */}
            <span className="flex-1 min-w-0 flex flex-col @[76rem]/overview:flex-row @[76rem]/overview:items-baseline @[76rem]/overview:gap-2">
                <span className="min-w-0 flex items-center gap-2 @[76rem]/overview:shrink-0 @[76rem]/overview:max-w-full">
                    <span className="text-[13px] font-medium truncate text-[var(--text-primary)]" title={TITLE(a)}>{TITLE(a)}</span>
                    {liveRunning && <span className={`h-1.5 w-1.5 rounded-full animate-pulse ${STATUS_TOKENS.running.solid} bg-current shrink-0`} aria-hidden="true" />}
                </span>
                <span className="min-w-0 @[76rem]/overview:flex-1 text-xs text-[var(--text-tertiary)] truncate" title={description || undefined}>
                    {description || stepsText}
                </span>
            </span>
        </button>
    );
}

function ListRow({ routine: a, props, liveRunning }) {
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
                <NameCell routine={a} liveRunning={liveRunning} onSelect={props?.onSelect} />
                <span className={`text-xs text-[var(--text-secondary)] truncate ${WITH_TRIGGER}`} title={triggerTextOf(a)}>{triggerTextOf(a)}</span>
                <LifecycleChip routine={a} />
                <span className="flex items-center gap-2 min-w-0">
                    <OutcomeChip routine={a} liveRunning={liveRunning} t={t} />
                    {a.lastRunAt && <span className="text-[11px] text-[var(--text-tertiary)] truncate">{rel(a.lastRunAt)}</span>}
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

// ── Cards ────────────────────────────────────────────────────────────

function CardsView({ rows, rowProps, activeRunIds }) {
    return (
        // As many columns as fit at 21rem, by the overview's own width: two on a
        // laptop, five in the centred column of an ultrawide. auto-fill keeps
        // empty tracks, so three routines stay card-sized instead of stretching.
        <div className={`${COLUMN} grid grid-cols-[repeat(auto-fill,minmax(min(21rem,100%),1fr))] gap-3 p-4`} data-testid="automations-overview-cards">
            {rows.map(a => <Card key={a.id} routine={a} props={rowProps?.(a)} liveRunning={!!activeRunIds?.has?.(a.id)} />)}
        </div>
    );
}

function Card({ routine: a, props, liveRunning, compact = false, hideLifecycle = false }) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const { onContextMenu, kebab, menu } = useRowMenu(props);
    const steps = stepCountOf(a);
    const failing = isFailing(a);
    return (
        <>
            <div
                role="button"
                tabIndex={0}
                data-testid="automations-overview-card"
                data-automation-id={a.id}
                onClick={props?.onSelect}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props?.onSelect?.(); } }}
                onContextMenu={onContextMenu}
                className={`group relative flex flex-col rounded-xl border text-left transition-all hover:shadow-md cursor-pointer ${compact ? 'p-3' : 'p-3.5'} ${
                    props?.selected ? 'ring-2 ring-[var(--accent-primary)]' : ''
                }`}
                style={{
                    borderColor: failing ? 'var(--error)' : 'var(--border-subtle)',
                    background: 'var(--bg-card)',
                    opacity: a.isActive || a.isDraft ? 1 : 0.75,
                }}
            >
                <div className="flex items-start gap-2.5 mb-2">
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg shrink-0" style={tileStyle(a)}>
                        <TriggerGlyph routine={a} size={16} />
                    </span>
                    <div className="flex-1 min-w-0 pt-0.5">
                        <div className="flex items-center gap-1.5">
                            <span className="text-sm font-semibold truncate text-[var(--text-primary)]">{TITLE(a)}</span>
                            {liveRunning && <span className={`h-1.5 w-1.5 rounded-full animate-pulse ${STATUS_TOKENS.running.solid} bg-current shrink-0`} aria-hidden="true" />}
                        </div>
                        <div className="text-xs mt-0.5 truncate text-[var(--text-tertiary)]" title={triggerTextOf(a)}>{triggerTextOf(a)}</div>
                    </div>
                    <span className="-mr-1 -mt-1">{kebab}</span>
                </div>
                {!compact && (a.description || '').trim() && (
                    <p className="text-xs m-0 mb-2.5 line-clamp-2 text-[var(--text-secondary)]">{a.description.trim()}</p>
                )}
                <div className="mt-auto flex items-center justify-between gap-2 flex-wrap">
                    <span className="flex items-center gap-2">
                        {!hideLifecycle && <LifecycleChip routine={a} />}
                        <OutcomeChip routine={a} liveRunning={liveRunning} t={t} />
                    </span>
                    <span className="text-[10.5px] text-[var(--text-tertiary)] truncate">
                        {a.nextRunAt && a.isActive
                            ? `Next ${formatNextRun(a.nextRunAt)}`
                            : a.lastRunAt
                                ? `Ran ${rel(a.lastRunAt)}`
                                : steps != null ? `${steps} step${steps === 1 ? '' : 's'}` : ''}
                    </span>
                </div>
            </div>
            {menu}
        </>
    );
}

// ── Board ────────────────────────────────────────────────────────────

function BoardView({ lanes, groupBy, rowProps, activeRunIds }) {
    // In a status board the lane already says Live / Paused / Draft; a chip
    // repeating it on every tile is noise.
    const hideLifecycle = groupBy === 'status';
    return (
        // Lanes share the width between 17.5rem and 24rem: three status lanes
        // fill a laptop, stay readable on an ultrawide, and a board with many
        // folder lanes scrolls sideways rather than squeezing them.
        <div className={`${COLUMN} h-full flex items-start gap-3 p-4 overflow-x-auto`} data-testid="automations-overview-board">
            {lanes.map(lane => (
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
                            ? <p className="text-[11px] text-[var(--text-tertiary)] px-1 py-3 m-0 text-center">Nothing here</p>
                            : lane.rows.map(a => <Card key={a.id} routine={a} props={rowProps?.(a)} liveRunning={!!activeRunIds?.has?.(a.id)} compact hideLifecycle={hideLifecycle} />)}
                    </div>
                </section>
            ))}
        </div>
    );
}
