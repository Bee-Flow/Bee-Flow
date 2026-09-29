import React from 'react';
import useTranslation from '../../hooks/useTranslation';

/**
 * Pager — the table footer of artboard 1d ("Rij 1–12 van 93 · Vorige ·
 * Volgende"): an offset/limit pager for a DataTable, whether the host pages
 * on the client (SoA: 93 loaded rows, 12 a page) or the server (access log).
 *
 * `total` is the number of rows the host KNOWS about. When it does not know
 * (null/undefined — the read has not landed, or failed), the pager renders
 * nothing: "Rows 1–12 of 0" would be a count nobody made. An empty table
 * (total 0) renders nothing too — the table's own empty state says why.
 *
 * Previous/Next disable at the bounds rather than clamping silently; the
 * range text is one translatable sentence with three numbers, not three
 * fragments glued together.
 */
export default function Pager({ offset = 0, limit = 12, total = null, onOffset, className = '', testId = undefined }) {
    const { t } = useTranslation();
    const n = Number(total);
    if (total === null || total === undefined || !Number.isFinite(n) || n <= 0) return null;
    const size = Math.max(1, Number(limit) || 1);
    const at = Math.min(Math.max(0, Number(offset) || 0), Math.max(0, n - 1));
    const from = at + 1;
    const to = Math.min(at + size, n);
    const prevDisabled = at <= 0;
    const nextDisabled = at + size >= n;
    const btn = 'px-2 py-0.5 rounded-md border border-[var(--border-default)] transition-colors enabled:hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]';

    return (
        <div
            data-testid={testId}
            className={`flex items-center gap-2 px-3.5 py-2 text-[11px] text-[var(--text-tertiary)] ${className}`.trim()}
        >
            <span className="tabular-nums" data-testid={testId ? `${testId}-range` : undefined}>
                {t('common.pager_range', 'Rows {from}–{to} of {total}', { from, to, total: n })}
            </span>
            <span className="ml-auto inline-flex gap-1">
                <button
                    type="button"
                    disabled={prevDisabled}
                    onClick={() => onOffset?.(Math.max(0, at - size))}
                    data-testid={testId ? `${testId}-prev` : undefined}
                    className={`${btn} ${prevDisabled ? '' : 'text-[var(--text-primary)]'}`.trim()}
                >
                    {t('common.previous', 'Previous')}
                </button>
                <button
                    type="button"
                    disabled={nextDisabled}
                    onClick={() => onOffset?.(at + size)}
                    data-testid={testId ? `${testId}-next` : undefined}
                    className={`${btn} ${nextDisabled ? '' : 'text-[var(--text-primary)]'}`.trim()}
                >
                    {t('common.next', 'Next')}
                </button>
            </span>
        </div>
    );
}
