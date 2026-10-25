import { isFailing, triggerTextOf } from '../overviewModel';
import StepStrip from '../StepStrip';
import useRelativeTime from '../../../../../hooks/useRelativeTime';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { formatNextRun } from '../../../../automation/taskFormatters';
import { STATUS_TOKENS } from '../../../../shared/statusTokens';
import type { CardProps, BoardViewProps } from '../AutomationsOverview.types';
import { COLUMN, tileStyle } from './AutomationsOverview.helpers';
import { LifecycleChip, OutcomeChip, TriggerGlyph, useRowMenu, TITLE } from './ListView';

export function Card({ automation: a, props, liveRunning, compact = false, hideLifecycle = false }: CardProps) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const { onContextMenu, kebab, menu } = useRowMenu(props);
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
                        <TriggerGlyph automation={a} size={16} />
                    </span>
                    <div className="flex-1 min-w-0 pt-0.5">
                        <div className="flex items-center gap-1.5">
                            <span className="text-sm font-semibold truncate text-[var(--text-primary)]">{TITLE(a, t)}</span>
                            {liveRunning && <span className={`h-1.5 w-1.5 rounded-full animate-pulse ${STATUS_TOKENS.running.solid} bg-current shrink-0`} aria-hidden="true" />}
                        </div>
                        <div className="text-xs mt-0.5 truncate text-[var(--text-tertiary)]" title={triggerTextOf(a, t)}>{triggerTextOf(a, t)}</div>
                    </div>
                    <span className="-mr-1 -mt-1">{kebab}</span>
                </div>
                {!compact && (a.description || '').trim() && (
                    <p className="text-xs m-0 mb-2 line-clamp-2 text-[var(--text-secondary)]">{a.description?.trim()}</p>
                )}
                <div className="mb-2.5 min-w-0">
                    <StepStrip automation={a} small={compact} />
                </div>
                <div className="mt-auto flex items-center justify-between gap-2 flex-wrap">
                    <span className="flex items-center gap-2">
                        {!hideLifecycle && <LifecycleChip automation={a} />}
                        <OutcomeChip automation={a} liveRunning={liveRunning} t={t} />
                    </span>
                    <span className="text-[10.5px] text-[var(--text-tertiary)] truncate">
                        {a.nextRunAt && a.isActive
                            ? t('studio_misc.overview.next_at', 'Next {when}', { when: formatNextRun(a.nextRunAt) })
                            : a.lastRunAt
                                ? t('studio_misc.overview.ran_at', 'Ran {when}', { when: rel(a.lastRunAt) })
                                : ''}
                    </span>
                </div>
            </div>
            {menu}
        </>
    );
}

export function BoardView({ lanes, groupBy, rowProps, activeRunIds }: BoardViewProps) {
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
