import { Card } from '../OverviewCards';
import { useTranslation } from '../../../../../hooks/useTranslation';
import type { BoardViewProps } from '../AutomationsOverview.types';
import { COLUMN } from './AutomationsOverview.helpers';

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
