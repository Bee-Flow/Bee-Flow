import { chartSeriesVar } from './chartChrome';

/**
 * One bar split into a few segments (yes/no, done/open), with a legend that
 * carries every number — the bar itself is decoration.
 *
 * @param {{ segments: Array<{ label: string, n: number }>, ariaLabel: string, testId?: string }} props
 */
export default function SplitBar({ segments, ariaLabel, testId }) {
    const list = (Array.isArray(segments) ? segments : []).map((s, i) => ({ ...s, n: Number(s.n) || 0, color: chartSeriesVar(i) }));
    const total = list.reduce((sum, s) => sum + s.n, 0);
    const fmt = new Intl.NumberFormat();
    const pctOf = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);
    return (
        <div data-testid={testId}>
            <div className="flex h-3 w-full overflow-hidden rounded-full gap-0.5" style={{ background: 'var(--bg-secondary)' }} aria-hidden="true">
                {total > 0 && list.map((s) => (
                    <span key={s.label} className="block h-full" style={{ width: `${(s.n / total) * 100}%`, background: s.color }} />
                ))}
            </div>
            <ul role="list" aria-label={ariaLabel} className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {list.map((s) => (
                    <li key={s.label} className="inline-flex items-center gap-1.5">
                        <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
                        <span style={{ color: 'var(--text-primary)' }}>{s.label}</span>
                        <span className="tabular-nums" style={{ color: 'var(--text-secondary)' }}>{fmt.format(s.n)}</span>
                        <span className="tabular-nums" style={{ color: 'var(--text-tertiary)' }}>{`(${pctOf(s.n)}%)`}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
