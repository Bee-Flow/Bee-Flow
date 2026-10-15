import { ArrowDown, ArrowUp } from 'lucide-react';
import { formatChartNumber, formatDelta } from './sheetChartFormat';
import { kpiFrom } from './sheetChartSeries';
import type { SheetChartConfig } from './sheetCharts';
import type { Computed } from './sheetEngine';

/** A KPI tile: one big value, a caption and (with compareRange) the change, green up / red down. */
export default function SheetChartKpi({ chart, computed, locale }: { chart: SheetChartConfig; computed: Computed; locale: string }) {
    const kpi = kpiFrom(chart, computed);
    const shown = kpi.value !== null && chart.format ? formatChartNumber(kpi.value, chart, locale) : kpi.display;
    const up = kpi.delta !== null && kpi.delta >= 0;
    return (
        <div className="flex h-full flex-col items-start justify-center gap-1 px-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-secondary)] truncate max-w-full">{chart.label || chart.title}</div>
            <div className="text-[28px] leading-none font-semibold text-[var(--text-primary)] truncate max-w-full" data-testid="kpi-value">{shown}</div>
            {kpi.delta !== null && (
                <div className={`flex items-center gap-0.5 text-[12px] font-medium ${up ? 'text-[var(--success)]' : 'text-[var(--error)]'}`} data-testid="kpi-delta">
                    {up ? <ArrowUp size={12} /> : <ArrowDown size={12} />}{formatDelta(kpi.delta, locale)}
                </div>
            )}
        </div>
    );
}
