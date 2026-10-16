import { useState } from 'react';
import { chartSeriesVar } from './chartChrome';

interface BarListRow {
    label: string;
    n: number;
    pct?: number;
}

interface BarListProps {
    rows: BarListRow[];
    maxRows?: number;
    ariaLabel: string;
    moreLabel?: (n: number) => string;
    showAllLabel?: string;
    seriesIndex?: number;
    testId?: string;
}

/**
 * A horizontal bar per row with its count and share — the honest chart for a
 * single-choice question. Plain elements, no SVG: the label IS the text,
 * the count IS the number, and the bar is decoration a screen reader skips.
 */
export default function BarList({ rows, maxRows = 8, ariaLabel, moreLabel, showAllLabel = 'Show all', seriesIndex = 0, testId }: BarListProps) {
    const [expanded, setExpanded] = useState<boolean>(false);
    const list = Array.isArray(rows) ? rows : [];
    const max = list.reduce((m, r) => Math.max(m, Number(r.n) || 0), 0) || 1;
    const shown = expanded ? list : list.slice(0, maxRows);
    const hidden = list.length - shown.length;
    const fmt = new Intl.NumberFormat();
    return (
        <div data-testid={testId}>
            <ul role="list" aria-label={ariaLabel} className="space-y-1.5">
                {shown.map((r, i) => {
                    const n = Number(r.n) || 0;
                    const pct = Number.isFinite(Number(r.pct)) ? Number(r.pct) : null;
                    return (
                        <li key={`${r.label}-${i}`} className="grid items-center gap-3 text-xs" style={{ gridTemplateColumns: 'minmax(0, 11rem) 1fr auto' }}>
                            <span className="truncate text-[var(--text-primary)]" title={r.label}>{r.label}</span>
                            <span className="h-2.5 rounded-full overflow-hidden bg-[var(--bg-secondary)]" aria-hidden="true">
                                <span className="block h-full rounded-full" style={{ width: `${Math.max(2, (n / max) * 100)}%`, background: chartSeriesVar(seriesIndex) }} />
                            </span>
                            <span className="tabular-nums whitespace-nowrap text-[var(--text-secondary)]">
                                {fmt.format(n)}{pct !== null ? <span className="ml-1.5 text-[var(--text-tertiary)]">{`${pct}%`}</span> : null}
                            </span>
                        </li>
                    );
                })}
            </ul>
            {hidden > 0 && (
                <button type="button" onClick={() => setExpanded(true)} className="mt-2 text-xs underline-offset-2 hover:underline text-[var(--text-secondary)]">
                    {typeof moreLabel === 'function' ? moreLabel(hidden) : `${showAllLabel} (${hidden})`}
                </button>
            )}
        </div>
    );
}
