import { RefreshCw } from 'lucide-react';
import type { ComponentType } from 'react';
import { ClearFilters, FilterMenu, JumpBox, JumpButton, SECONDARY_DEFAULTS, SecondarySelects, narrowedWords } from './RunLogFilterControls';
import type { AutomationOption, RunLogFilters, SecondaryFilterProps } from './RunLogFilterControls';
import { runIdFromText } from './runLanguage';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import FilterPillsJs from '../../../shared/FilterPills';

// A .jsx module whose `= undefined` defaults would type its props as undefined-only.
const FilterPills = FilterPillsJs as unknown as ComponentType<Record<string, unknown>>;

type Facets = { status?: Record<string, number>; triggerKind?: Record<string, number> } | null | undefined;

export interface ExecutionsFilterBarProps {
    filters: RunLogFilters;
    setFilters: (update: (prev: RunLogFilters) => RunLogFilters) => void;
    facets?: Facets;
    liveState?: 'live' | 'polling' | 'paused' | string | null;
    onRefresh?: () => void;
    onOpenRunById?: ((runId: string) => void) | null;
    showAutomationPicker?: boolean;
    automationOptions?: AutomationOption[];
    showModePicker?: boolean;
}

const RANGES = [
    { key: '24h', label: '24h', titleKey: 'runs.tab.period_24h', title: 'Last 24 hours' },
    { key: '7d', label: '7d', titleKey: 'runs.tab.period_7d', title: 'Last 7 days' },
    { key: '30d', label: '30d', titleKey: 'runs.tab.period_30d', title: 'Last 30 days' },
    { key: 'all', label: 'All', labelKey: 'studio_misc.runfilter.all', titleKey: 'runs.tab.period_all', title: 'All time' },
];

function statusCount(facets: Facets, key: string): number | undefined {
    const s = facets?.status;
    if (!s) return undefined;
    if (key === 'all') return Object.values(s).reduce((a, b) => a + b, 0);
    if (key === 'running') return (s.running || 0) + (s.queued || 0);
    if (key === 'awaiting') return (s.awaiting_approval || 0) + (s.awaiting_confirm || 0) + (s.awaiting_form || 0);
    return s[key] || 0;
}

/** The status pills, in the builder Runs tab's words; a tone only when there is something in it. */
function statusOptions(t: TranslateFn, facets: Facets) {
    const pill = (value: string, label: string, hotTone?: string) => {
        const count = statusCount(facets, value);
        return { value, label, count, tone: hotTone && (count || 0) > 0 ? hotTone : 'neutral' };
    };
    return [
        pill('all', t('runs.tab.filter_all', 'All')),
        pill('success', t('runs.log.filter_finished', 'Finished')),
        pill('error', t('runs.tab.filter_failed', 'Failed'), 'error'),
        pill('running', t('runs.tab.filter_running', 'Running')),
        pill('awaiting', t('runs.tab.filter_waiting', 'Waiting for someone'), 'warning'),
        pill('cancelled', t('runs.log.filter_stopped', 'Stopped')),
    ];
}

function liveDotOf(t: TranslateFn, liveState: ExecutionsFilterBarProps['liveState']) {
    if (liveState === 'live') return { cls: 'bg-emerald-500 animate-pulse', title: t('runs.log.live_on', 'Live: new runs appear on their own') };
    if (liveState === 'polling') return { cls: 'bg-amber-500', title: t('runs.log.live_polling', 'Checking every 5 seconds') };
    if (liveState === 'paused') return { cls: 'bg-[var(--text-tertiary)]', title: t('runs.log.live_paused', 'Not updating by itself: refresh to see new runs') };
    return null;
}

/**
 * The run log's one toolbar. Status and period stay in sight at every width;
 * the rest follows the list's OWN width (@container/runlog, set by
 * ExecutionsTable). From 92rem the trigger, live/test and automation selects
 * and the paste-a-link box stand in the row; below it (a laptop, up to about
 * 1536px wide) they fold into one "Filter" button and a link icon, so the row
 * stays one calm line instead of wrapping to two. Presentational; the parent
 * owns `filters` via useExecutions.
 */
export default function ExecutionsFilterBar({
    filters, setFilters, facets, liveState = null, onRefresh,
    onOpenRunById = null, showAutomationPicker = false, automationOptions = [],
    showModePicker = true,
}: ExecutionsFilterBarProps) {
    const { t } = useTranslation();
    const set = (patch: Partial<RunLogFilters>) => setFilters(prev => ({ ...prev, ...patch }));
    const secondary: SecondaryFilterProps = {
        filters, set, showModePicker, showAutomationPicker, automationOptions,
        triggerKinds: Object.keys(facets?.triggerKind || {}).sort(),
    };
    const narrowed = narrowedWords(t, secondary).length > 0;
    const liveDot = liveDotOf(t, liveState);
    const refresh = t('runs.log.refresh', 'Refresh');

    return (
        <div className="flex-shrink-0 border-b border-[var(--border-default)]" data-testid="executions-filter-bar">
            <div className="mx-auto max-w-[110rem] flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 min-h-[3rem]">
                <FilterPills
                    value={filters.status}
                    onChange={(status: string) => set({ status })}
                    options={statusOptions(t, facets)}
                    ariaLabel={t('runs.tab.filter_label', 'Show runs')}
                    testId="executions-status"
                />
                <div className="flex-1" />

                <div className="hidden @[92rem]/runlog:flex items-center gap-2">
                    {onOpenRunById && <JumpBox onJump={onOpenRunById} runIdFromText={runIdFromText} />}
                    <SecondarySelects p={secondary} />
                    {narrowed && <ClearFilters label={t('runs.log.clear', 'Clear')} onClear={() => set(SECONDARY_DEFAULTS)} />}
                </div>
                <div className="flex items-center gap-2 @[92rem]/runlog:hidden">
                    {onOpenRunById && <JumpButton onJump={onOpenRunById} runIdFromText={runIdFromText} />}
                    <FilterMenu p={secondary} />
                </div>

                <div className="inline-flex items-center rounded-lg border border-[var(--border-default)] overflow-hidden" role="group" aria-label={t('runs.tab.period_label', 'Period')}>
                    {RANGES.map(r => (
                        <button
                            key={r.key}
                            type="button"
                            onClick={() => set({ range: r.key })}
                            aria-pressed={filters.range === r.key}
                            title={t(r.titleKey, r.title)}
                            className={`px-2 py-1 text-xs font-medium transition ${
                                filters.range === r.key
                                    ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)]'
                                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'
                            }`}
                        >
                            {r.labelKey ? t(r.labelKey, r.label) : r.label}
                        </button>
                    ))}
                </div>

                <button
                    type="button"
                    onClick={onRefresh}
                    aria-label={refresh}
                    title={liveDot ? liveDot.title : refresh}
                    className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition"
                >
                    <RefreshCw size={13} aria-hidden />
                    {liveDot && <span className={`w-1.5 h-1.5 rounded-full ${liveDot.cls}`} />}
                </button>
            </div>

            {/* The server clamps facet counting to 720h: with "All" picked the
                pills' numbers are honest only with this line. */}
            {filters.range === 'all' && (
                <div className="mx-auto max-w-[110rem] px-4 pb-1.5 -mt-1 text-[10px] text-[var(--text-tertiary)]">
                    {t('runs.log.counts_30d', 'Counts cover the last 30 days.')}
                </div>
            )}
        </div>
    );
}
