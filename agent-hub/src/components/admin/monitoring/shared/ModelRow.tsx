import { Brain, Database } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { CHART_SERIES, chartSeriesVar } from '@/components/shared/charts/chartChrome';
import type { InOutBarProps, ModelRowProps } from '../shared.types';
import { fmt } from './SvgAreaChart';

// Costs are amounts in the organisation's currency; the product prices in euro.
const CURRENCY = '€';

export function fmtCost(n: number | null | undefined) {
    if (!n || n === 0) return `${CURRENCY}0.00`;
    if (n >= 1) return CURRENCY + n.toFixed(2);
    if (n >= 0.01) return CURRENCY + n.toFixed(3);
    if (n >= 0.001) return CURRENCY + n.toFixed(4);
    return CURRENCY + n.toFixed(6);
}

export function shortModel(m: string | null | undefined) {
    if (!m) return 'Unknown';
    return m.replace(/^(openai\/|anthropic\/|google\/|azure\/|mistral\/)/, '')
        .replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

/** One colour per model, in rank order: the theme's chart slots. */
export const MODEL_COLORS = CHART_SERIES;

/** Input (slot 1) against output (slot 4) as one thin bar; the widths are the data. */
export function InOutBar({ input, output, className = '' }: InOutBarProps) {
    const total = (input || 0) + (output || 0);
    const inputPct = total === 0 ? 0 : ((input || 0) / total) * 100;
    return (
        <div className={`flex h-1 w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)] ${className}`} aria-hidden="true">
            {total > 0 && (
                <>
                    <div className="h-full bg-[var(--chart-1)]" style={{ width: `${inputPct}%` }} />
                    <div className="h-full flex-1 bg-[var(--chart-4)]" />
                </>
            )}
        </div>
    );
}

/** A coloured dot that marks a series (model rank, termination type) next to its name. */
export function SeriesDot({ color, square = false }: { color: string; square?: boolean }) {
    return <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 ${square ? 'rounded-sm' : 'rounded-full'}`} style={{ background: color }} />;
}

export function ModelRow({ model: m, index, cost, onClick }: ModelRowProps) {
    const { t } = useTranslation();
    const cached = m.cached_tokens || 0;
    const reasoning = m.reasoning_tokens || 0;
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex w-full items-center gap-2.5 border-b border-[var(--border-default)] py-2.5 text-left last:border-b-0 hover:bg-[var(--bg-secondary)] focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
        >
            <SeriesDot color={chartSeriesVar(index)} />
            <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-semibold text-[var(--text-primary)]">{shortModel(m.model || 'unknown')}</div>
                <InOutBar input={m.prompt_tokens} output={m.completion_tokens} className="mt-1 max-w-[120px]" />
                {(cached > 0 || reasoning > 0) && (
                    <div className="mt-0.5 flex gap-2 text-[10px] text-[var(--text-tertiary)]">
                        {cached > 0 && <span className="inline-flex items-center gap-0.5" title={t('admin_monitoring.shared_cached_title', 'Cached input tokens')}><Database className="h-2.5 w-2.5" aria-hidden="true" /> {fmt(cached)}</span>}
                        {reasoning > 0 && <span className="inline-flex items-center gap-0.5" title={t('admin_monitoring.shared_reasoning_title', 'Reasoning / thinking tokens (billed at output rate)')}><Brain className="h-2.5 w-2.5" aria-hidden="true" /> {fmt(reasoning)}</span>}
                    </div>
                )}
            </div>
            <div className="shrink-0 text-right">
                <div className="text-xs font-semibold tabular-nums text-[var(--text-primary)]">{fmt(m.total_tokens)}</div>
                <div className="text-[10px] tabular-nums text-[var(--text-tertiary)]">
                    {t('admin_monitoring.shared_n_calls', '{n} calls', { n: m.calls })}{cost ? ` · ${fmtCost(cost)}` : ''}
                </div>
            </div>
        </button>
    );
}
