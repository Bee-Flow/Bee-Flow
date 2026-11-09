import { useState, useEffect, useMemo } from 'react';
import DashSkeleton from '@/components/shared/dashboard/DashSkeleton';
import DataTable, { TableCell, TableRow, type TableColumn } from '@/components/shared/DataTable';
import { fmt, Card, MetricTile, SeriesDot, TablePanel } from './shared';
import { TYPE_ORDER, isLargeInput } from '@/utils/terminationsModel';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import type { TerminationRow, TerminationSummary, TimelineRow, AgentTerminations, TerminationsPageProps } from './TerminationsPage.types';
import { API, TYPE_META, typeLabel, fetchJson, rangeQuery } from './TerminationsPage.helpers';
import { StackedBarChart } from './StackedBarChart';
import { TerminationsTable } from './terminations/TerminationsTable';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';
// authFetch, not raw fetch. Both send credentials, but authFetch also sets the
// no-store handling that exists because the Nextcloud proxy path was replaying
// stale per-user API responses from the browser cache — and usage figures are
// exactly that kind of per-org, always-changing response. It is also the seam
// the public demo transport hooks, so a raw fetch here silently bypasses it.

interface TerminationsData {
    summary: TerminationSummary | null;
    timeline: TimelineRow[];
    rows: TerminationRow[];
    byAgent: AgentTerminations[];
}

/** The range's terminations: summary, timeline, the last 200 events and the per-agent counts; read again on `refreshKey`. */
function useTerminations({ range = '7d', customStart, customEnd, refreshKey }: TerminationsPageProps) {
    const [data, setData] = useState<TerminationsData>({ summary: null, timeline: [], rows: [], byAgent: [] });
    const [loading, setLoading] = useState(true);
    useAdjustOnChange([range, customStart, customEnd], () => setLoading(true));
    useEffect(() => {
        let cancelled = false;
        const q = rangeQuery(range, customStart, customEnd);
        const interval = (range === 'today' || (range === 'custom' && customStart && customEnd && (new Date(customEnd).getTime() - new Date(customStart).getTime()) <= 86400000))
            ? 'hour' : 'day';
        const intervalQ = (q ? '&' : '?') + `interval=${interval}`;
        Promise.all([
            fetchJson(API + '/summary' + q),
            fetchJson(API + '/timeline' + q + intervalQ),
            fetchJson(API + q + (q ? '&' : '?') + 'limit=200'),
            fetchJson(API + '/by-agent' + q),
        ]).then(([sum, tl, list, ag]) => {
            if (cancelled) return;
            setData({ summary: sum, timeline: tl?.rows || [], rows: list?.rows || [], byAgent: ag?.rows || [] });
            setLoading(false);
        });
        return () => { cancelled = true; };
    }, [range, customStart, customEnd, refreshKey]);
    return { ...data, loading };
}

function TerminationKpis({ summary, largeInputCount }: { summary: TerminationSummary | null; largeInputCount: number }) {
    const { t } = useTranslation();
    const total = summary?.total || 0;
    const by: Record<string, number> = summary?.by_type || {};
    const pct = (n: number | undefined) => (total ? t('admin_monitoring.term_pct_stops', '{pct}% of stops', { pct: Math.round(((n || 0) / total) * 100) }) : '');
    return (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
            <MetricTile label={t('admin_monitoring.col_total', 'Total')} value={fmt(total)} />
            <MetricTile label={typeLabel(t, 'max_tokens')} value={fmt(by.max_tokens || 0)} subtitle={pct(by.max_tokens)} />
            <MetricTile label={typeLabel(t, 'max_iterations')} value={fmt(by.max_iterations || 0)} subtitle={pct(by.max_iterations)} />
            <MetricTile label={t('admin_monitoring.col_errors', 'Errors')} value={fmt(by.error || 0)} subtitle={pct(by.error)} />
            <MetricTile label={typeLabel(t, 'aborted')} value={fmt(by.aborted || 0)} subtitle={t('admin_monitoring.term_client_disconnects', 'Client disconnects')} />
            <MetricTile label={t('admin_monitoring.term_large_input', 'Large input')} value={fmt(largeInputCount)} subtitle={t('admin_monitoring.term_likely_big', 'Likely caused by big prompt / attachment')} />
        </div>
    );
}

