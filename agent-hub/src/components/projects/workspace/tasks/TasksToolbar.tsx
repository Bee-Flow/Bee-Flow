// The one toolbar row of the Tasks tab: view switch, search, the Filter and
// Sort menus, the active filters as removable pills, and a slot on the right
// for what only the current view needs. Sort is simply absent outside the list
// and sits after Filter, so nothing to its left moves when the view changes.

import { ArrowDownUp, CalendarClock, CalendarRange, Flag, Kanban, List, ListTree, Search, SlidersHorizontal, UserX, X } from 'lucide-react';
import React, { useRef, useState } from 'react';
import { TASK_PRIORITIES, type TaskPriority } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import SegmentedControl from '../../../shared/SegmentedControl';
import type { useChatPeople } from '../chat/chatPeople';
import { Avatar, GhostButton } from '../workspaceUi';
import { activeFilterCount, NO_FILTERS, type TaskFilters, type TaskSort } from './taskFilters';
import { AnchoredMenu, CountBadge, MENU_PANEL_CLASS, MenuItem, MenuLabel, MenuSeparator, TOOLBAR_BUTTON_CLASS } from './tasksMenu';
import { priorityLabel } from './taskText';

export type TasksView = 'list' | 'board' | 'planning' | 'hierarchy';
type People = ReturnType<typeof useChatPeople>;
type T = ReturnType<typeof useTranslation>['t'];

/** Above this many labels the Filter menu offers a search box for them. */
const LABEL_SEARCH_FROM = 9;

const PRIORITY_INK: Record<TaskPriority, string> = {
    urgent: 'text-[var(--error-ink)]',
    high: 'text-[var(--warning-ink)]',
    normal: 'text-[var(--text-tertiary)]',
    low: 'text-[var(--text-tertiary)]',
};

function PriorityGlyph({ priority }: { priority: TaskPriority }) {
    return <Flag className={`w-3.5 h-3.5 ${PRIORITY_INK[priority]}`} aria-hidden="true" />;
}

