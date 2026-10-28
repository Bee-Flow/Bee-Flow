import { memo, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import type { Computed } from './sheetEngine';
import SheetChartKpi from './SheetChartKpi';
import SheetChartPlot from './SheetChartPlot';
import { chartSeriesFrom, type ChartSeriesData } from './sheetChartSeries';
import { chartSize, type SheetChartConfig } from './sheetCharts';

interface SheetChartOverlayProps {
    contentRef: React.RefObject<HTMLElement | null>;
    charts: SheetChartConfig[];
    computed: Computed;
    readOnly: boolean;
    onRemove?: (id: string) => void;
}

interface Layout { top: number; left: number; width: number; height: number }

function ChartCard({ chart, data, computed, onRemove }: { chart: SheetChartConfig; data: ChartSeriesData; computed: Computed; onRemove?: () => void }) {
    const { t, resolvedLocale } = useTranslation();
    const kpi = chart.type === 'kpi';
    const remove = onRemove && (
        <button
            type="button" onClick={onRemove} aria-label={t('spreadsheet.chart.remove', 'Remove chart')}
            className="text-[var(--text-tertiary)] hover:text-[var(--error)] text-[11px]"
        >
            ×
        </button>
    );
    return (
        <div
            className="absolute bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl shadow-md overflow-hidden flex flex-col"
            style={chartSize(chart)}
            data-chart-type={chart.type}
        >
            {kpi ? (
                <>
                    <div className="absolute top-1 right-2 z-[1]">{remove}</div>
                    <SheetChartKpi chart={chart} computed={computed} locale={resolvedLocale} />
                </>
            ) : (
                <>
                    <div className="flex items-center justify-between px-3 h-8 shrink-0">
                        <span className="text-[12px] font-semibold text-[var(--text-primary)] truncate">{chart.title || t('spreadsheet.chart.untitled', 'Chart')}</span>
                        {remove}
                    </div>
                    <div className="flex-1 min-h-0 px-2 pb-2">
                        <SheetChartPlot chart={chart} data={data} locale={resolvedLocale} />
                    </div>
                </>
            )}
        </div>
    );
}

function ChartItem({ chart, computed, layout, readOnly, onRemove }: {
    chart: SheetChartConfig; computed: Computed; layout: Layout; readOnly: boolean; onRemove?: (id: string) => void;
}) {
    const data = useMemo(() => chartSeriesFrom(chart, computed), [chart, computed]);
    if (chart.type !== 'kpi' && !data.series.some((s) => s.values.some((v) => v !== null))) return null;
    return (
        <div className="absolute" style={{ top: layout.top, left: layout.left }}>
            <ChartCard chart={chart} data={data} computed={computed} onRemove={readOnly ? undefined : () => onRemove?.(chart.id)} />
        </div>
    );
}

/** Where each chart's anchor cell sits in the grid (null: the cell is not rendered). */
function measure(content: HTMLElement, charts: SheetChartConfig[]): Record<string, Layout | null> {
    const next: Record<string, Layout | null> = {};
    for (const chart of charts) {
        const cell = content.querySelector<HTMLElement>(`[data-cell="${chart.anchor}"]`);
        next[chart.id] = cell ? { top: cell.offsetTop, left: cell.offsetLeft, ...chartSize(chart) } : null;
    }
    return next;
}

export default memo(function SheetChartOverlay({ contentRef, charts, computed, readOnly, onRemove }: SheetChartOverlayProps) {
    const [layouts, setLayouts] = useState<Record<string, Layout | null>>({});

    useLayoutEffect(() => {
        const content = contentRef.current;
        if (content) setLayouts(measure(content, charts));
    }, [charts, contentRef]);

    useEffect(() => {
        const content = contentRef.current;
        if (!content || !('ResizeObserver' in window)) return undefined;
        const ro = new ResizeObserver(() => setLayouts(measure(content, charts)));
        ro.observe(content);
        return () => ro.disconnect();
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