function agentColumns(t: TranslateFn): TableColumn[] {
    return [
        { id: 'agent', label: t('admin_monitoring.col_agent', 'Agent'), width: 'minmax(0,1fr)' },
        { id: 'total', label: t('admin_monitoring.col_total', 'Total'), width: '70px', align: 'right' },
        { id: 'max_tokens', label: t('admin_monitoring.col_max_tok', 'Max tok.'), width: '70px', align: 'right' },
        { id: 'max_iterations', label: t('admin_monitoring.col_max_iter', 'Max iter.'), width: '70px', align: 'right', foldBelow: 900 },
        { id: 'errors', label: t('admin_monitoring.col_errors', 'Errors'), width: '70px', align: 'right' },
        { id: 'aborted', label: t('admin_monitoring.col_aborted', 'Aborted'), width: '70px', align: 'right', foldBelow: 900 },
    ];
}

function AgentTerminationsTable({ byAgent }: { byAgent: AgentTerminations[] }) {
    const { t } = useTranslation();
    const title = t('admin_monitoring.term_by_agent', 'By agent');
    const columns = agentColumns(t);
    const num = 'tabular-nums text-[var(--text-secondary)]';
    return (
        <TablePanel title={title}>
            <DataTable<AgentTerminations & { id?: string }>
                ariaLabel={title}
                columns={columns}
                rows={byAgent}
                rowKey={(a, i) => a.agent_id || `unknown-${i}`}
                renderRow={(a) => (
                    <TableRow columns={columns}>
                        <TableCell column={columns[0]} className="truncate text-[var(--text-primary)]">{a.agent_name || a.agent_id || '—'}</TableCell>
                        <TableCell column={columns[1]} className="font-semibold tabular-nums text-[var(--text-primary)]">{a.total}</TableCell>
                        <TableCell column={columns[2]} className={num}>{a.max_tokens || 0}</TableCell>
                        <TableCell column={columns[3]} className={num}>{a.max_iterations || 0}</TableCell>
                        <TableCell column={columns[4]} className={a.errors ? 'tabular-nums font-semibold text-[var(--error-ink)]' : num}>{a.errors || 0}</TableCell>
                        <TableCell column={columns[5]} className={num}>{a.aborted || 0}</TableCell>
                    </TableRow>
                )}
            />
        </TablePanel>
    );
}

export function TerminationsPage(props: TerminationsPageProps) {
    const { t } = useTranslation();
    const { summary, timeline, rows, byAgent, loading } = useTerminations(props);
    const largeInputCount = useMemo(() => rows.filter(isLargeInput).length, [rows]);

    if (loading) return <DashSkeleton tiles={6} cards={2} />;

    return (
        <div className="flex flex-col gap-5">
            <TerminationKpis summary={summary} largeInputCount={largeInputCount} />

            <Card
                title={t('admin_monitoring.term_over_time', 'Terminations over time')}
                action={(
                    <ul className="m-0 flex list-none flex-wrap gap-3 p-0 text-[11px] text-[var(--text-secondary)]">
                        {TYPE_ORDER.map(ty => (
                            <li key={ty} className="inline-flex items-center gap-1"><SeriesDot color={TYPE_META[ty].color} square />{typeLabel(t, ty)}</li>
                        ))}
                    </ul>
                )}
            >
                <StackedBarChart data={timeline} />
            </Card>

            {byAgent.length > 0 && <AgentTerminationsTable byAgent={byAgent} />}

            <TerminationsTable rows={rows} />
        </div>
    );
}