function whoName(t: T, who: string, people: People): string {
    if (who === 'me') return t('project_tasks.who_me_short', 'Me');
    if (who === 'unassigned') return t('project_tasks.not_assigned', 'Not assigned');
    return people.nameOf(who) || t('project_chat.someone', 'A member');
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    const { t } = useTranslation();
    return (
        <label className="relative block w-44 sm:w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />
            <input type="search" value={value} onChange={e => onChange(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape' && value) { e.preventDefault(); onChange(''); } }}
                aria-label={t('project_tasks.search', 'Search tasks')} placeholder={t('project_tasks.search', 'Search tasks')}
                className="h-8 w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] pl-8 pr-2 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-primary)]" />
        </label>
    );
}

function FilterMenu({ filters, set, people, me, labels }: {
    filters: TaskFilters; set: (patch: Partial<TaskFilters>) => void; people: People; me: string | null; labels: string[];
}) {
    const { t } = useTranslation();
    const anchorRef = useRef<HTMLSpanElement>(null);
    const [open, setOpen] = useState(false);
    const [labelQuery, setLabelQuery] = useState('');
    const count = activeFilterCount(filters);
    const shownLabels = labels.length >= LABEL_SEARCH_FROM && labelQuery.trim()
        ? labels.filter(l => l.toLocaleLowerCase().includes(labelQuery.trim().toLocaleLowerCase()))
        : labels;
    // Picking toggles: choosing the option that is already on turns that filter off again.
    const pickWho = (who: string) => set({ who: filters.who === who ? 'all' : who });
    return (
        <span ref={anchorRef} className="inline-flex">
            <button type="button" className={TOOLBAR_BUTTON_CLASS} onClick={() => setOpen(v => !v)} aria-expanded={open} aria-haspopup="menu" data-testid="tasks-filter-button">
                <SlidersHorizontal className="w-4 h-4" aria-hidden="true" />{t('project_tasks.filter_button', 'Filter')}
                {count > 0 && <CountBadge count={count} />}
            </button>
            <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} role="menu" align="left" width={256} maxHeight={480}
                className={MENU_PANEL_CLASS} aria-label={t('project_tasks.filters', 'Filter tasks')}>
                <MenuLabel>{t('project_tasks.filter_assignee', 'Assignee')}</MenuLabel>
                {me && (
                    <MenuItem selected={filters.who === 'me'} onClick={() => pickWho('me')}
                        icon={<Avatar name={people.nameOf(me)} picture={people.avatarOf(me)} color={people.colorOf(me)} size="sm" className="!w-4 !h-4 !text-[8px] !ring-0" />}>
                        {t('project_tasks.who_me_short', 'Me')}
                    </MenuItem>
                )}
                <MenuItem selected={filters.who === 'unassigned'} onClick={() => pickWho('unassigned')} icon={<UserX className="w-3.5 h-3.5" />}>
                    {t('project_tasks.not_assigned', 'Not assigned')}
                </MenuItem>
                {people.people.filter(p => p.id !== me).map(p => (
                    <MenuItem key={p.id} selected={filters.who === p.id} onClick={() => pickWho(p.id)}
                        icon={<Avatar name={p.name} picture={people.avatarOf(p.id)} color={people.colorOf(p.id)} size="sm" className="!w-4 !h-4 !text-[8px] !ring-0" />}>
                        {p.name}
                    </MenuItem>
                ))}
                <MenuSeparator />
                <MenuLabel>{t('project_tasks.priority_label', 'Priority')}</MenuLabel>
                {TASK_PRIORITIES.map(p => (
                    <MenuItem key={p} selected={filters.priority === p} onClick={() => set({ priority: filters.priority === p ? 'all' : p })} icon={<PriorityGlyph priority={p} />}>
                        {priorityLabel(t, p)}
                    </MenuItem>
                ))}
                {labels.length > 0 && (
                    <>
                        <MenuSeparator />
                        <MenuLabel>{t('project_tasks.filter_label', 'Label')}</MenuLabel>
                        {labels.length >= LABEL_SEARCH_FROM && (
                            <div className="px-1 pb-1">
                                <input type="search" value={labelQuery} onChange={e => setLabelQuery(e.target.value)}
                                    aria-label={t('project_tasks.filter_labels_search', 'Find a label')} placeholder={t('project_tasks.filter_labels_search', 'Find a label')}
                                    className="h-7 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]" />
                            </div>
                        )}
                        {shownLabels.map(l => (
                            <MenuItem key={l} selected={filters.label === l} onClick={() => set({ label: filters.label === l ? '' : l })}
                                icon={<span className="w-2 h-2 rounded-full bg-[var(--text-tertiary)]" />}>
                                {l}
                            </MenuItem>
                        ))}
                    </>
                )}
                <MenuSeparator />
                <MenuItem selected={filters.overdueOnly} onClick={() => set({ overdueOnly: !filters.overdueOnly })} icon={<CalendarClock className="w-3.5 h-3.5" />}>
                    {t('project_tasks.filter_overdue_only', 'Overdue only')}
                </MenuItem>
            </AnchoredMenu>
        </span>
    );
}

function SortMenu({ sort, onSort }: { sort: TaskSort; onSort: (s: TaskSort) => void }) {
    const { t } = useTranslation();
    const anchorRef = useRef<HTMLSpanElement>(null);
    const [open, setOpen] = useState(false);
    const options: [TaskSort, string][] = [
        ['due', t('project_tasks.sort_due_short', 'Due date')],
        ['priority', t('project_tasks.priority_label', 'Priority')],
        ['newest', t('project_tasks.sort_newest_short', 'Newest')],
    ];
    const current = options.find(([value]) => value === sort)?.[1] || options[0][1];
    return (
        <span ref={anchorRef} className="inline-flex">
            <button type="button" className={TOOLBAR_BUTTON_CLASS} onClick={() => setOpen(v => !v)} aria-expanded={open} aria-haspopup="menu"
                title={t('project_tasks.sort', 'Sort by')} data-testid="tasks-sort-button">
                <ArrowDownUp className="w-4 h-4" aria-hidden="true" /><span className="sr-only">{t('project_tasks.sort', 'Sort by')}: </span>{current}
            </button>
            <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} role="menu" align="left" width={200}
                className={MENU_PANEL_CLASS} aria-label={t('project_tasks.sort', 'Sort by')}>
                {options.map(([value, label]) => (
                    <MenuItem key={value} selected={sort === value} onClick={() => { onSort(value); setOpen(false); }}>{label}</MenuItem>
                ))}
            </AnchoredMenu>
        </span>
    );
}

