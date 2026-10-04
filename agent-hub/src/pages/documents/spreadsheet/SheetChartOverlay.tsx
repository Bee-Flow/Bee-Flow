import { memo, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
    Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import useTranslation from '../../../hooks/useTranslation';
import type { Computed } from './sheetEngine';
import { chartDataFrom, type SheetChartConfig, type ChartPoint } from './sheetCharts';

interface SheetChartOverlayProps {
    contentRef: React.RefObject<HTMLElement | null>;
    charts: SheetChartConfig[];
    computed: Computed;
    readOnly: boolean;
    onRemove?: (id: string) => void;
}

interface Layout { top: number; left: number; width: number; height: number }

function ChartCard({ chart, data, onRemove }: { chart: SheetChartConfig; data: ChartPoint[]; onRemove?: () => void }) {
    const { t } = useTranslation();
    const colors = ['var(--accent-primary)', 'var(--warning)', 'var(--success)', 'var(--info)', 'var(--error)', '#8b5cf6', '#ec4899'];
    const inner = useMemo(() => {
        if (chart.type === 'bar') {
            return (
                <BarChart data={data}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" />
                    <XAxis dataKey="label" tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} />
                    <YAxis tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} />
                    <Tooltip contentStyle={{ background: 'var(--bg-primary)', border: '1px solid var(--border-default)' }} />
                    <Bar dataKey="value" fill={colors[0]} />
                </BarChart>
            );
        }
        if (chart.type === 'line') {
            return (
                <LineChart data={data}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" />
                    <XAxis dataKey="label" tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} />
                    <YAxis tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} />
                    <Tooltip contentStyle={{ background: 'var(--bg-primary)', border: '1px solid var(--border-default)' }} />
                    <Line type="monotone" dataKey="value" stroke={colors[0]} dot={false} />
                </LineChart>
            );
        }
        return (
            <PieChart>
                <Tooltip contentStyle={{ background: 'var(--bg-primary)', border: '1px solid var(--border-default)' }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Pie data={data} dataKey="value" nameKey="label" outerRadius={Math.min(chart.width, chart.height) / 2 - 24}>
                    {data.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
                </Pie>
            </PieChart>
        );
    }, [chart, data, colors]);

    return (
        <div
            className="absolute bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg shadow-lg overflow-hidden flex flex-col"
            style={{ width: chart.width, height: chart.height }}
        >
            <div className="flex items-center justify-between px-2 h-7 border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
                <span className="text-[11px] font-medium text-[var(--text-primary)] truncate">{chart.title || t('spreadsheet.chart.untitled', 'Chart')}</span>
                {onRemove && (
                    <button
                        type="button" onClick={onRemove} aria-label={t('spreadsheet.chart.remove', 'Remove chart')}
                        className="text-[var(--text-tertiary)] hover:text-[var(--error)] text-[11px]"
                    >
                        ×
                    </button>
                )}
            </div>
            <div className="flex-1 min-h-0">
                <ResponsiveContainer width="100%" height="100%">
                    {inner}
                </ResponsiveContainer>
            </div>
        </div>
    );
}

function ChartItem({ chart, computed, layout, readOnly, onRemove }: {
    chart: SheetChartConfig; computed: Computed; layout: Layout; readOnly: boolean; onRemove?: (id: string) => void;
}) {
    const data = useMemo(() => chartDataFrom(chart, computed), [chart, computed]);
    if (!data.length) return null;
    return (
        <div className="absolute" style={{ top: layout.top, left: layout.left }}>
            <ChartCard chart={chart} data={data} onRemove={readOnly ? undefined : () => onRemove?.(chart.id)} />
        </div>
    );
}

export default memo(function SheetChartOverlay({ contentRef, charts, computed, readOnly, onRemove }: SheetChartOverlayProps) {
    const [layouts, setLayouts] = useState<Record<string, Layout | null>>({});

    useLayoutEffect(() => {
        const content = contentRef.current;
        if (!content) return;
        const next: Record<string, Layout | null> = {};
        for (const chart of charts) {
            const cell = content.querySelector(`[data-cell="${chart.anchor}"]`) as HTMLElement | null;
            if (cell) {
                next[chart.id] = { top: cell.offsetTop, left: cell.offsetLeft, width: chart.width, height: chart.height };
            } else {
                next[chart.id] = null;
            }
        }
        setLayouts(next);
    }, [charts, contentRef]);

    useEffect(() => {
        const content = contentRef.current;
        if (!content) return undefined;
        const ro = 'ResizeObserver' in window ? new ResizeObserver(() => {
            const next: Record<string, Layout | null> = {};
            for (const chart of charts) {
                const cell = content.querySelector(`[data-cell="${chart.anchor}"]`) as HTMLElement | null;
                next[chart.id] = cell ? { top: cell.offsetTop, left: cell.offsetLeft, width: chart.width, height: chart.height } : null;
            }
            setLayouts(next);
        }) : null;
        ro?.observe(content);
        return () => ro?.disconnect();
    }, [charts, contentRef]);

    return (
        <>
            {charts.map((chart) => {
                const layout = layouts[chart.id];
                if (!layout) return null;
                return <ChartItem key={chart.id} chart={chart} computed={computed} layout={layout} readOnly={readOnly} onRemove={onRemove} />;
            })}
        </>
    );
});
