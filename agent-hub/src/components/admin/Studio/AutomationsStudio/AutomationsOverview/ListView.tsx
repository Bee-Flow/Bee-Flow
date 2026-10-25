import { ArrowDown, ArrowUp } from 'lucide-react';
import { flowSummaryOf, triggerTextOf } from '../overviewModel';
import { OutcomeBit, StatusBadge, TriggerTile, titleOf, useRowMenu } from '../OverviewBits';
import useRelativeTime from '../../../../../hooks/useRelativeTime';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { formatNextRun } from '../../../../automation/taskFormatters';
import { STATUS_TOKENS } from '../../../../shared/statusTokens';
import type { SortHeadProps, ListViewProps, NameCellProps, ListRowProps } from '../AutomationsOverview.types';
import { COLUMN, LIST_GRID, WITH_TRIGGER, WITH_NEXT_RUN, WITH_UPDATED, COL_SORT, ASC_SORTS } from './AutomationsOverview.helpers';

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

export function ListView({ rows, rowProps, activeRunIds, sort, onSort }: ListViewProps) {
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