/** One removable pill per active filter, so it is always visible WHICH filter is on. */
function FilterPills({ filters, set, people, onClear }: { filters: TaskFilters; set: (patch: Partial<TaskFilters>) => void; people: People; onClear: () => void }) {
    const { t } = useTranslation();
    const pills: { key: string; text: string; clear: Partial<TaskFilters> }[] = [];
    if (filters.who !== 'all') pills.push({ key: 'who', text: `${t('project_tasks.filter_assignee', 'Assignee')}: ${whoName(t, filters.who, people)}`, clear: { who: 'all' } });
    if (filters.priority !== 'all') pills.push({ key: 'priority', text: `${t('project_tasks.priority_label', 'Priority')}: ${priorityLabel(t, filters.priority)}`, clear: { priority: 'all' } });
    if (filters.label) pills.push({ key: 'label', text: `${t('project_tasks.filter_label', 'Label')}: ${filters.label}`, clear: { label: '' } });
    if (filters.overdueOnly) pills.push({ key: 'overdue', text: t('project_tasks.overdue_only', 'Overdue'), clear: { overdueOnly: false } });
    if (!pills.length) return null;
    return (
        <>
            <ul className="contents list-none" aria-label={t('project_tasks.active_filters', 'Active filters')}>
                {pills.map(pill => (
                    <li key={pill.key} className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-full bg-[var(--bg-secondary)] text-[11.5px] text-[var(--text-secondary)] max-w-[16rem]" data-testid={`task-filter-pill-${pill.key}`}>
                        <span className="truncate">{pill.text}</span>
                        <button type="button" onClick={() => set(pill.clear)} aria-label={t('project_tasks.remove_filter', 'Remove filter {name}', { name: pill.text })}
                            title={t('project_tasks.remove_filter', 'Remove filter {name}', { name: pill.text })}
                            className="grid place-items-center w-4 h-4 flex-none rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]">
                            <X className="w-3 h-3" aria-hidden="true" />
                        </button>
                    </li>
                ))}
            </ul>
            <GhostButton onClick={onClear} aria-label={t('project_tasks.clear_filters', 'Clear filters')}>{t('project_tasks.clear', 'Clear')}</GhostButton>
        </>
    );
}

export default function TasksToolbar({ view, onView, showFilters, filters, onFilters, sort, onSort, people, me, labels, trailing }: {
    view: TasksView; onView: (v: TasksView) => void;
    /** False while the project has no tasks: there is nothing to search or filter yet. */
    showFilters: boolean;
    filters: TaskFilters; onFilters: (f: TaskFilters) => void;
    sort: TaskSort; onSort: (s: TaskSort) => void;
    people: People; me: string | null; labels: string[];
    /** View-scoped controls, pinned to the right end of the row. */
    trailing?: React.ReactNode;
}) {
    const { t } = useTranslation();
    const set = (patch: Partial<TaskFilters>) => onFilters({ ...filters, ...patch });
    // Labels collapse to icons on narrow screens; sr-only keeps the radio's name.
    const label = (text: string) => <span className="sr-only md:not-sr-only">{text}</span>;
    return (
        <div className="flex flex-wrap items-center gap-2 min-h-8" role="group" aria-label={t('project_tasks.toolbar', 'Task tools')} data-testid="tasks-toolbar">
            <SegmentedControl size="sm" value={view} onChange={onView} ariaLabel={t('project_tasks.view', 'View')}
                options={[
                    { value: 'list', label: label(t('project_tasks.view_list', 'List')), icon: <List className="w-3.5 h-3.5" aria-hidden="true" /> },
                    { value: 'board', label: label(t('project_tasks.view_board', 'Board')), icon: <Kanban className="w-3.5 h-3.5" aria-hidden="true" /> },
                    { value: 'planning', label: label(t('project_tasks.planning', 'Planning')), icon: <CalendarRange className="w-3.5 h-3.5" aria-hidden="true" /> },
                    { value: 'hierarchy', label: label(t('project_tasks.view_hierarchy', 'Hierarchy')), icon: <ListTree className="w-3.5 h-3.5" aria-hidden="true" /> },
                ]} />
            {showFilters && (
                <>
                    <SearchBox value={filters.search || ''} onChange={search => set({ search })} />
                    <FilterMenu filters={filters} set={set} people={people} me={me} labels={labels} />
                    {view === 'list' && <SortMenu sort={sort} onSort={onSort} />}
                    <FilterPills filters={filters} set={set} people={people} onClear={() => onFilters({ ...NO_FILTERS, search: filters.search })} />
                </>
            )}
            {trailing && <div className="ml-auto flex items-center gap-1">{trailing}</div>}
        </div>
    );
}
